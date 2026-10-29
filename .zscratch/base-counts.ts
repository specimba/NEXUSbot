import { PrismaClient } from "@prisma/client";
const db = new PrismaClient({ datasources: { db: { url: "file:/tmp/rollback-base-readonly.db" } } } as any);
async function main() {
  const rows = await (db as any).$queryRawUnsafe("SELECT substr(createdAt,1,10) d, COUNT(*) c FROM InteractionLog GROUP BY d ORDER BY d");
  console.log("BASE InteractionLog by day:", rows.map((r: any) => `${r.d}:${Number(r.c)}`).join(" | ") || "(none)");
  const total = await (db as any).$queryRawUnsafe("SELECT COUNT(*) c FROM InteractionLog");
  console.log("BASE total interactions:", Number(total[0].c));
  const ls = await db.securityLesson.findMany();
  console.log("BASE SecurityLessons:", ls.map((l: any) => `${l.technique}/${l.username || "?"}/hits=${l.hits}`).join(" | ") || "(none)");
  const first = await (db as any).$queryRawUnsafe("SELECT id, username, createdAt FROM InteractionLog ORDER BY createdAt ASC LIMIT 3");
  for (const r of first) console.log("first:", r.id, r.username, String(r.createdAt).slice(0, 16));
  const last = await (db as any).$queryRawUnsafe("SELECT id, username, createdAt FROM InteractionLog ORDER BY createdAt DESC LIMIT 3");
  for (const r of last) console.log("last:", r.id, r.username, String(r.createdAt).slice(0, 16));
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
