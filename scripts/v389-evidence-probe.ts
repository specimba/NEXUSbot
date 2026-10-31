/**
 * v389 evidence probe (readonly) — the 06:02-06:04 +03 system-control probe
 * rows (berxx: "EXA nın bağlantısını kes" → research-lane MCP guide leak).
 * Zero writes, zero sends.
 */
import { db } from "../src/lib/db";

async function main() {
  const rows = await db.interactionLog.findMany({
    where: { createdAt: { gte: new Date("2026-10-31T02:55:00Z") } },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: { id: true, createdAt: true, username: true, command: true, model: true, modelId: true, route: true, latencyMs: true, webUsed: true, message: true },
  });
  for (const r of rows) {
    console.log(JSON.stringify({ t: r.createdAt?.toISOString(), u: r.username, route: r.route, modelId: r.modelId, ms: r.latencyMs, web: r.webUsed, q: String(r.message ?? r.command ?? "").slice(0, 90) }));
  }
  console.log(`count=${rows.length}`);
  await db.$disconnect();
}
main();
