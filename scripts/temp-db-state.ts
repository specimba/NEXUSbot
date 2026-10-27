/** Temp Task-25 forensics: current DB state after the 15:08Z sandbox reset. */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const creds = await db.credential.findMany({ select: { id: true, service: true, label: true, keyId: true, createdAt: true } });
  console.log(`credentials: ${creds.length}`);
  for (const c of creds) console.log(`  ${c.service}/${c.label} keyId=${c.keyId} at=${c.createdAt.toISOString()}`);

  const widgets = await db.widget.findMany({ select: { id: true, name: true, seeded: true, variables: true } });
  console.log(`widgets: ${widgets.length}`);
  for (const w of widgets) {
    let names: string[] = [];
    try {
      const vars = JSON.parse(w.variables || "[]") as Array<{ name: string; value?: string; secret?: boolean }>;
      names = vars.map((v) => `${v.name}${v.secret ? "(secret)" : ""}=${v.value ? "SET" : "empty"}`);
    } catch {
      names = ["<unparsable>"];
    }
    console.log(`  widget "${w.name}" seeded=${w.seeded} vars=[${names.join(", ")}]`);
  }

  const settings = await db.setting.findMany({ select: { key: true } });
  console.log(`settings: ${settings.length} → ${settings.map((s) => s.key).join(", ")}`);

  const interactions = await db.interactionLog.count();
  const events = await db.event.count();
  const tokens = await db.ingestToken.count();
  const lessons = await db.securityLesson.count();
  console.log(`interactions=${interactions} events=${events} ingestTokens=${tokens} lessons=${lessons}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
