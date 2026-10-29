import { db } from "@/lib/db";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import { Pool } from "pg";

/**
 * NEXUS OS — Supabase Postgres L0-mirror connector (R21-a).
 *
 * Auth model: the OWNER pastes the project's Postgres connection string (the
 * transaction-pooler URI, port 6543) into the panel vault — service "supabase",
 * label "db-url". This is PAT-free, EF-free direct Postgres over the pooler:
 * the durability layer that never depends on Edge Function runtime.
 *
 * P7 (absolute): the password never leaves this module except into the pg
 * client config. Statuses expose only the masked URI (password → ••••) and
 * scalar metadata. Error messages are scrubbed through maskDbUrl().
 *
 * Dashboard route (updated R21 — the 2025 dashboard redesign removed
 * "Settings → Database"): top bar → green **Connect** button → connection
 * dialog → "Transaction pooler" row (port 6543) → copy → replace
 * [YOUR-PASSWORD]. Password reset lives under Settings → Infrastructure.
 */

export const SUPABASE_DB_SERVICE = "supabase" as const;
export const SUPABASE_DB_LABEL = "db-url" as const;

export type DbUriClassification = {
  /** transaction pooler = serverless-safe (the directive's target shape) */
  mode: "transaction-pooler" | "session-pooler" | "direct" | "unknown";
  host: string;
  port: number | null;
  database: string | null;
  userMasked: string | null;
  /** project ref parsed from user "postgres.<ref>" (pooler convention) */
  projectRef: string | null;
  serverlessSafe: boolean;
};

export class DbUrlInvalidError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`connection string rejected: ${reason}`);
    this.name = "DbUrlInvalidError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Vault access (service "supabase", label "db-url")
// ---------------------------------------------------------------------------

export async function getDbUrl(): Promise<string | null> {
  const row = await db.credential.findUnique({
    where: { service_label: { service: SUPABASE_DB_SERVICE, label: SUPABASE_DB_LABEL } },
  });
  if (!row) return null;
  try {
    return decryptSecret(row.cipher);
  } catch {
    return null; // integrity failure — treat as absent; routes report honestly
  }
}

export async function storeDbUrl(url: string): Promise<void> {
  const { keyId, cipher } = encryptSecret(url);
  await db.credential.upsert({
    where: { service_label: { service: SUPABASE_DB_SERVICE, label: SUPABASE_DB_LABEL } },
    create: { service: SUPABASE_DB_SERVICE, label: SUPABASE_DB_LABEL, keyId, cipher },
    update: { keyId, cipher },
  });
}

export async function deleteDbUrl(): Promise<boolean> {
  const res = await db.credential.deleteMany({
    where: { service: SUPABASE_DB_SERVICE, label: SUPABASE_DB_LABEL },
  });
  closeCachedPool();
  return res.count > 0;
}

// ---------------------------------------------------------------------------
// URI parsing / classification / masking (P7 scrubbing happens here)
// ---------------------------------------------------------------------------

function decodeUriPart(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function classifyDbUri(rawUrl: string): DbUriClassification {
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    throw new DbUrlInvalidError("not a valid URI");
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new DbUrlInvalidError(`scheme must be postgresql:// (got ${u.protocol})`);
  }
  if (!u.hostname) throw new DbUrlInvalidError("missing host");
  if (!u.password) {
    throw new DbUrlInvalidError("missing password (copy the URI with [YOUR-PASSWORD] replaced)");
  }

  const host = u.hostname.toLowerCase();
  const port = u.port ? Number(u.port) : 5432;
  const user = decodeUriPart(u.username || "");
  const database = u.pathname && u.pathname.length > 1 ? u.pathname.slice(1) : null;

  let mode: DbUriClassification["mode"] = "unknown";
  let projectRef: string | null = null;
  if (host.endsWith(".pooler.supabase.com")) {
    mode = port === 6543 ? "transaction-pooler" : "session-pooler";
    if (user.startsWith("postgres.")) projectRef = user.slice("postgres.".length) || null;
  } else if (host.endsWith(".supabase.co") || host.endsWith(".supabase.com")) {
    mode = "direct";
    const dbHost = host.split(".")[0] ?? null;
    projectRef = dbHost && /^[a-z0-9]{20}$/.test(dbHost) ? dbHost : null;
  }

  return {
    mode,
    host,
    port,
    database,
    userMasked: user ? `${user.slice(0, 8)}${user.length > 8 ? "…" : ""}` : null,
    projectRef,
    serverlessSafe: mode === "transaction-pooler",
  };
}

/** P7 scrubber — any string that might carry the URI gets passwords → ••••••. */
export function maskDbUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl.trim());
    const user = u.username ? decodeUriPart(u.username) : "";
    return `${u.protocol}//${user}${u.password ? ":••••••" : ""}@${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname || "/"}`;
  } catch {
    return "(unparseable connection string)";
  }
}

/** Short vault-style preview for status rows. */
export function maskDbUrlPreview(rawUrl: string): string {
  try {
    const c = classifyDbUri(rawUrl);
    return `${c.mode} · ${c.host}:${c.port ?? "?"} · password ${maskSecret(c.projectRef ?? "•")}`;
  } catch {
    return "stored (unparseable — replace it)";
  }
}

// ---------------------------------------------------------------------------
// pg pool (cached; one client max — transaction-mode pooling friendly)
// ---------------------------------------------------------------------------

type PoolCache = { fingerprint: string; pool: Pool };
let poolCache: PoolCache | null = null;

function fingerprintOf(url: string): string {
  // stable, secret-free fingerprint: host + port + db + password length
  try {
    const u = new URL(url.trim());
    return `${u.hostname}:${u.port}:${u.pathname}:${(u.password || "").length}`;
  } catch {
    return `bad:${url.length}`;
  }
}

function buildPool(url: string): Pool {
  const c = classifyDbUri(url); // throws DbUrlInvalidError on garbage
  const u = new URL(url.trim());
  // Strip sslmode-ish params, then apply our own deterministic TLS policy:
  // Supabase pooler/direct endpoints terminate TLS; we do not pin CAs.
  const host = c.host;
  const pool = new Pool({
    host,
    port: c.port ?? 5432,
    user: decodeUriPart(u.username || ""),
    password: decodeUriPart(u.password || ""),
    database: c.database || "postgres",
    ssl: { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 8_000,
    statement_timeout: 15_000,
    query_timeout: 15_000,
    application_name: "nexus-panel-l0",
  });
  pool.on("error", () => {
    // idle client network drop — nothing to do; next query reconnects
  });
  return pool;
}

export function closeCachedPool(): void {
  if (poolCache) {
    try {
      poolCache.pool.end().catch(() => {});
    } catch {
      // ignore
    }
    poolCache = null;
  }
}

async function getPoolFor(url: string): Promise<Pool> {
  const fp = fingerprintOf(url);
  if (poolCache && poolCache.fingerprint === fp) return poolCache.pool;
  closeCachedPool();
  poolCache = { fingerprint: fp, pool: buildPool(url) };
  return poolCache.pool;
}

/** Scrub a pg error into a P7-safe message. */
function scrubPgError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // pg errors can embed host/params but never the password; belt-and-braces:
  return msg.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgresql://••••••@[scrubbed]");
}

// ---------------------------------------------------------------------------
// MEASURED operations — validate / migrate / push
// ---------------------------------------------------------------------------

export type DbValidateResult =
  | { ok: true; latencyMs: number; serverVersion: string; classification: DbUriClassification }
  | { ok: false; latencyMs: number; error: string; classification: DbUriClassification | null };

export async function dbValidate(rawUrl: string): Promise<DbValidateResult> {
  const started = Date.now();
  let classification: DbUriClassification | null = null;
  try {
    classification = classifyDbUri(rawUrl);
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: e instanceof Error ? e.message : "unparseable connection string",
      classification: null,
    };
  }
  try {
    const pool = await getPoolFor(rawUrl);
    const r = await pool.query<{ version: string }>("select version() as version");
    return {
      ok: true,
      latencyMs: Date.now() - started,
      serverVersion: String(r.rows[0]?.version ?? "unknown").split(" on ")[0] ?? "unknown",
      classification,
    };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: scrubPgError(e),
      classification,
    };
  }
}

/** Table existence check — used for the v30 migration verification. */
export async function dbListNexusTables(rawUrl: string): Promise<string[]> {
  const pool = await getPoolFor(rawUrl);
  const r = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = 'public'
       and (table_name like 'nexus%' or table_name in ('rsi_config','viewer_credits'))
     order by table_name`,
  );
  return r.rows.map((row) => row.table_name);
}

export type DbExecResult = { ok: true; latencyMs: number } | { ok: false; latencyMs: number; error: string };

export async function dbExec(rawUrl: string, sql: string): Promise<DbExecResult> {
  const started = Date.now();
  try {
    const pool = await getPoolFor(rawUrl);
    await pool.query(sql); // simple query protocol → multi-statement OK on pgbouncer
    return { ok: true, latencyMs: Date.now() - started };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, error: scrubPgError(e) };
  }
}

export type DbQueryResult<T> =
  | { ok: true; latencyMs: number; rows: T[] }
  | { ok: false; latencyMs: number; error: string };

/**
 * Parameterized read. pg sends `values` via the UNNAMED extended-protocol
 * statement, which pgbouncer transaction-mode pooling supports (named
 * prepared statements would not be — never pass a `name` here).
 */
export async function dbQuery<T>(
  rawUrl: string,
  sql: string,
  values: ReadonlyArray<unknown> = [],
): Promise<DbQueryResult<T>> {
  const started = Date.now();
  try {
    const pool = await getPoolFor(rawUrl);
    const res = await pool.query(sql, [...values]);
    return { ok: true, latencyMs: Date.now() - started, rows: (res.rows ?? []) as T[] };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, error: scrubPgError(e) };
  }
}
