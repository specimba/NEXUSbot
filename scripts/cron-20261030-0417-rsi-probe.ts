// readonly probe: RSI table schemas (grounding for cron-harness-v2 prompt)
import { Database } from "bun:sqlite";
const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
for (const t of ["RsiSuite", "RsiTask", "RsiCycle", "RsiRun", "RsiImprovementEdge"]) {
  const cols = (db.query(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name);
  const n = (db.query(`SELECT COUNT(*) c FROM ${t}`).get() as any).c;
  console.log(`${t} (${n} rows): ${cols.join(", ")}`);
}
db.close();
