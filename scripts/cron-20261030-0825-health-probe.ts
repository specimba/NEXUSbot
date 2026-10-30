// cron-20261030-0825 health probe — READONLY (bun:sqlite readonly mode)
// Checks: interaction log health, duplicate-generation pairs, emoji ban, recent errors
import { Database } from "bun:sqlite";

const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });

const tables = db
  .query("SELECT name FROM sqlite_master WHERE type='table'")
  .all() as { name: string }[];
console.log("tables:", tables.map((t) => t.name).join(", "));

// --- interactions ---
const hasInter = tables.some((t) => t.name === "InteractionLog");
if (hasInter) {
  const cols = db.query("PRAGMA table_info(InteractionLog)").all() as any[];
  console.log("inter cols:", cols.map((c) => c.name).join(","));
  const recent = db
    .query(
      "SELECT * FROM InteractionLog ORDER BY id DESC LIMIT 30"
    )
    .all() as any[];
  const okCount = recent.filter(
    (r) => r.ok === 1 || r.ok === true || r.status === "ok"
  ).length;
  console.log(`recent30 ok=${okCount}/30`);
  for (const r of recent.slice(0, 8)) {
    console.log(
      `  #${r.id} ${r.createdAt ?? r.timestamp ?? ""} ch=${r.channel ?? ""} route=${r.route ?? r.kind ?? ""} lat=${r.latencyMs ?? ""} ok=${r.ok ?? r.status ?? ""}`
    );
  }
  // duplicate-generation pairs: same user+channel within 3s both hitting model
  const rows = db
    .query(
      "SELECT id, createdAt, channel, username, route, latencyMs, status FROM InteractionLog ORDER BY id DESC LIMIT 120"
    )
    .all() as any[];
  let dupes = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i],
      b = rows[i + 1];
    const ta = Number(a.createdAt ?? 0),
      tb = Number(b.createdAt ?? 0);
    if (
      Math.abs(ta - tb) < 3000 &&
      a.channel === b.channel &&
      a.username === b.username &&
      String(a.route ?? "").includes("cortex") &&
      String(b.route ?? "").includes("cortex")
    ) {
      dupes++;
      console.log(
        `DUPE-PAIR? #${a.id} vs #${b.id} user=${a.username} dt=${Math.abs(ta - tb)}ms routes=${a.route}+${b.route}`
      );
    }
  }
  console.log(`duplicate-generation pairs in last120: ${dupes}`);

  const nonOk = db
    .query(
      "SELECT id, createdAt, username, route, status, error FROM InteractionLog WHERE status != 'ok' ORDER BY id DESC LIMIT 10"
    )
    .all() as any[];
  console.log(`non-ok rows (latest 10): ${nonOk.length}`);
  for (const r of nonOk) console.log(`  #${r.id} ${r.route} ${r.status} err=${String(r.error ?? "").slice(0, 80)}`);

  // --- emoji ban scan on recent bot responses (last 60) ---
  const emojiRe =
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE0F}]/u;
  const resp = db
    .query(
      "SELECT id, route, response FROM InteractionLog ORDER BY id DESC LIMIT 60"
    )
    .all() as any[];
  const emojiHits = resp.filter((r) => emojiRe.test(r.response ?? ""));
  console.log(`emoji hits in last60 responses: ${emojiHits.length}`);
  for (const h of emojiHits.slice(0, 3))
    console.log(`  #${h.id} ${(h.response ?? "").slice(0, 90)}`);

  // slow routes p95-ish (last 100)
  const lat = db
    .query(
      "SELECT latencyMs FROM InteractionLog ORDER BY id DESC LIMIT 100"
    )
    .all()
    .map((r: any) => Number(r.latencyMs ?? 0))
    .sort((a, b) => a - b);
  const p50 = lat[Math.floor(lat.length / 2)] ?? 0;
  const p95 = lat[Math.floor(lat.length * 0.95)] ?? 0;
  console.log(`latency last100: p50=${p50}ms p95=${p95}ms max=${lat[lat.length - 1]}ms`);
}

db.close();
