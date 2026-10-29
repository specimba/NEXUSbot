import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

async function main() {
  const since = new Date(Date.now() - 24 * 3600_000);
  const rows = await db.interactionLog.findMany({
    where: { createdAt: { gte: since }, command: "ai" },
    select: { createdAt: true, model: true, provider: true, route: true, latencyMs: true, status: true, message: true, response: true, error: true },
    orderBy: { createdAt: "desc" },
    take: 400,
  });
  const byRoute = new Map<string, { n: number; lat: number[]; models: Map<string, number> }>();
  for (const r of rows) {
    const key = r.route || "?";
    if (!byRoute.has(key)) byRoute.set(key, { n: 0, lat: [], models: new Map() });
    const b = byRoute.get(key)!;
    b.n += 1;
    if (r.latencyMs) b.lat.push(r.latencyMs);
    b.models.set(r.model || "?", (b.models.get(r.model || "?") || 0) + 1);
  }
  console.log(`rows(last24h, ai/cortex): ${rows.length}`);
  for (const [route, b] of [...byRoute.entries()].sort((a, c) => c[1].n - a[1].n)) {
    const lat = b.lat.sort((x, y) => x - y);
    const p50 = lat.length ? lat[Math.floor(lat.length / 2)] : 0;
    const p90 = lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.9))] : 0;
    const slow = lat.filter((l) => l > 15000).length;
    console.log(`route=${route} n=${b.n} p50=${p50}ms p90=${p90}ms >15s:${slow} models=${JSON.stringify([...b.models.entries()].slice(0, 6))}`);
  }
  // slowest recent rows detail
  console.log("\n--- slowest 12 rows ---");
  for (const r of [...rows].sort((a, c) => (c.latencyMs || 0) - (a.latencyMs || 0)).slice(0, 12)) {
    console.log(`${r.createdAt.toISOString()} ${r.route} ${r.model} ${r.latencyMs}ms :: ${(r.message || "").slice(0, 50).replace(/\n/g, " ")}`);
  }
  // error-ish rows
  console.log("\n--- static-floor / fallback rows last 24h ---");
  const stat = rows.filter((r) => (r.model || "").toLowerCase().includes("static") || (r.provider || "") === "static");
  for (const r of stat.slice(0, 10)) {
    console.log(`${r.createdAt.toISOString()} ${r.route} ${r.model} ${r.latencyMs}ms :: ${(r.message || "").slice(0, 60).replace(/\n/g, " ")}`);
  }
}
main().finally(() => process.exit(0));
