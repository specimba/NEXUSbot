/**
 * One-off backfill: push ALL existing InteractionLog + SecurityLesson rows to
 * the Supabase mirror (run: bun scripts/backfill-mirror.ts). Idempotent —
 * interactions use ignore-duplicates, lessons merge-duplicates (upsert hits).
 */
import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const SETTING_KEY = "brain.mirror.status";

function panelSig(id: string): string {
  return createHmac("sha256", process.env.ENCRYPTION_KEY ?? "").update(id).digest("hex").slice(0, 32);
}

async function creds() {
  const widget = await db.widget.findFirst({ where: { seeded: true }, select: { variables: true } });
  const vars = JSON.parse(widget?.variables ?? "[]") as Array<{ name: string; value: string }>;
  const url = (vars.find((v) => v.name === "supabase_url")?.value ?? "").replace(/\/functions\/v1\/.*$/i, "").replace(/\/+$/, "");
  const anon = vars.find((v) => v.name === "supabase_anon_key")?.value ?? "";
  if (!/^https:\/\/.+/.test(url) || !anon.startsWith("eyJ")) throw new Error("supabase_url / supabase_anon_key not configured");
  return { url, anon };
}

async function push(kind: "interactions" | "lessons", rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return;
  const { url, anon } = await creds();
  // SECURITY DEFINER RPC — idempotent insert/upsert (plain PostgREST ON CONFLICT
  // is blocked by RLS-on-conflict without a public SELECT policy).
  const res = await fetch(`${url}/rest/v1/rpc/nexus_mirror_push`, {
    method: "POST",
    headers: {
      apikey: anon,
      Authorization: `Bearer ${anon}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_kind: kind, p_rows: rows }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${kind}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  console.log(`  ${kind}: pushed ${rows.length} rows (inserted ${await res.text()})`);
}

async function main() {
  const interactions = await db.interactionLog.findMany({ orderBy: { createdAt: "asc" } });
  const lessons = await db.securityLesson.findMany({ orderBy: { createdAt: "asc" } });
  console.log(`backfilling ${interactions.length} interactions, ${lessons.length} lessons`);

  for (let i = 0; i < interactions.length; i += 100) {
    const batch = interactions.slice(i, i + 100).map((r) => ({
      id: r.id, channel: r.channel, username: r.username, display_handle: r.displayHandle,
      command: r.command, message: r.message, response: r.response, model: r.model,
      model_id: r.modelId, provider: r.provider, route: r.route, status: r.status,
      latency_ms: r.latencyMs, prompt_tokens: r.promptTokens, completion_tokens: r.completionTokens,
      web_used: r.webUsed, flags: r.flags, injection_score: r.injectionScore,
      memory_used: r.memoryUsed, error: r.error, panel_sig: panelSig(r.id),
      created_at: r.createdAt.toISOString(),
    }));
    await push("interactions", batch);
  }

  for (let i = 0; i < lessons.length; i += 100) {
    const batch = lessons.slice(i, i + 100).map((r) => ({
      id: r.id, technique: r.technique, username: r.username, snippet: r.snippet,
      counter: r.counter, hits: r.hits, severity: r.severity, panel_sig: panelSig(r.id),
      last_seen_at: r.lastSeenAt.toISOString(), created_at: r.createdAt.toISOString(),
    }));
    await push("lessons", batch);
  }

  await db.setting.upsert({
    where: { key: SETTING_KEY },
    create: {
      key: SETTING_KEY,
      value: JSON.stringify({ ok: true, lastOkAt: new Date().toISOString(), lastErrorAt: null, lastError: "", pushed: interactions.length + lessons.length, failed: 0 }),
    },
    update: {
      value: JSON.stringify({ ok: true, lastOkAt: new Date().toISOString(), lastErrorAt: null, lastError: "", pushed: interactions.length + lessons.length, failed: 0 }),
    },
  });
  console.log("backfill complete — status stored in brain.mirror.status");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
