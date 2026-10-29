/**
 * cron-20261029-0726 — READ-ONLY defect scan for the 4h harness review window.
 * Checks the four defect classes dev.log cannot show:
 *   1) emoji ban violation in bot replies (the designed TIME-tool glyph "⏱" is
 *      allowlisted — shipped since v29.x, every prior review passed it)
 *   2) single-flight regression: one !ai producing TWO generations
 *      (same sender+prompt within 20s, different responses, neither busy)
 *   3) rate-guard noise rows in the window
 *   4) routes consistently slower than 15s
 * Plus: route distribution + memoryUsed ratio (v36.9 fix still holding).
 * ZERO writes to the DB — findMany only.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
const norm = (s: string) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);

async function main() {
  const since = new Date("2026-10-29T02:00:00.000Z"); // 05:00 +03
  const rows = await prisma.interactionLog.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: {
      username: true, message: true, response: true, route: true, model: true,
      provider: true, status: true, latencyMs: true, memoryUsed: true, createdAt: true,
    },
  });
  console.log(`window rows: ${rows.length} (since 05:00 +03)`);
  if (rows.length === 0) return;

  // 1) emoji ban
  const emojiHits = rows.filter((r) => EMOJI_RE.test(String(r.response || "").replace(/⏱/g, "")));
  console.log(`emoji violations: ${emojiHits.length}`);
  for (const r of emojiHits.slice(0, 5))
    console.log(`  EMOJI ${r.createdAt.toISOString()} @${r.username}: ${JSON.stringify(String(r.response).slice(0, 120))}`);

  // 2) single-flight regression (two generations, same sender+prompt, <20s apart)
  const seen = new Map<string, { at: number; response: string; createdAt: Date }>();
  const dupes: string[] = [];
  for (const r of rows) {
    const key = `${r.username}::${norm(r.message)}`;
    const prev = seen.get(key);
    const at = r.createdAt.getTime();
    if (prev && at - prev.at < 20_000 && prev.response !== r.response &&
        r.status !== "busy" && r.status !== "refused") {
      dupes.push(`${r.createdAt.toISOString()} @${r.username} "${norm(r.message).slice(0, 60)}" gap=${at - prev.at}ms`);
    }
    seen.set(key, { at, response: r.response, createdAt: r.createdAt });
  }
  console.log(`double-generation suspects: ${dupes.length}`);
  dupes.slice(0, 8).forEach((d) => console.log(`  DUPE ${d}`));

  // 3) rate-guard noise
  const rateGuard = rows.filter((r) => /RATE_GUARD/i.test(`${r.route} ${r.model} ${r.status}`));
  console.log(`rate-guard rows: ${rateGuard.length}`);
  rateGuard.slice(0, 5).forEach((r) =>
    console.log(`  RG ${r.createdAt.toISOString()} @${r.username}: ${r.route}/${r.model}/${r.status}`));

  // 4) slow lanes (>15s)
  const slow = rows.filter((r) => (r.latencyMs ?? 0) > 15_000);
  console.log(`>15s rows: ${slow.length}`);
  slow.slice(0, 8).forEach((r) =>
    console.log(`  SLOW ${r.createdAt.toISOString()} ${r.latencyMs}ms ${r.route}/${r.model} @${r.username}`));

  // 5) route distribution + memory ratio
  const byRoute = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.route || "?"} / ${r.model || "?"}`;
    byRoute.set(k, (byRoute.get(k) ?? 0) + 1);
  }
  console.log("route distribution:");
  Array.from(byRoute.entries()).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}  ${k}`));

  // memory: rows after 05:20 +03 (post-v36.9) with a real model reply
  const postFix = rows.filter((r) => r.createdAt >= new Date("2026-10-29T02:20:00.000Z") && r.provider !== "tool" && r.provider !== "none");
  if (postFix.length) {
    const memYes = postFix.filter((r) => r.memoryUsed).length;
    console.log(`post-v36.9 model rows: ${postFix.length}, memoryUsed=true: ${memYes}`);
  }

  // per-route latency stats (mean) — for the "consistently slow" verdict
  const lat = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    if (!r.latencyMs) continue;
    const k = `${r.route || "?"}`;
    const e = lat.get(k) ?? { sum: 0, n: 0 };
    e.sum += r.latencyMs; e.n += 1;
    lat.set(k, e);
  }
  console.log("latency means by route:");
  Array.from(lat.entries()).sort((a, b) => b[1].sum / b[1].n - a[1].sum / a[1].n).forEach(([k, v]) =>
    console.log(`  ${String(Math.round(v.sum / v.n)).padStart(6)}ms  n=${String(v.n).padStart(2)}  ${k}`));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error("scan error:", e); await prisma.$disconnect(); process.exit(1); });
