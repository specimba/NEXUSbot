// follow-up readonly probe: slowest rows, 'direct' status row, probe-dupe timestamps
import { Database } from "bun:sqlite";
const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });

const slow = db
  .query(
    "SELECT id, createdAt, username, route, status, latencyMs, model, substr(message,1,50) as msg FROM InteractionLog ORDER BY latencyMs DESC LIMIT 6"
  )
  .all() as any[];
console.log("TOP-6 SLOWEST ALL-TIME:");
for (const r of slow)
  console.log(
    `  ${r.latencyMs}ms route=${r.route} model=${r.model} user=${r.username} status=${r.status} at=${new Date(Number(r.createdAt)).toISOString()} msg="${r.msg}"`
  );

const direct = db
  .query(
    "SELECT id, createdAt, username, route, status, error, substr(message,1,60) as msg, substr(response,1,60) as resp FROM InteractionLog WHERE status='direct' ORDER BY id DESC LIMIT 3"
  )
  .all() as any[];
console.log("STATUS=direct rows:");
for (const r of direct)
  console.log(
    `  #${r.id} at=${new Date(Number(r.createdAt)).toISOString()} user=${r.username} route=${r.route} msg="${r.msg}" resp="${r.resp}" err="${r.error}"`
  );

const dupe = db
  .query(
    "SELECT id, createdAt, username FROM InteractionLog WHERE username='cronprobetest' ORDER BY id DESC LIMIT 4"
  )
  .all() as any[];
console.log("cronprobetest timestamps:");
for (const r of dupe)
  console.log(`  #${r.id} at=${new Date(Number(r.createdAt)).toISOString()}`);

db.close();
