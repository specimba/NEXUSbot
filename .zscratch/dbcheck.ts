import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const tables = await (db as any).$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  for (const t of tables) {
    const n = t.name as string;
    if (n.startsWith("_prisma") || n.startsWith("sqlite_")) continue;
    const c = await (db as any).$queryRawUnsafe(`SELECT COUNT(*) as c FROM "${n}"`);
    console.log(`${n}: ${c[0].c}`);
  }
  // last interaction timestamps
  try {
    const last = await (db as any).$queryRawUnsafe("SELECT id, createdAt FROM Interaction ORDER BY id DESC LIMIT 3");
    console.log("LAST INTERACTIONS:", JSON.stringify(last));
  } catch (e: any) { console.log("Interaction ERR:", e.message); }
  // kick credentials presence (names only — never print secrets)
  try {
    const creds = await (db as any).$queryRawUnsafe("SELECT service, name FROM Credential");
    console.log("CREDENTIAL SERVICES:", JSON.stringify(creds));
  } catch (e: any) { console.log("Credential ERR:", e.message); }
  // settings keys
  try {
    const s = await (db as any).$queryRawUnsafe("SELECT key FROM Setting");
    console.log("SETTINGS:", s.map((x: any) => x.key).join(", "));
  } catch (e: any) { console.log("Setting ERR:", e.message); }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
