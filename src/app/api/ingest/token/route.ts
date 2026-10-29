// /api/ingest/token — OPTIONAL ingest bearer-token lifecycle (T-207 / OQ2).
//
// The public ingest path (POST /api/events) is open + rate-limited by default
// (OQ2 bound at G2). When the owner wants a per-source token, the userscript
// adds `Authorization: Bearer <token>`; enforcement lives in
// src/lib/ingest-auth.ts. The token material lives ONLY in the credential
// vault (Credential service='ingest', name='ingest-token', AES-256-GCM with
// AAD bound to the record identity, FR-11/ADR-002).
//
// GET    — session-gated status: {enabled, createdAt?, lastUsedAt?} — metadata
//          only, NEVER the token (or any derivative of it).
// POST   — session-gated create/rotate: generates 24 random bytes
//          (crypto.randomBytes(24).base64url), vault-seals it, records a
//          ConnectorRun audit row, invalidates the ingest-auth cache, and
//          returns the plaintext token EXACTLY ONCE (creation reveal, like a
//          GitHub PAT — after this response it is never retrievable again).
// DELETE — session-gated disable: removes the credential → ingest reverts to
//          the open (rate-limited) mode; records ConnectorRun
//          'ingest_token_disabled' only when a row was actually removed.
//
// Session gating is in-route per the §11 authz matrix (FR-29) — never
// middleware (session-version check needs Prisma). §11 single error shape
// everywhere. Audit rows are metadata-only (no token material, FR-11/P7).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { db, ensureDbReady, withWriteRetry } from '@/lib/db'
import { requireSession } from '@/lib/auth'
import { encrypt, envelopeKeyId, VaultConfigError } from '@/lib/crypto'
import {
  INGEST_TOKEN_NAME,
  INGEST_TOKEN_PURPOSE,
  INGEST_TOKEN_SERVICE,
  invalidateIngestTokenCache,
  peekIngestTokenLastUsedAt,
} from '@/lib/ingest-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Response contracts (zod — doubles as the pinned shape documentation).
const statusResponseSchema = z.object({
  enabled: z.boolean(),
  createdAt: z.string().datetime().optional(),
  lastUsedAt: z.string().datetime().optional(),
})
const createdResponseSchema = z.object({
  token: z.string().min(1),
  createdAt: z.string().datetime(),
  rotated: z.boolean(),
})
const disabledResponseSchema = z.object({
  enabled: z.literal(false),
  deleted: z.boolean(),
})

function errorResponse(
  status: number,
  code: string,
  message: string,
): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status })
}

/** The in-memory last-used timestamp wins when fresher than the flushed one. */
function effectiveLastUsedAt(row: { lastVerifiedAt: Date | null }): string | undefined {
  const flushedMs = row.lastVerifiedAt ? row.lastVerifiedAt.getTime() : 0
  const memoryMs = peekIngestTokenLastUsedAt() ?? 0
  const bestMs = Math.max(flushedMs, memoryMs)
  return bestMs > 0 ? new Date(bestMs).toISOString() : undefined
}

// ---------------------------------------------------------------------------
// GET — status (metadata only; NEVER the token)
// ---------------------------------------------------------------------------

export async function GET(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied
  await ensureDbReady()

  try {
    const row = await db.credential.findUnique({
      where: { service_name: { service: INGEST_TOKEN_SERVICE, name: INGEST_TOKEN_NAME } },
      select: { createdAt: true, lastVerifiedAt: true, status: true },
    })
    const body = statusResponseSchema.parse({
      enabled: row !== null && row.status !== 'revoked',
      ...(row ? { createdAt: row.createdAt.toISOString() } : {}),
      ...(row ? { lastUsedAt: effectiveLastUsedAt(row) } : {}),
    })
    return NextResponse.json(body)
  } catch {
    return errorResponse(500, 'server_error', 'Ingest token status failed')
  }
}

// ---------------------------------------------------------------------------
// POST — create / rotate (creation reveal: plaintext returned exactly once)
// ---------------------------------------------------------------------------

export async function POST(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied
  await ensureDbReady()

  const existing = await db.credential.findUnique({
    where: { service_name: { service: INGEST_TOKEN_SERVICE, name: INGEST_TOKEN_NAME } },
    select: { id: true },
  })

  const token = randomBytes(24).toString('base64url') // 32 chars, 192 bits
  try {
    const envelope = encrypt(token, INGEST_TOKEN_PURPOSE)
    const keyId = envelopeKeyId(envelope)
    await withWriteRetry(() =>
      db.credential.upsert({
        where: { service_name: { service: INGEST_TOKEN_SERVICE, name: INGEST_TOKEN_NAME } },
        create: {
          service: INGEST_TOKEN_SERVICE,
          name: INGEST_TOKEN_NAME,
          scopes: ['ingest:post'],
          valueCipher: envelope,
          keyId,
          status: 'active',
        },
        update: {
          valueCipher: envelope,
          keyId,
          status: 'active', // rotation clears any invalid/revoked state
        },
      }),
    )
  } catch (err) {
    if (err instanceof VaultConfigError) {
      return errorResponse(500, 'server_config', 'ENCRYPTION_KEY is not configured — vault unavailable')
    }
    return errorResponse(500, 'server_error', 'Ingest token generation failed')
  }

  // Audit metadata only — no token material (FR-11, P7).
  await db.connectorRun
    .create({
      data: {
        connector: INGEST_TOKEN_SERVICE,
        operation: 'ingest_token_enabled',
        status: 'ok',
        summary: existing
          ? 'Ingest bearer token rotated (previous token invalidated)'
          : 'Ingest bearer token enabled',
      },
    })
    .catch(() => {
      // Audit is metadata-only; a failed audit write must not 500 a working mutation.
    })

  // The bearer check must see the new token on the very next ingest.
  invalidateIngestTokenCache()

  const body = createdResponseSchema.parse({
    token,
    createdAt: new Date().toISOString(),
    rotated: existing !== null,
  })
  // Creation reveal — this response is the ONLY time the plaintext is sent.
  return NextResponse.json(body, { status: existing ? 200 : 201 })
}

// ---------------------------------------------------------------------------
// DELETE — disable (reverts to open ingest)
// ---------------------------------------------------------------------------

export async function DELETE(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied
  await ensureDbReady()

  const removed = await db.credential
    .delete({
      where: { service_name: { service: INGEST_TOKEN_SERVICE, name: INGEST_TOKEN_NAME } },
    })
    .catch(() => null) // P2025 (nothing to delete) → honest idempotent no-op

  if (removed !== null) {
    await db.connectorRun
      .create({
        data: {
          connector: INGEST_TOKEN_SERVICE,
          operation: 'ingest_token_disabled',
          status: 'ok',
          summary: 'Ingest bearer token removed — ingest reverted to open (rate-limited) mode',
        },
      })
      .catch(() => {})
  }

  invalidateIngestTokenCache()

  const body = disabledResponseSchema.parse({ enabled: false, deleted: removed !== null })
  return NextResponse.json(body)
}
