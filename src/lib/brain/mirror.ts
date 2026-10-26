import { createHmac } from "node:crypto";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import type { InteractionLog, SecurityLesson } from "@prisma/client";

/**
 * Supabase mirror (owner ask: "yes we can wire it now").
 *
 * The panel DB stays the source of truth (local-first, durable). This module
 * APPENDS every InteractionLog / SecurityLesson write to the Supabase project
 * (tables nexus_mirror_interactions / nexus_mirror_lessons, created 2026-10-25)
 * so the owner's prepared cloud store accumulates the same pipeline memory for
 * evaluation, training and off-site backup.
 *
 * Transport: Supabase PostgREST with the PUBLIC anon key + insert-only RLS
 * policies. The anon key is baked into the (public) widget, so anyone can
 * technically insert junk rows — every row the PANEL pushes therefore carries
 * `panel_sig` = HMAC-SHA256(ENCRYPTION_KEY, id): downstream consumers verify
 * the signature and ignore unsigned/spam rows. Panel-side only the hash key
 * lives server-side; the secret never leaves this process.
 *
 * MEASURED 2026-10-25 (E1): the push path WORKS from this sandbox —
 *   POST {url}/rest/v1/rpc/nexus_mirror_push {p_kind, p_rows:[]} → 200 "0"
 * and the cloud tables hold 65 interaction / 2 lesson rows pushed by earlier
 * panels. The OFFLINE/0-rows state the owner saw was a STATUS bug, not a
 * transport bug: the old status was an in-process counter reset by every dev
 * restart and written back over the lifetime totals, and nothing probed the
 * mirror until the first interaction push after boot. The status machinery
 * below keeps LIFETIME counters in Setting("brain.mirror.status") (delta
 * merged on flush) and liveness-probes eagerly (no-op RPC + a pooler SQL
 * `select 1` diagnostic) so the Pipeline/Connectors surfaces show reality,
 * not the boot default.
 *
 * The vault's transaction-pooler URI (service supabase, label
 * "supabase-db-url") is probed as a SECONDARY signal only: the measured push
 * transport is the anon-key RPC, and the pooler probe surfaces the real
 * network/SSL error when the direct Postgres route is blocked.
 *
 * Failure policy: best-effort. A mirror outage must NEVER slow or break the
 * live pipeline — pushes are fire-and-forget with a hard timeout, probes are
 * throttled and non-blocking, and the last status is persisted for the
 * Pipeline tab and the Supabase connector card (same source of truth).
 */

const SETTING_KEY = "brain.mirror.status";
const POOLER_LABEL = "supabase-db-url";
/** Min interval between automatic liveness probes (manual probes bypass). */
const PROBE_MIN_INTERVAL_MS = 120_000;
/** Force a persisted status flush at most this often (manual flushes bypass). */
const FLUSH_MIN_INTERVAL_MS = 30_000;

export type MirrorPoolerState = {
  present: boolean;
  ok: boolean | null; // null = never probed
  note: string;
};

export type MirrorStatus = {
  ok: boolean;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string;
  pushed: number; // LIFETIME rows pushed (survives restarts)
  failed: number; // LIFETIME failed pushes
  configured: boolean; // transport creds found (widget supabase_url + anon key)
  probedAt: string | null; // last liveness probe (push or explicit probe)
  probeNote: string; // human-readable result of the last probe/push
  pooler: MirrorPoolerState;
};

function defaultStatus(): MirrorStatus {
  return {
    ok: false,
    lastOkAt: null,
    lastErrorAt: null,
    lastError: "",
    pushed: 0,
    failed: 0,
    configured: false,
    probedAt: null,
    probeNote: "",
    pooler: { present: false, ok: null, note: "" },
  };
}

let statusCache: MirrorStatus = defaultStatus();
let statusFlushedAt = 0;
/** Snapshot of the in-process counters at the last flush (for delta merge). */
let flushedPushed = 0;
let flushedFailed = 0;
/** Supabase URL + anon key — read from the seeded widget's variables (cached). */
let credsCache: { url: string; anon: string } | null | undefined;
let credsCacheAt = 0;

async function getCreds(): Promise<{ url: string; anon: string } | null> {
  if (credsCache !== undefined && Date.now() - credsCacheAt < 60_000) return credsCache;
  try {
    const widget = await db.widget.findFirst({
      where: { seeded: true },
      select: { variables: true },
    });
    const vars = JSON.parse(widget?.variables ?? "[]") as Array<{ name: string; value: string }>;
    const url = vars.find((v) => v.name === "supabase_url")?.value?.trim() ?? "";
    const anon = vars.find((v) => v.name === "supabase_anon_key")?.value?.trim() ?? "";
    // The variable may hold the full functions/v1/... URL — normalize to project root.
    const root = url.replace(/\/functions\/v1\/.*$/i, "").replace(/\/+$/, "");
    credsCache = /^https:\/\/.+/.test(root) && anon.startsWith("eyJ") ? { url: root, anon } : null;
  } catch {
    credsCache = null;
  }
  credsCacheAt = Date.now();
  return credsCache;
}

function panelSig(id: string): string {
  const secret = process.env.ENCRYPTION_KEY ?? "";
  return createHmac("sha256", secret).update(id).digest("hex").slice(0, 32);
}

function safeParseStatus(raw: string): Partial<MirrorStatus> | null {
  try {
    return JSON.parse(raw) as Partial<MirrorStatus>;
  } catch {
    return null;
  }
}

/**
 * Merge the persisted Setting (lifetime truth from previous + current process)
 * with the in-process cache. Rules:
 *   - pushed/failed are LIFETIME: persisted totals + this boot's delta;
 *   - ok/lastError follow the cache once this process has probed or pushed
 *     (statusCache.probedAt set), otherwise the last persisted verdict;
 *   - history timestamps survive restarts (most recent known value wins).
 * flushStatus() persists exactly this merged view, so Setting and UI agree.
 */
function mergedStatus(prev: Partial<MirrorStatus> | null): MirrorStatus {
  const dPushed = Math.max(0, statusCache.pushed - flushedPushed);
  const dFailed = Math.max(0, statusCache.failed - flushedFailed);
  // "Probed" means a COMPLETED probe/push in this process — an in-flight probe
  // must not flip ok/probeNote/pooler to their boot defaults (E1 race fix).
  const probedThisProcess = Boolean(statusCache.probedAt) && !probeInFlight;
  return {
    ok: probedThisProcess ? statusCache.ok : (prev?.ok ?? statusCache.ok),
    pushed: (prev?.pushed ?? 0) + dPushed,
    failed: (prev?.failed ?? 0) + dFailed,
    lastOkAt: statusCache.lastOkAt ?? prev?.lastOkAt ?? null,
    lastErrorAt: statusCache.lastErrorAt ?? (probedThisProcess ? null : (prev?.lastErrorAt ?? null)),
    lastError: statusCache.lastError || (probedThisProcess ? "" : (prev?.lastError ?? "")),
    configured: statusCache.configured || Boolean(prev?.configured),
    probedAt: statusCache.probedAt ?? prev?.probedAt ?? null,
    probeNote: statusCache.probeNote || prev?.probeNote || "",
    pooler: probedThisProcess ? statusCache.pooler : (prev?.pooler ?? statusCache.pooler),
  };
}

async function flushStatus(force = false): Promise<void> {
  if (!force && Date.now() - statusFlushedAt < FLUSH_MIN_INTERVAL_MS) return;
  statusFlushedAt = Date.now();
  try {
    const existing = await db.setting.findUnique({ where: { key: SETTING_KEY } });
    const prev = existing?.value ? safeParseStatus(existing.value) : null;
    const next = mergedStatus(prev);
    const serialized = JSON.stringify(next);
    if (existing?.value !== serialized) {
      await db.setting.upsert({
        where: { key: SETTING_KEY },
        create: { key: SETTING_KEY, value: serialized },
        update: { value: serialized },
      });
    }
    // The persisted row now contains this boot's delta — mark it as flushed so
    // the next flush only adds NEW pushes/failures (an identical write or a
    // failure above must NOT advance the snapshot, or deltas would be lost).
    flushedPushed = statusCache.pushed;
    flushedFailed = statusCache.failed;
  } catch {
    /* status persistence is best-effort too; deltas stay pending */
  }
}

async function pushRows(kind: "interactions" | "lessons", rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return;
  const creds = await getCreds();
  if (!creds) {
    noteFailure("mirror not configured (widget supabase_url / supabase_anon_key missing)");
    return;
  }
  try {
    // SECURITY DEFINER RPC (nexus_mirror_push): idempotent insert/upsert without
    // needing a public SELECT policy (plain PostgREST ON CONFLICT is blocked by
    // RLS-on-conflict; the RPC keeps the mirror insert-only for anon).
    const res = await fetch(`${creds.url}/rest/v1/rpc/nexus_mirror_push`, {
      method: "POST",
      headers: {
        apikey: creds.anon,
        Authorization: `Bearer ${creds.anon}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_kind: kind, p_rows: rows }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const errText = (await res.text().catch(() => "")).slice(0, 180);
      noteFailure(`push HTTP ${res.status} ${errText}`);
      return;
    }
    statusCache.ok = true;
    statusCache.lastOkAt = new Date().toISOString();
    statusCache.probedAt = statusCache.lastOkAt;
    statusCache.pushed += rows.length;
    statusCache.probeNote = `push ok (RPC 200, ${rows.length} row${rows.length === 1 ? "" : "s"})`;
  } catch (e) {
    noteFailure(e instanceof Error ? e.message : String(e));
  }
  void flushStatus();
}

function noteFailure(msg: string) {
  statusCache.ok = false;
  statusCache.lastErrorAt = new Date().toISOString();
  statusCache.lastError = msg.slice(0, 300);
  statusCache.failed += 1;
  void flushStatus();
}

// ---------------------------------------------------------------------------
// Liveness probe — honest state without waiting for the next interaction push
// ---------------------------------------------------------------------------

/** Read the vault pooler URI (service supabase, label supabase-db-url) or null. */
async function getPoolerUri(): Promise<string | null> {
  try {
    const row = await db.credential.findUnique({
      where: { service_label: { service: "supabase", label: POOLER_LABEL } },
    });
    if (!row) return null;
    const plain = decryptSecret(row.cipher).trim();
    return /^postgres(ql)?:\/\//.test(plain) ? plain : null;
  } catch {
    return null;
  }
}

/**
 * SQL probe of the stored transaction-pooler URI (TLS, pgbouncer-safe:
 * prepare:false). Diagnostic only — the push transport stays the anon-key RPC.
 * Never throws; never echoes the URI.
 */
async function probePooler(uri: string): Promise<{ ok: boolean; note: string }> {
  const { default: postgres } = await import("postgres");
  let sql: ReturnType<typeof postgres> | null = null;
  try {
    sql = postgres(uri, {
      ssl: "require",
      prepare: false, // transaction pooler (port 6543): no prepared statements
      max: 1,
      connect_timeout: 6,
      idle_timeout: 2,
    });
    const rows = await sql`select 1 as ok`;
    return { ok: Array.isArray(rows) && rows.length === 1, note: "pooler SQL reachable (select 1 ok)" };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // Scrub anything URI-shaped or password-looking before surfacing.
    const note = raw
      .replace(/postgres(ql)?:\/\/\S+@\S+/gi, "postgres://<redacted>@…")
      .replace(/password=\S+/gi, "password=<scrubbed>")
      .slice(0, 160);
    return { ok: false, note: `pooler unreachable: ${note}` };
  } finally {
    try {
      await sql?.end({ timeout: 2 });
    } catch {
      /* close is best-effort */
    }
  }
}

let probeInFlight = false;
let lastProbeAt = 0;

/**
 * Probe the mirror NOW (used by the status routes' "Test now" action).
 * 1) no-op RPC push ({p_rows:[]}) — validates URL + anon key + RPC + DB in one
 *    measured-safe call (200 "0", writes nothing);
 * 2) pooler SQL diagnostic when the vault URI is stored.
 * Never throws.
 */
export async function probeMirror(): Promise<MirrorStatus> {
  probeInFlight = true;
  try {
    return await runProbe();
  } finally {
    probeInFlight = false;
  }
}

async function runProbe(): Promise<MirrorStatus> {
  const creds = await getCreds();
  statusCache.configured = Boolean(creds);
  statusCache.probedAt = new Date().toISOString();

  if (!creds) {
    statusCache.ok = false;
    statusCache.probeNote = "not configured: widget variables supabase_url / supabase_anon_key missing";
    statusCache.lastError = statusCache.probeNote;
    statusCache.lastErrorAt = statusCache.probedAt;
  } else {
    try {
      // MEASURED no-op: empty rows array returns 200 "0" without writing.
      const res = await fetch(`${creds.url}/rest/v1/rpc/nexus_mirror_push`, {
        method: "POST",
        headers: {
          apikey: creds.anon,
          Authorization: `Bearer ${creds.anon}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p_kind: "interactions", p_rows: [] }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        statusCache.ok = true;
        statusCache.lastOkAt = new Date().toISOString();
        statusCache.probeNote = `push path reachable (RPC ${res.status})`;
        // A successful probe supersedes any earlier error this process saw.
        statusCache.lastErrorAt = null;
        statusCache.lastError = "";
      } else {
        const t = (await res.text().catch(() => "")).slice(0, 140);
        statusCache.ok = false;
        statusCache.probeNote = `RPC probe failed: HTTP ${res.status} ${t}`;
        statusCache.lastErrorAt = statusCache.probedAt;
        statusCache.lastError = statusCache.probeNote;
      }
    } catch (e) {
      statusCache.ok = false;
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 160);
      statusCache.probeNote = `RPC probe unreachable: ${msg}`;
      statusCache.lastErrorAt = statusCache.probedAt;
      statusCache.lastError = statusCache.probeNote;
    }
  }

  // Secondary diagnostic: the vault transaction-pooler URI (TLS + select 1).
  const poolerUri = await getPoolerUri();
  statusCache.pooler = { present: Boolean(poolerUri), ok: null, note: poolerUri ? "" : "vault pooler URI (supabase-db-url) not stored" };
  if (poolerUri) {
    const p = await probePooler(poolerUri);
    statusCache.pooler = { present: true, ok: p.ok, note: p.note };
    // Pooler success is corroborating (same project DB); failure alone does not
    // flip ok — the RPC path is the transport of record.
    if (p.ok && statusCache.ok) statusCache.probeNote += " · " + p.note;
  }

  await flushStatus(true);
  lastProbeAt = Date.now();
  // Return the MERGED lifetime view (persisted totals + this boot's delta),
  // not the raw in-process cache — routes answer with lifetime truth.
  return readMirrorStatus();
}

/**
 * Throttled background probe for read paths (Pipeline/Connectors). Runs at
 * most once per PROBE_MIN_INTERVAL_MS; a very recent successful push/probe
 * already proves liveness and skips the round-trip. Never throws — call with
 * `void` from latency-sensitive routes; await it for explicit "Test now".
 */
export async function ensureMirrorProbe(): Promise<void> {
  if (probeInFlight) return;
  if (Date.now() - lastProbeAt < PROBE_MIN_INTERVAL_MS) return;
  // A very recent successful push already proves liveness — don't re-probe.
  if (statusCache.lastOkAt && Date.now() - Date.parse(statusCache.lastOkAt) < PROBE_MIN_INTERVAL_MS) return;
  probeInFlight = true;
  try {
    await probeMirror();
  } finally {
    probeInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Public surfaces
// ---------------------------------------------------------------------------

/** Mirror one InteractionLog row (fire-and-forget). */
export function mirrorInteraction(row: InteractionLog) {
  void pushRows("interactions", [
    {
      id: row.id,
      channel: row.channel,
      username: row.username,
      display_handle: row.displayHandle,
      command: row.command,
      message: row.message,
      response: row.response,
      model: row.model,
      model_id: row.modelId,
      provider: row.provider,
      route: row.route,
      status: row.status,
      latency_ms: row.latencyMs,
      prompt_tokens: row.promptTokens,
      completion_tokens: row.completionTokens,
      web_used: row.webUsed,
      flags: row.flags,
      injection_score: row.injectionScore,
      memory_used: row.memoryUsed,
      error: row.error,
      panel_sig: panelSig(row.id),
      created_at: row.createdAt.toISOString(),
    },
  ]);
}

/** Mirror one SecurityLesson row (fire-and-forget; upserts hits/lastSeenAt). */
export function mirrorLesson(row: SecurityLesson) {
  void pushRows("lessons", [
    {
      id: row.id,
      technique: row.technique,
      username: row.username,
      snippet: row.snippet,
      counter: row.counter,
      hits: row.hits,
      severity: row.severity,
      panel_sig: panelSig(row.id),
      last_seen_at: row.lastSeenAt.toISOString(),
      created_at: row.createdAt.toISOString(),
    },
  ]);
}

/** Current mirror status — persisted lifetime truth merged over in-process state. */
export async function readMirrorStatus(): Promise<MirrorStatus> {
  let persisted: Partial<MirrorStatus> | null = null;
  try {
    const s = await db.setting.findUnique({ where: { key: SETTING_KEY } });
    if (s?.value) persisted = safeParseStatus(s.value);
  } catch {}
  return mergedStatus(persisted);
}
