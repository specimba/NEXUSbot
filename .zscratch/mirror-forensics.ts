import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { decryptSecret } from "../src/lib/crypto";
import postgres from "postgres";

const db = new PrismaClient();
async function main() {
  const cred = await db.credential.findUnique({ where: { service_label: { service: "supabase", label: "supabase-db-url" } } });
  if (!cred) throw new Error("no cred");
  const dbUrl = decryptSecret(cred.cipher);
  const encKey = process.env.ENCRYPTION_KEY ?? "";
  const sig = (id: string) => createHmac("sha256", encKey).update(id).digest("hex").slice(0, 32);

  const sql = postgres(dbUrl, { max: 1, idle_timeout: 5, connect_timeout: 10, ssl: "require", prepare: false });
  const rows = (await sql`SELECT id, panel_sig, created_at FROM nexus_mirror_interactions ORDER BY created_at ASC`) as any[];

  // How many env keys are available for rotation windows?
  const prevKeys = (process.env.ENCRYPTION_KEYS_PREV ?? "").split(",").map(s => s.trim()).filter(Boolean);
  console.log("ENCRYPTION_KEYS_PREV count:", prevKeys.length);
  console.log("ENV VAR NAMES:", Object.keys(process.env).filter(k => /KEY|SECRET|PASS/i.test(k) && !/SESSION/i.test(k)).join(", "));

  const byDay: Record<string, { total: number; sigOk: number; sigNull: number; sigBad: number }> = {};
  for (const r of rows) {
    const day = String(r.created_at ?? "?").slice(0, 10);
    byDay[day] ??= { total: 0, sigOk: 0, sigNull: 0, sigBad: 0 };
    byDay[day].total++;
    if (!r.panel_sig) byDay[day].sigNull++;
    else if (r.panel_sig === sig(r.id)) byDay[day].sigOk++;
    else byDay[day].sigBad++;
  }
  console.log("day | total | sigOk | sigNull | sigBad");
  for (const [day, c] of Object.entries(byDay).sort()) console.log(`${day} | ${c.total} | ${c.sigOk} | ${c.sigNull} | ${c.sigBad}`);

  // sample of sigBad rows: are ids cuid-like? what channels/usernames?
  const bad = rows.filter(r => r.panel_sig && r.panel_sig !== sig(r.id));
  console.log("sigBad sample ids:", bad.slice(0, 5).map(r => r.id).join(", "));
  const nulls = rows.filter(r => !r.panel_sig);
  console.log("sigNull sample ids:", nulls.slice(0, 5).map(r => r.id).join(", "));

  // lessons table overview
  const lessons = (await sql`SELECT id, technique, panel_sig, created_at, last_seen_at FROM nexus_mirror_lessons ORDER BY last_seen_at ASC`) as any[];
  console.log("lessons in cloud:", lessons.length);
  for (const l of lessons) {
    const ok = l.panel_sig === sig(l.id);
    console.log(` lesson ${l.technique} created=${String(l.created_at).slice(0, 16)} lastSeen=${String(l.last_seen_at).slice(0, 16)} sigOk=${ok}`);
  }
  await sql.end();
  await db.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
