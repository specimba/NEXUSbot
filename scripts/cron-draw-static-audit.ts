import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

async function main() {
  const since = new Date(Date.now() - 24 * 3600_000);
  // 1) all draw rows — size the banter-hijack class
  const draws = await db.interactionLog.findMany({
    where: { createdAt: { gte: since }, route: { contains: "draw" } },
    select: { createdAt: true, message: true, route: true },
    orderBy: { createdAt: "desc" },
  });
  console.log("--- draw rows 24h ---");
  for (const d of draws) console.log(`${d.createdAt.toISOString()} ${d.route} :: ${(d.message || "").slice(0, 70).replace(/\n/g, " ")}`);

  // 2) static-floor rows: error/status detail to name the failing lanes
  const stat = await db.interactionLog.findMany({
    where: { createdAt: { gte: since }, route: "panel-cortex/cortex-chat", provider: "static" },
    select: { createdAt: true, error: true, status: true, latencyMs: true },
    orderBy: { createdAt: "desc" },
  });
  console.log("\n--- static-floor chat rows: error/status ---");
  for (const s of stat) console.log(`${s.createdAt.toISOString()} status=${s.status} err="${(s.error || "").slice(0, 120)}"`);
}
main().finally(() => process.exit(0));
