/**
 * v386 evidence probe (readonly) — the 03:47 +03 "erlik kimdir" 17s
 * web-fallback row + research events around it. Zero writes, zero sends.
 */
import { db } from "../src/lib/db";

async function main() {
  const rows = await db.interactionLog.findMany({
    orderBy: { id: "desc" as const },
    take: 8,
    select: {
      id: true, createdAt: true, username: true, command: true,
      model: true, modelId: true, status: true, webUsed: true,
      flags: true, error: true,
    },
  });
  console.log("== InteractionLog (latest 8) ==");
  for (const r of rows) console.log(JSON.stringify(r).slice(0, 700));

  const evs = await db.event.findMany({
    where: { type: { contains: "research" } },
    orderBy: { id: "desc" as const },
    take: 10,
    select: { id: true, createdAt: true, type: true, payload: true },
  });
  console.log("\n== research events (latest 10) ==");
  for (const e of evs) console.log(e.createdAt?.toISOString(), e.type, String(e.payload).slice(0, 300));
}

main()
  .catch((e) => { console.error("PROBE FAIL", e); process.exit(1); })
  .finally(() => db.$disconnect());
