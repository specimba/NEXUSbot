/**
 * v388 evidence probe (readonly) — the 05:35-05:52 +03 metaphor-babble rows
 * from the owner's paste. Zero writes, zero sends.
 */
import { db } from "../src/lib/db";

async function main() {
  const rows = await db.interactionLog.findMany({
    where: { createdAt: { gte: new Date("2026-10-31T02:30:00Z") } },
    orderBy: { createdAt: "asc" },
    take: 25,
    select: { id: true, createdAt: true, username: true, command: true, model: true, modelId: true, route: true, latencyMs: true, webUsed: true },
  });
  for (const r of rows) {
    console.log(JSON.stringify({ t: r.createdAt?.toISOString(), u: r.username, route: r.route, modelId: r.modelId, ms: r.latencyMs, web: r.webUsed, q: String(r.command ?? r.prompt ?? "").slice(0, 90) }));
  }
  console.log(`count=${rows.length}`);
  await db.$disconnect();
}
main();
