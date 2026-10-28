// cron-20261028-2025 — root-cause dump of recent InteractionLog rows.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const since = new Date(Date.now() - 8 * 3600 * 1000); // last 8h
  const rows = await prisma.interactionLog.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 300,
  });

  console.log(`rows last 8h: ${rows.length}`);

  // Aggregate by provider+modelId
  const byLane = new Map<string, { n: number; lats: number[]; errs: number }>();
  for (const r of rows) {
    const key = `${r.provider} | ${r.modelId || r.model} | ${r.route}`;
    if (!byLane.has(key)) byLane.set(key, { n: 0, lats: [], errs: 0 });
    const b = byLane.get(key)!;
    b.n++;
    if (r.latencyMs) b.lats.push(r.latencyMs);
    if (r.error) b.errs++;
  }
  console.log("\n== lane aggregate (8h) ==");
  const sorted = [...byLane.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [k, v] of sorted) {
    const lats = v.lats.sort((a, b) => a - b);
    const p50 = lats.length ? lats[Math.floor(lats.length / 2)] : 0;
    const p95 = lats.length ? lats[Math.floor(lats.length * 0.95)] : 0;
    console.log(
      `${k}  n=${v.n}  p50=${p50}  p95=${p95}  max=${lats.at(-1) ?? 0}  withErrorField=${v.errs}`
    );
  }

  // STATIC floor rows — the smoking gun
  const statics = rows.filter((r) => r.modelId === "static-floor" || r.provider === "static");
  console.log(`\n== STATIC floor rows (8h): ${statics.length} ==`);
  for (const r of statics.slice(0, 12)) {
    console.log(
      `${r.createdAt.toISOString()} @${r.username} lat=${r.latencyMs} status=${r.status} route=${r.route} err="${r.error.slice(0, 120)}" msg="${r.message.slice(0, 60)}"`
    );
  }

  // Slow rows >12s
  const slow = rows.filter((r) => (r.latencyMs ?? 0) > 12000);
  console.log(`\n== rows >12s (8h): ${slow.length} ==`);
  for (const r of slow.slice(0, 15)) {
    console.log(
      `${r.createdAt.toISOString()} @${r.username} ${r.provider}/${r.modelId} lat=${r.latencyMs} status=${r.status} route=${r.route} err="${r.error.slice(0, 100)}"`
    );
  }

  // All rows with non-empty error field
  const errs = rows.filter((r) => r.error);
  console.log(`\n== rows with error text (8h): ${errs.length} ==`);
  for (const r of errs.slice(0, 20)) {
    console.log(
      `${r.createdAt.toISOString()} @${r.username} ${r.provider}/${r.modelId} lat=${r.latencyMs} status=${r.status} route=${r.route} err="${r.error.slice(0, 160)}"`
    );
  }

  // Emoji scan in responses (absolute ban)
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/u;
  const emoji = rows.filter((r) => emojiRe.test(r.response));
  console.log(`\n== rows with emoji in response (8h): ${emoji.length} ==`);
  for (const r of emoji.slice(0, 5)) console.log(`${r.createdAt.toISOString()} @${r.username}: ${r.response.slice(0, 80)}`);

  // The two entries the owner flagged (~12:07-12:10Z)
  const flagged = await prisma.interactionLog.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
    orderBy: { createdAt: "asc" },
    take: 40,
  });
  console.log(`\n== last 60min chronology ==`);
  for (const r of flagged) {
    console.log(
      `${r.createdAt.toISOString()} @${r.username} cmd=${r.command} ${r.provider}/${r.modelId} lat=${r.latencyMs} status=${r.status} route=${r.route} mem=${r.memoryUsed} msg="${r.message.slice(0, 50)}" resp="${r.response.slice(0, 50)}"`
    );
  }
}

main().finally(() => process.exit(0));
