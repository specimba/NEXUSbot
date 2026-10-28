import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const creds = await (db as any).$queryRawUnsafe("SELECT service FROM Credential");
  console.log("CRED SERVICES:", JSON.stringify(creds));
  const s = await (db as any).$queryRawUnsafe("SELECT key, value FROM Setting WHERE key LIKE '%mirror%' OR key LIKE '%kick%'");
  for (const row of s) console.log(row.key, "→", String(row.value).slice(0, 300));
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
