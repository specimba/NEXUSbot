import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "@/lib/db";
import {
  classifyDbUri,
  dbExec,
  dbListNexusTables,
  dbQuery,
  dbValidate,
  getDbUrl,
  maskDbUrl,
  type DbUriClassification,
} from "@/lib/connectors/supabase-db";

/**
 * NEXUS OS — off-site L0 mirror (R21-a).
 *
 * Sanitized panel-state snapshots pushed straight to the owner's Supabase
 * Postgres over the transaction pooler — PAT-free, EF-free. This is the
 * durability layer that never depends on Edge Function runtime (directive §8).
 *
 * Sanitization contract (P7): the payload carries COUNTS, NAMES and SHAS only —
 * never credential material, never prompt/response content, never raw events.
 * The mirror TABLE is created by us (nexus_l0_snapshots) and is deliberately
 * separate from the bot's v30 schema.
 */

const execFileAsync = promisify(execFile);

export const MIRROR_TABLE_SQL = `
create table if not exists public.nexus_l0_snapshots (
    id bigserial primary key,
    created_at timestamptz default now(),
    kind text not null default 'panel-state',
    commit_sha text,
    payload jsonb not null
);
create index if not exists idx_nexus_l0_snapshots_created
    on public.nexus_l0_snapshots (created_at desc);
`;

/** Lazy-push cadence: piggyback on status polls — no daemon (sandbox kills them). */
const MIRROR_PUSH_INTERVAL_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Sanitized snapshot builder
// ---------------------------------------------------------------------------

async function gitHeadSha(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: process.cwd() });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function buildSanitizedSnapshot(): Promise<Record<string, unknown>> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [eventTotal, event24h, credRows, ingestTokens, usageLlm24h, usageImage24h] = await Promise.all([
    db.event.count(),
    db.event.count({ where: { ts: { gte: since24h } } }),
    db.credential.findMany({ select: { service: true, label: true } }),
    db.ingestToken.count({ where: { revokedAt: null } }),
    db.usageEvent.count({ where: { kind: "llm", ts: { gte: since24h } } }),
    db.usageEvent.count({ where: { kind: "image", ts: { gte: since24h } } }),
  ]);

  return {
    kind: "panel-state",
    generatedAt: new Date().toISOString(),
    commitSha: await gitHeadSha(),
    panel: {
      eventsTotal: eventTotal,
      eventsLast24h: event24h,
      ingestTokensActive: ingestTokens,
      usageLlmLast24h: usageLlm24h,
      usageImageLast24h: usageImage24h,
    },
    vault: {
      credentialsCount: credRows.length,
      // names only — values/masks never leave the vault (P7)
      credentials: credRows.map((c) => `${c.service}/${c.label}`),
    },
    note: "sanitized snapshot: counts/names/shas only — no secrets, no prompt or response content",
  };
}

// ---------------------------------------------------------------------------
// Event log (local L0) — the mirror's own metadata
// ---------------------------------------------------------------------------

async function logMirrorEvent(type: string, payload: Record<string, unknown>, level = "info"): Promise<void> {
  try {
    await db.event.create({
      data: { source: "l0-mirror", type, level, actor: "panel", payload: JSON.stringify(payload) },
    });
  } catch {
    // best-effort only
  }
}

export type MirrorMeta = {
  lastPushAt: string | null;
  lastPushCommitSha: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  pushCount24h: number;
};

async function readMirrorMeta(): Promise<MirrorMeta> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [lastOk, lastFail, okCount] = await Promise.all([
    db.event.findFirst({ where: { source: "l0-mirror", type: "mirror.push" }, orderBy: { ts: "desc" } }),
    db.event.findFirst({
      where: { source: "l0-mirror", type: "mirror.push_failed" },
      orderBy: { ts: "desc" },
    }),
    db.event.count({ where: { source: "l0-mirror", type: "mirror.push", ts: { gte: since24h } } }),
  ]);
  const parse = (row: { payload: string } | null): Record<string, unknown> => {
    if (!row) return {};
    try {
      return JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const okP = parse(lastOk);
  const failP = parse(lastFail);
  return {
    lastPushAt: lastOk ? lastOk.ts.toISOString() : null,
    lastPushCommitSha: typeof okP.commitSha === "string" ? okP.commitSha : null,
    lastError: typeof failP.error === "string" ? failP.error : null,
    lastErrorAt: lastFail ? lastFail.ts.toISOString() : null,
    pushCount24h: okCount,
  };
}

// ---------------------------------------------------------------------------
// Push / migrate / row count / status
// ---------------------------------------------------------------------------

export type MirrorPushResult =
  | { ok: true; latencyMs: number; totalRows: number; commitSha: string | null }
  | { ok: false; latencyMs: number; error: string; phase: "no-url" | "ensure-table" | "insert" | "count" };

export async function pushMirror(urlOverride?: string): Promise<MirrorPushResult> {
  const started = Date.now();
  const url = urlOverride ?? (await getDbUrl());
  if (!url) {
    return { ok: false, latencyMs: Date.now() - started, error: "no connection string stored", phase: "no-url" };
  }

  const ensure = await dbExec(url, MIRROR_TABLE_SQL);
  if (!ensure.ok) {
    const error = ensure.error;
    await logMirrorEvent("mirror.push_failed", { error, stage: "ensure-table" }, "error");
    return { ok: false, latencyMs: Date.now() - started, error, phase: "ensure-table" };
  }

  const payload = await buildSanitizedSnapshot();
  const commitSha = typeof payload.commitSha === "string" ? payload.commitSha : null;
  const ins = await dbQuery<{ id: number }>(
    url,
    "insert into public.nexus_l0_snapshots (kind, commit_sha, payload) values ('panel-state', $1, $2::jsonb) returning id",
    [commitSha, JSON.stringify(payload)],
  );
  if (!ins.ok) {
    await logMirrorEvent("mirror.push_failed", { error: ins.error, commitSha }, "error");
    return { ok: false, latencyMs: Date.now() - started, error: ins.error, phase: "insert" };
  }

  const cnt = await dbQuery<{ n: number }>(url, "select count(*)::int as n from public.nexus_l0_snapshots");
  if (!cnt.ok) {
    await logMirrorEvent("mirror.push_failed", { error: cnt.error, commitSha, stage: "count" }, "error");
    return { ok: false, latencyMs: Date.now() - started, error: cnt.error, phase: "count" };
  }

  const totalRows = cnt.rows[0]?.n ?? null;
  await logMirrorEvent("mirror.push", { commitSha, totalRows });
  return { ok: true, latencyMs: Date.now() - started, totalRows, commitSha };
}

async function mirrorRowCount(url: string): Promise<number | null> {
  const r = await dbQuery<{ n: number }>(url, "select count(*)::int as n from public.nexus_l0_snapshots");
  return r.ok ? (r.rows[0]?.n ?? null) : null;
}

export type MirrorStatusPayload = {
  ok: true;
  configured: boolean;
  masked: string | null;
  classification: DbUriClassification | null;
  serverlessSafe: boolean;
  validate: { ok: boolean; latencyMs: number; serverVersion?: string; error?: string; at: string } | null;
  migration: { ok: boolean; tables: string[]; error?: string; at: string } | null;
  mirror: MirrorMeta & { totalRows: number | null };
  lazyPush: { triggered: boolean; result?: MirrorPushResult };
};

/**
 * Status for the panel + the R21-b beta checklist. One pooler visit:
 * SELECT 1 (validate) → table inventory → row count → lazy 6h push.
 */
export async function l0MirrorStatus(): Promise<MirrorStatusPayload> {
  const url = await getDbUrl();
  const meta = await readMirrorMeta();
  const base = {
    ok: true as const,
    configured: url !== null,
    masked: url ? maskDbUrl(url) : null,
    classification: null as DbUriClassification | null,
    serverlessSafe: false,
    validate: null,
    migration: null,
    mirror: { ...meta, totalRows: null as number | null },
    lazyPush: { triggered: false },
  };
  if (!url) return base;

  let classification: DbUriClassification | null = null;
  try {
    classification = classifyDbUri(url);
  } catch {
    classification = null;
  }
  const out: MirrorStatusPayload = {
    ...base,
    classification,
    serverlessSafe: classification?.serverlessSafe ?? false,
  };

  const v = await dbValidate(url);
  out.validate = {
    ok: v.ok,
    latencyMs: v.latencyMs,
    serverVersion: v.ok ? v.serverVersion : undefined,
    error: v.ok ? undefined : v.error,
    at: new Date().toISOString(),
  };

  if (v.ok) {
    try {
      const tables = await dbListNexusTables(url);
      out.migration = { ok: tables.length > 0, tables, at: new Date().toISOString() };
      out.mirror.totalRows = await mirrorRowCount(url);
    } catch (e) {
      out.migration = {
        ok: false,
        tables: [],
        error: e instanceof Error ? e.message : "table inventory failed",
        at: new Date().toISOString(),
      };
    }

    const lastPushAge = out.mirror.lastPushAt
      ? Date.now() - new Date(out.mirror.lastPushAt).getTime()
      : Infinity;
    if (lastPushAge > MIRROR_PUSH_INTERVAL_MS) {
      const res = await pushMirror(url);
      out.lazyPush = { triggered: true, result: res };
      if (res.ok) {
        out.mirror.lastPushAt = new Date().toISOString();
        out.mirror.lastPushCommitSha = res.commitSha;
        out.mirror.lastError = null;
        out.mirror.totalRows = res.totalRows;
      } else {
        out.mirror.lastError = res.error;
        out.mirror.lastErrorAt = new Date().toISOString();
      }
    }
  }

  return out;
}

/** Apply the bot's v30 schema migration (idempotent SQL, tracked in-repo). */
export async function applyV30Migration(
  urlOverride?: string,
): Promise<{ ok: boolean; latencyMs: number; tables: string[]; error?: string }> {
  const url = urlOverride ?? (await getDbUrl());
  if (!url) return { ok: false, latencyMs: 0, tables: [], error: "no connection string stored" };
  const sqlPath = path.join(process.cwd(), "supabase", "migrations", "nexus_v30_supabase_migration.sql");
  let sql: string;
  try {
    sql = await fs.readFile(sqlPath, "utf8");
  } catch {
    return { ok: false, latencyMs: 0, tables: [], error: `migration file missing: ${sqlPath}` };
  }
  const res = await dbExec(url, sql);
  if (!res.ok) {
    await logMirrorEvent("mirror.migrate", { ok: false, error: res.error }, "error");
    return { ok: false, latencyMs: res.latencyMs, tables: [], error: res.error };
  }
  const tables = await dbListNexusTables(url);
  await logMirrorEvent("mirror.migrate", { ok: true, tables });
  return { ok: true, latencyMs: res.latencyMs, tables };
}
