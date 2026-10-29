// cron-db-audit.ts — read-only DB audit for the cron harness review.
// Checks: recent rows, single-flight doubles, emojis in bot replies, rate-guard noise.
import { Database } from "bun:sqlite";

const db = new Database("db/custom.db", { readonly: true });

const rows = db
  .query(
    "SELECT id, createdAt, username, command, substr(message,1,55) AS msg, model, modelId, route, flags, injectionScore, status, latencyMs, substr(response,1,40) AS resp FROM InteractionLog ORDER BY createdAt DESC LIMIT 24",
  )
  .all() as Record<string, string | number>[];

console.log(`=== last ${rows.length} rows ===`);
for (const r of rows) {
  const flag =
    r.flags && String(r.flags) !== "[]" ? ` FLAG=${r.flags} score=${r.injectionScore}` : "";
  console.log(
    `${r.createdAt} | ${r.username} | ${r.command} | ${r.msg} | model=${r.model} engine=${r.modelId} route=${r.route} ${r.status} ${r.latencyMs}ms${flag}`,
  );
}

// Emoji scan in bot responses (absolute ban)
console.log("\n=== emoji scan in responses (last 200 rows) ===");
const emojiRe =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2705}\u{2728}]/u;
const respRows = db
  .query("SELECT id, createdAt, response FROM InteractionLog ORDER BY createdAt DESC LIMIT 200")
  .all() as Record<string, string>[];
let emojiHits = 0;
for (const r of respRows) {
  if (r.response && emojiRe.test(r.response)) {
    emojiHits++;
    console.log(`EMOJI ${r.createdAt} id=${r.id}: ${r.response.slice(0, 80)}`);
  }
}
console.log(emojiHits === 0 ? "clean — no emojis in last 200 bot replies" : `hits: ${emojiHits}`);

// Single-flight: same user+command generations within 2s
console.log("\n=== possible double-generations (same user, responses within 2s) ===");
const gens = db
  .query(
    "SELECT createdAt, username, command, model, substr(response,1,30) AS resp FROM InteractionLog WHERE response != '' ORDER BY createdAt ASC",
  )
  .all() as Record<string, string>[];
const t = (s: string) => new Date(String(s).replace(" ", "T") + "Z").getTime();
let doubles = 0;
for (let i = 1; i < gens.length; i++) {
  const a = gens[i - 1];
  const b = gens[i];
  const d = t(b.createdAt) - t(a.createdAt);
  if (d >= 0 && d <= 2000 && a.username === b.username && a.command === b.command) {
    doubles++;
    console.log(
      `POSSIBLE DOUBLE +${d}ms: ${a.username} [${a.command}] "${a.resp}" <> "${b.resp}" (${a.createdAt})`,
    );
  }
}
console.log(
  doubles === 0
    ? `clean — no same-user 2s-window double generations in ${gens.length} rows`
    : `doubles: ${doubles}`,
);

// rate-guard noise
console.log("\n=== rate-guard rows ===");
const rg = db
  .query(
    "SELECT createdAt, username, substr(response,1,60) AS resp FROM InteractionLog WHERE route LIKE '%rate-guard%' OR command='rate-guard' ORDER BY createdAt DESC LIMIT 10",
  )
  .all() as Record<string, string>[];
if (rg.length === 0) console.log("none");
for (const r of rg) console.log(`${r.createdAt} | ${r.username} | ${r.resp}`);

// flagged totals
console.log("\n=== security totals ===");
const fl = db
  .query(
    "SELECT COUNT(*) AS n FROM InteractionLog WHERE flags IS NOT NULL AND flags != '[]' AND flags != ''",
  )
  .get() as { n: number };
const lessons = db.query("SELECT COUNT(*) AS n FROM SecurityLesson").get() as { n: number };
console.log(`flagged rows: ${fl.n}, security lessons: ${lessons.n}`);

// usage today
const today = new Date().toISOString().slice(0, 10);
const ue = db
  .query(
    "SELECT kind, COUNT(*) AS n, ROUND(SUM(credits),6) AS cost FROM UsageEvent WHERE createdAt LIKE ? GROUP BY kind",
  )
  .all(`${today}%`) as { kind: string; n: number; cost: number }[];
console.log(`\n=== usage events today (${today}) ===`);
if (ue.length === 0) console.log("none");
for (const r of ue) console.log(`${r.kind}: n=${r.n} credits=${r.cost}`);
