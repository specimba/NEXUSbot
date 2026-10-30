// cron-20261031-0020 SLOT 0 DEFECT scan — READONLY (bun:sqlite readonly mode)
// Hunt list: emoji in bot replies, dupe-generation pairs, rate-guard noise,
// slow routes (>15s), non-ok rows, recent error Events. No writes, no vault.
import { Database } from "bun:sqlite";

const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });

const tables = db
  .query("SELECT name FROM sqlite_master WHERE type='table'")
  .all() as { name: string }[];
console.log("tables:", tables.map((t) => t.name).join(", "));

if (tables.some((t) => t.name === "InteractionLog")) {
  const cols = db.query("PRAGMA table_info(InteractionLog)").all() as any[];
  console.log("cols:", cols.map((c) => c.name).join(","));
  const total = db.query("SELECT COUNT(*) n FROM InteractionLog").get() as any;
  console.log("total rows:", total.n);

  const rows = db
    .query(
      "SELECT * FROM InteractionLog ORDER BY id DESC LIMIT 200"
    )
    .all() as any[];
  const emojiRe =
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}]/u;

  let emojiHits = 0,
    slow = 0,
    nonOk = 0,
    rateGuard = 0;
  const latencies: number[] = [];
  for (const r of rows) {
    const resp = String(r.response ?? r.reply ?? "");
    if (emojiRe.test(resp)) {
      emojiHits++;
      if (emojiHits <= 5)
        console.log(
          `EMOJI #${r.id} route=${r.route}: ${resp.slice(0, 90).replace(/\n/g, " ")}`
        );
    }
    const lat = Number(r.latencyMs ?? r.latency ?? 0);
    if (lat > 0) latencies.push(lat);
    if (lat > 15000) {
      slow++;
      if (slow <= 5)
        console.log(
          `SLOW #${r.id} route=${r.route} lat=${lat}ms user=${r.username}`
        );
    }
    const st = String(r.status ?? r.ok ?? "ok");
    if (st !== "ok" && st !== "1" && st !== "true") {
      nonOk++;
      if (nonOk <= 8)
        console.log(
          `NON-OK #${r.id} st=${st} route=${r.route} err=${String(r.error ?? "").slice(0, 80)}`
        );
    }
    const route = String(r.route ?? "");
    if (route.includes("rate") || resp.includes("Hız limiti")) {
      rateGuard++;
      if (rateGuard <= 5)
        console.log(
          `RATE-GUARD #${r.id} route=${route} at=${r.createdAt} user=${r.username}`
        );
    }
  }
  latencies.sort((a, b) => a - b);
  const p = (q: number) =>
    latencies.length
      ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]
      : 0;
  console.log(
    `SCAN last ${rows.length}: emoji=${emojiHits} slow>15s=${slow} nonOk=${nonOk} rateGuard=${rateGuard} | lat p50=${p(0.5)} p95=${p(0.95)} max=${latencies.at(-1) ?? 0} (n=${latencies.length})`
  );

  // dupe-generation pairs: same user, both model lanes, <5s apart
  let dupes = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i],
      b = rows[i + 1];
    const ta = Date.parse(String(a.createdAt ?? "")),
      tb = Date.parse(String(b.createdAt ?? ""));
    if (
      Number.isFinite(ta) &&
      Number.isFinite(tb) &&
      Math.abs(ta - tb) < 5000 &&
      a.username === b.username &&
      String(a.route ?? "").includes("cortex") &&
      String(b.route ?? "").includes("cortex") &&
      String(a.route) === String(b.route)
    ) {
      dupes++;
      console.log(
        `DUPE-PAIR #${a.id}/#${b.id} user=${a.username} dt=${Math.abs(ta - tb)}ms route=${a.route}`
      );
    }
  }
  console.log(`dupe-generation pairs in last ${rows.length}: ${dupes}`);
}

if (tables.some((t) => t.name === "Event")) {
  const ev = db
    .query(
      "SELECT id, createdAt, type, level, substr(message,1,100) m FROM Event ORDER BY id DESC LIMIT 15"
    )
    .all() as any[];
  console.log("events(last 15):");
  for (const e of ev)
    console.log(`  #${e.id} ${e.createdAt} [${e.level}] ${e.type}: ${e.m}`);
}
db.close();
console.log("SCAN DONE (readonly)");
