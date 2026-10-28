// Ingest auth — T-207 / OQ2 (bound at G2 by silence: "public rate-limited
// ingest" default, rotate to a per-source token if abuse appears).
//
// OPTIONAL bearer token for the PUBLIC ingest path (POST /api/events):
// - No Credential row (service='ingest', name='ingest-token') in the vault →
//   checkIngestAuth is a no-op and POST /api/events behaves EXACTLY as the
//   pre-T-207 contract (public + rate-limited + deduped) — zero behavior
//   change, zero measurable perf cost (one in-memory map hit per request).
// - Token row EXISTS → requests without a valid `Authorization: Bearer <token>`
//   header are answered 401 in the §11 error shape BEFORE the rate limiter
//   (a rejected request must not consume rate slots); requests with the
//   bearer pass through the unchanged flow.
//
// Performance (NFR-01: ingest p95 must not regress):
// - The token is NEVER decrypted per request. On the first ingest after a
//   cache invalidation (and then at most once per TTL) the Credential row is
//   read once, decrypted once, and only sha256(token) is kept in memory.
// - Per request the check is: cache lookup + TTL compare + one sha256 of the
//   presented bearer + a constant-time (timingSafeEqual) digest compare.
// - Cache invalidation: TTL expiry, or the row's updatedAt changing (checked
//   at refresh time — the refresh re-reads and re-keys on the live updatedAt),
//   plus an immediate in-process invalidation hook that the lifecycle route
//   (POST/DELETE /api/ingest/token) calls so token enable/disable/rotate takes
//   effect without waiting out the TTL (single-writer topology, spec §12).
//
// Failure semantics (fail-closed, loud — NFR-05):
// - Row exists but vault decryption fails (tamper / key rotated out) → the
//   mode is 'broken': EVERY ingest request is answered 401 until the token is
//   re-stored, and one system.log error event is emitted per broken-cache
//   generation (never per request).
// - DB read fails at refresh time → stale cache is kept (stale-while-error);
//   with no cache at all the mode falls back to 'open' — identical to today's
//   behavior where a DB outage surfaces loudly on the insert path anyway.
//
// SERVER-ONLY module (node:crypto + vault material handling): never import
// from a client component — same by-import-graph boundary as crypto.ts/auth.ts.
// The token plaintext never leaves this module except toward the vault crypto;
// only its sha256 digest is retained, and it is never logged or returned.

import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { decrypt } from '@/lib/crypto'
import { insertEvent } from '@/lib/events'

export const INGEST_TOKEN_SERVICE = 'ingest'
export const INGEST_TOKEN_NAME = 'ingest-token'

/** GCM AAD binding — the §3-unique stable identity of the ingest token record. */
export const INGEST_TOKEN_PURPOSE = `credential:${INGEST_TOKEN_SERVICE}:${INGEST_TOKEN_NAME}`

const CACHE_TTL_MS = 45_000 // 30–60s band from the brief → 45s
const LASTUSED_FLUSH_MS = 60_000 // throttle lastUsedAt persistence (≤1 write/min)

// ---------------------------------------------------------------------------
// In-memory state (globalThis holder survives Next.js HMR module reloads —
// same pattern as ratelimit.ts / events.ts telemetry)
// ---------------------------------------------------------------------------

type IngestAuthMode = 'open' | 'armed' | 'broken'

interface IngestTokenCache {
  mode: IngestAuthMode
  /** sha256(token) — 32 bytes — the ONLY token-derived material held in memory. */
  hash: Buffer | null
  /** row.updatedAt (epoch ms) the digest was derived from — the cache key. */
  rowUpdatedAtMs: number
  /** Wall-clock ms when this entry was cached (TTL clock). */
  cachedAtMs: number
}

interface IngestAuthState {
  cache: IngestTokenCache | null
  /** In-memory lastUsedAt (epoch ms) — flushed to Credential.lastVerifiedAt throttled. */
  lastUsedAtMs: number | null
  lastFlushedAtMs: number
  /** Guards the one-shot system.log per broken-cache generation. */
  brokenLoggedGeneration: number
  brokenGeneration: number
}

const globalForIngestAuth = globalThis as unknown as {
  __nexusIngestAuthState: IngestAuthState | undefined
}

const state: IngestAuthState =
  globalForIngestAuth.__nexusIngestAuthState ?? {
    cache: null,
    lastUsedAtMs: null,
    lastFlushedAtMs: 0,
    brokenLoggedGeneration: -1,
    brokenGeneration: 0,
  }
globalForIngestAuth.__nexusIngestAuthState = state

const OPEN_CACHE: IngestTokenCache = {
  mode: 'open',
  hash: null,
  rowUpdatedAtMs: 0,
  cachedAtMs: 0,
}

/** Drop the in-memory cache — called by the token lifecycle route after any mutation. */
export function invalidateIngestTokenCache(): void {
  state.cache = null
}

/** In-memory last-used timestamp (epoch ms) or null — the token status route reads this. */
export function peekIngestTokenLastUsedAt(): number | null {
  return state.lastUsedAtMs
}

function digestOf(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

/**
 * One loud system.log per broken-cache generation (fire-and-forget — the auth
 * path must never block or throw on telemetry).
 */
function emitBrokenVaultLogOnce(): void {
  state.brokenGeneration += 1
  if (state.brokenLoggedGeneration === state.brokenGeneration) return
  state.brokenLoggedGeneration = state.brokenGeneration
  const message =
    'Ingest token credential failed vault decryption — ingest auth is failing closed (401) until the token is re-stored in the vault'
  void insertEvent({
    type: 'system.log',
    source: 'panel',
    payloadVersion: 1,
    payload: { level: 'error', component: 'ingest-auth', message },
    occurredAt: new Date().toISOString(),
    synthetic: false,
  }).catch(() => {
    // Telemetry must never break the auth path.
  })
}

async function readTokenRow(): Promise<{
  valueCipher: string
  updatedAt: Date
} | null> {
  return db.credential.findUnique({
    where: { service_name: { service: INGEST_TOKEN_SERVICE, name: INGEST_TOKEN_NAME } },
    select: { valueCipher: true, updatedAt: true },
  })
}

/**
 * Refresh the cache: read the row once, decrypt once, keep only the digest.
 * The cache is keyed by the row's updatedAt — a changed updatedAt (rotation)
 * re-keys it; an unchanged row just re-arms the TTL clock.
 */
async function refreshCache(): Promise<IngestTokenCache> {
  const row = await readTokenRow()
  if (!row) {
    return { mode: 'open', hash: null, rowUpdatedAtMs: 0, cachedAtMs: Date.now() }
  }
  try {
    const token = decrypt(row.valueCipher, INGEST_TOKEN_PURPOSE)
    if (token.length === 0) throw new Error('empty ingest token')
    return {
      mode: 'armed',
      hash: digestOf(token),
      rowUpdatedAtMs: row.updatedAt.getTime(),
      cachedAtMs: Date.now(),
    }
  } catch {
    // VaultIntegrityError (tamper/corruption) or VaultConfigError (key rotated
    // out) — indistinguishable from the auth path's point of view: fail closed.
    return { mode: 'broken', hash: null, rowUpdatedAtMs: row.updatedAt.getTime(), cachedAtMs: Date.now() }
  }
}

/** Current cache (fresh within TTL) or null when a refresh is needed. */
function freshCache(now: number): IngestTokenCache | null {
  const cached = state.cache
  if (cached && now - cached.cachedAtMs < CACHE_TTL_MS) return cached
  return null
}

/** Persist lastUsedAt to Credential.lastVerifiedAt, throttled; never blocks. */
function flushLastUsedThrottled(now: number): void {
  state.lastUsedAtMs = now
  if (now - state.lastFlushedAtMs < LASTUSED_FLUSH_MS) return
  state.lastFlushedAtMs = now
  void db.credential
    .updateMany({
      where: { service: INGEST_TOKEN_SERVICE, name: INGEST_TOKEN_NAME },
      data: { lastVerifiedAt: new Date(now) },
    })
    .catch(() => {
      // Best-effort audit timestamp — never break ingest on a flush failure.
    })
}

// ---------------------------------------------------------------------------
// Public API — the in-route guard for POST /api/events
// ---------------------------------------------------------------------------

/** Parse `Authorization: Bearer <token>` (RFC 7235: scheme is case-insensitive). */
function presentedBearer(req: Request): string | null {
  const header = req.headers.get('authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) return null
  const token = (match[1] ?? '').trim()
  return token.length > 0 ? token : null
}

function unauthorized(): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: 'unauthorized',
        message:
          'Ingest token required — send "Authorization: Bearer <token>" (Stream tab → Ingest security, docs/runbook.md)',
      },
    },
    { status: 401 },
  )
}

/**
 * In-route guard for the public ingest path. Returns null when the request may
 * proceed (open mode, or a valid bearer in token mode), else a §11 401.
 * Never throws: vault/DB faults degrade to fail-closed or stale-cache modes.
 */
export async function checkIngestAuth(req: Request): Promise<NextResponse | null> {
  const now = Date.now()
  let cache = freshCache(now)
  if (!cache) {
    try {
      cache = await refreshCache()
      state.cache = cache
    } catch {
      // DB read failed: stale-while-error, else fall back to open (today's
      // behavior — a DB outage surfaces loudly on the insert path regardless).
      cache = state.cache ?? OPEN_CACHE
    }
  }

  if (cache.mode === 'open') {
    // No token configured — the header is irrelevant (a userscript that kept
    // a stale header must not be punished once the mode reverts to open).
    return null
  }

  if (cache.mode === 'broken') {
    emitBrokenVaultLogOnce()
    return unauthorized()
  }

  // Token mode: armed. Compare digests in constant time.
  const presented = presentedBearer(req)
  if (presented === null) return unauthorized()
  const presentedDigest = digestOf(presented)
  const expected = cache.hash
  if (expected === null || expected.length !== presentedDigest.length) return unauthorized()
  if (!timingSafeEqual(presentedDigest, expected)) return unauthorized()

  // Authorized — record last-used (in-memory now, throttled vault flush).
  flushLastUsedThrottled(now)
  return null
}
