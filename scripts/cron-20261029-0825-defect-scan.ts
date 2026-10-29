// cron-20261029-0825 defect scan: RSI table existence + chat defect classes
import { Database } from "bun:sqlite";

const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });

console.log("=== TABLES ===");
const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
console.log(tables.map(t => t.name).join(", "));

console.log("\n=== RSI TABLES ===");
for (const t of ["RsiCycle", "RsiSuite", "RsiRun"]) {
  const has = tables.some(x => x.name === t);
  console.log(`${t}: ${has ? "PRESENT" : "MISSING"}`);
  if (has) {
    const c = db.query(`SELECT COUNT(*) as n FROM "${t}"`).get() as { n: number };
    console.log(`  rows: ${c.n}`);
  }
}

console.log("\n=== NEWEST INTERACTIONS (8) ===");
const rows = db.query(
  "SELECT createdAt, username, command, message, response, provider, model, latencyMs, status, memoryUsed FROM InteractionLog ORDER BY createdAt DESC LIMIT 8"
).all() as any[];
for (const r of rows) {
  const msg = (r.message ?? "").replace(/\n/g, " ").slice(0, 50);
  const rep = (r.response ?? "").replace(/\n/g, " ").slice(0, 70);
  console.log(`${r.createdAt} | ${r.username} | cmd=${r.command} provider=${r.provider} model=${r.model} lat=${r.latencyMs} st=${r.status} mem=${r.memoryUsed}`);
  console.log(`   IN: ${msg}`);
  console.log(`   OUT: ${rep}`);
}

console.log("\n=== ROWS SINCE LAST HEARTBEAT (04:26 UTC / 07:26 +03) ===");
const since = "2026-10-29T04:26:00.000Z";
const recent = db.query(
  "SELECT COUNT(*) as n FROM InteractionLog WHERE createdAt >= ?"
).get(since) as { n: number };
console.log(`rows since ${since}: ${recent.n}`);

console.log("\n=== EMOJI SCAN (bot replies since 04:26 UTC) ===");
const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F1FF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;
const emo = db.query(
  "SELECT createdAt, username, response FROM InteractionLog WHERE createdAt >= ? AND response IS NOT NULL AND response != ''"
).all(since) as any[];
let emojiHits = 0;
for (const r of emo) {
  if (emojiRe.test(r.response)) { emojiHits++; console.log(`EMOJI ${r.createdAt} ${r.username}: ${r.response.slice(0, 80)}`); }
}
console.log(`emoji violations: ${emojiHits} / ${emo.length} rows`);

console.log("\n=== DOUBLE-GENERATION CHECK (same sender+msg, 2 replies within 90s, since 04:26 UTC) ===");
const dupes = db.query(
  `SELECT username, message, COUNT(*) as n, GROUP_CONCAT(substr(response,1,30), ' || ') as replies
   FROM InteractionLog WHERE createdAt >= ? AND command='ai' AND message IS NOT NULL AND message != ''
   GROUP BY username, message HAVING n > 1`
).all(since) as any[];
console.log(`duplicate (username,message) groups: ${dupes.length}`);
for (const d of dupes) console.log(`  ${d.username}: "${(d.message||"").slice(0,40)}" x${d.n} => ${d.replies}`);

console.log("\n=== RATE-GUARD / ERROR ROWS (since 04:26 UTC) ===");
const rg = db.query(
  "SELECT COUNT(*) as n FROM InteractionLog WHERE createdAt >= ? AND (status LIKE '%rate%' OR status LIKE '%guard%' OR status LIKE '%error%' OR status LIKE '%fail%' OR status LIKE '%timeout%')"
).get(since) as { n: number };
console.log(`rate-guard/error/fail rows: ${rg.n}`);

console.log("\n=== LANES > 15s (since 04:26 UTC) ===");
const slow = db.query(
  "SELECT createdAt, provider, model, latencyMs FROM InteractionLog WHERE createdAt >= ? AND latencyMs > 15000 ORDER BY latencyMs DESC LIMIT 10"
).all(since) as any[];
console.log(`>15s rows: ${slow.length}`);
for (const s of slow) console.log(`  ${s.createdAt} ${s.provider}/${s.model} ${s.latencyMs}ms`);

console.log("\n=== LATENCY BAND (since 04:26 UTC, non-null) ===");
const lat = db.query(
  "SELECT provider, COUNT(*) as n, AVG(latencyMs) as avg, MAX(latencyMs) as max FROM InteractionLog WHERE createdAt >= ? AND latencyMs IS NOT NULL GROUP BY provider"
).all(since) as any[];
for (const l of lat) console.log(`  ${l.provider}: n=${l.n} avg=${Math.round(l.avg)}ms max=${l.max}ms`);

db.close();
