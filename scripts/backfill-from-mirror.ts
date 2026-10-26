/**
 * One-off restore (v29.12): rebuild the LOCAL pipeline memory from the Supabase
 * mirror after a sandbox reset wiped the panel DB. The mirror is append-only
 * (anon insert), so this script reads through the direct Postgres connection
 * stored in the vault (service supabase, label supabase-db-url) — which must be
 * re-entered by the owner after a reset (the old vault key dies with the old
 * .env; see docs/runbook.md §0).
 *
 * Integrity: only rows whose panel_sig = HMAC-SHA256(ENCRYPTION_KEY, id)
 * verifies are restored — unsigned spam (the anon key is public) is ignored.
 *
 * Run: bun scripts/backfill-from-mirror.ts
 */
import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { decryptSecret } from "../src/lib/crypto";
import postgres from "postgres";

const db = new PrismaClient();

type MirrorInteraction = {
  id: string;
  channel: string | null;
  username: string | null;
  display_handle: string | null;
  command: string | null;
  message: string | null;
  response: string | null;
  model: string | null;
  model_id: string | null;
  provider: string | null;
  route: string | null;
  status: string | null;
  latency_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  web_used: boolean | null;
  flags: string | null;
  injection_score: number | null;
  memory_used: boolean | null;
  error: string | null;
  panel_sig: string | null;
  created_at: string | null;
};

async function main() {
  const cred = await db.credential.findUnique({
    where: { service_label: { service: "supabase", label: "supabase-db-url" } },
  });
  if (!cred) throw new Error("supabase-db-url not stored — owner must re-enter it first");
  const dbUrl = decryptSecret(cred.cipher);
  const encKey = process.env.ENCRYPTION_KEY ?? "";
  if (!encKey) throw new Error("ENCRYPTION_KEY missing");
  const sig = (id: string) => createHmac("sha256", encKey).update(id).digest("hex");

  const sql = postgres(dbUrl, { max: 2, idle_timeout: 5, connect_timeout: 10 });

  const ints = (await sql`
    SELECT * FROM nexus_mirror_interactions ORDER BY created_at ASC LIMIT 2000
  `) as unknown as MirrorInteraction[];

  let restored = 0, skippedSig = 0, skippedDup = 0;
  for (const r of ints) {
    if (!r?.id || !r.panel_sig || r.panel_sig !== sig(r.id)) {
      skippedSig++;
      continue;
    }
    const exists = await db.interactionLog.findUnique({ where: { id: r.id }, select: { id: true } });
    if (exists) {
      skippedDup++;
      continue;
    }
    await db.interactionLog.create({
      data: {
        id: r.id,
        channel: r.channel ?? "specimba",
        username: r.username ?? "",
        displayHandle: r.display_handle ?? "",
        command: r.command ?? "ai",
        message: r.message ?? "",
        response: r.response ?? "",
        model: r.model ?? "",
        modelId: r.model_id ?? "",
        provider: r.provider ?? "",
        route: r.route ?? "",
        status: r.status ?? "ok",
        latencyMs: r.latency_ms ?? null,
        promptTokens: r.prompt_tokens ?? null,
        completionTokens: r.completion_tokens ?? null,
        webUsed: r.web_used ?? false,
        flags: r.flags ?? "[]",
        injectionScore: r.injection_score ?? 0,
        memoryUsed: r.memory_used ?? false,
        error: r.error ?? "",
        ...(r.created_at ? { createdAt: new Date(r.created_at) } : {}),
      },
    });
    restored++;
  }
  console.log(`interactions: ${restored} restored, ${skippedDup} already present, ${skippedSig} unsigned/spam ignored`);

  // Lessons: verify + upsert (hits/lastSeenAt freshen naturally on conflict).
  const lessons = (await sql`
    SELECT * FROM nexus_mirror_lessons ORDER BY last_seen_at ASC LIMIT 500
  `) as unknown as Array<{
    id: string; technique: string; username: string | null; snippet: string | null;
    counter: string | null; hits: number | null; severity: number | null;
    panel_sig: string | null; last_seen_at: string | null; created_at: string | null;
  }>;
  let lessonsOk = 0;
  for (const l of lessons) {
    if (!l?.id || !l.panel_sig || l.panel_sig !== sig(l.id)) continue;
    await db.securityLesson.upsert({
      where: { technique_username: { technique: l.technique, username: l.username ?? "" } },
      create: {
        id: l.id,
        technique: l.technique,
        username: l.username ?? "",
        snippet: l.snippet ?? "",
        counter: l.counter ?? "",
        hits: l.hits ?? 1,
        severity: l.severity ?? 1,
        ...(l.last_seen_at ? { lastSeenAt: new Date(l.last_seen_at) } : {}),
        ...(l.created_at ? { createdAt: new Date(l.created_at) } : {}),
      },
      update: {
        hits: l.hits ?? 1,
        severity: l.severity ?? 1,
        ...(l.last_seen_at ? { lastSeenAt: new Date(l.last_seen_at) } : {}),
      },
    });
    lessonsOk++;
  }
  console.log(`lessons: ${lessonsOk} verified+upserted`);

  await sql.end();
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
