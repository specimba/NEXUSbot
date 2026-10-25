import { createHmac } from "node:crypto";
import { db } from "@/lib/db";
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
 * Failure policy: best-effort. A mirror outage must NEVER slow or break the
 * live pipeline — calls are fire-and-forget with a hard timeout, and the last
 * status is throttled into Setting("brain.mirror.status") for the Pipeline tab.
 */

const SETTING_KEY = "brain.mirror.status";

type MirrorStatus = {
  ok: boolean;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string;
  pushed: number;
  failed: number;
};

let statusCache: MirrorStatus = {
  ok: false,
  lastOkAt: null,
  lastErrorAt: null,
  lastError: "",
  pushed: 0,
  failed: 0,
};
let statusFlushedAt = 0;

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

async function pushRows(kind: "interactions" | "lessons", rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return;
  const creds = await getCreds();
  if (!creds) {
    noteFailure("mirror not configured (supabase_url / supabase_anon_key missing)");
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
      noteFailure(`HTTP ${res.status} ${errText}`);
      return;
    }
    statusCache.ok = true;
    statusCache.lastOkAt = new Date().toISOString();
    statusCache.pushed += rows.length;
  } catch (e) {
    noteFailure(e instanceof Error ? e.message : String(e));
  }
  void flushStatus();
}

function noteFailure(msg: string) {
  statusCache.ok = false;
  statusCache.lastErrorAt = new Date().toISOString();
  statusCache.lastError = msg;
  statusCache.failed += 1;
  void flushStatus();
}

async function flushStatus() {
  if (Date.now() - statusFlushedAt < 60_000) return;
  statusFlushedAt = Date.now();
  try {
    const existing = await db.setting.findUnique({ where: { key: SETTING_KEY } });
    const next = JSON.stringify(statusCache);
    if (existing?.value === next) return;
    await db.setting.upsert({
      where: { key: SETTING_KEY },
      create: { key: SETTING_KEY, value: next },
      update: { value: next },
    });
  } catch {
    /* status persistence is best-effort too */
  }
}

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

/** Current mirror status (for the Pipeline tab). */
export function mirrorStatus(): MirrorStatus {
  return { ...statusCache };
}

export async function readMirrorStatus(): Promise<MirrorStatus> {
  try {
    const s = await db.setting.findUnique({ where: { key: SETTING_KEY } });
    if (s?.value) return { ...statusCache, ...(JSON.parse(s.value) as MirrorStatus) };
  } catch {}
  return { ...statusCache };
}
