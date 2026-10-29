// scripts/cron-20261029-2055-perf-probe.ts — READONLY performance corroboration for the owner's pasted 500w stats.
// No writes, no vault values, no credentials — counts and latency profiles only.
import { Database } from "bun:sqlite";

const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
try {
  const tables = (db
    .query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%' ORDER BY name`)
    .all() as { name: string }[]).map((t) => t.name);
  console.log("== table counts ==");
  for (const t of tables) {
    const c = (db.query(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number }).c;
    console.log(`${t}: ${c}`);
  }

  const last500 = db
    .query("SELECT createdAt, provider, model, latencyMs, status FROM InteractionLog ORDER BY rowid DESC LIMIT 500")
    .all() as { createdAt: string; provider: string | null; model: string | null; latencyMs: number | null; status: string }[];
  const ok = last500.filter((r) => r.status === "ok");
  const bad = last500.filter((r) => r.status !== "ok");
  console.log("\n== last-500-row window ==");
  console.log(
    `rows: ${last500.length} · ok: ${ok.length} · not-ok: ${bad.length}${bad.length ? " (" + [...new Set(bad.map((b) => b.status))].join(",") + ")" : ""}`
  );
  const lat = ok.map((r) => r.latencyMs).filter((n): n is number => typeof n === "number").sort((a, b) => a - b);
  if (lat.length) {
    const pick = (q: number) => lat[Math.min(lat.length - 1, Math.floor(q * (lat.length - 1)))];
    console.log(`ok-latency n=${lat.length}: p50 ${pick(0.5)}ms · p95 ${pick(0.95)}ms · max ${lat[lat.length - 1]}ms`);
  }
  const byModel: Record<string, { n: number; sum: number; max: number }> = {};
  for (const r of last500) {
    const k = `${r.provider ?? "?"} / ${r.model ?? "?"}`;
    const g = (byModel[k] ??= { n: 0, sum: 0, max: 0 });
    g.n++;
    const l = typeof r.latencyMs === "number" ? r.latencyMs : 0;
    g.sum += l;
    if (l > g.max) g.max = l;
  }
  console.log("\n== last-500 by provider/model ==");
  for (const [k, g] of Object.entries(byModel).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${k}: n=${g.n} avg=${Math.round(g.sum / g.n)}ms max=${g.max}ms`);
  }
  const newest = last500[0];
  const oldest = last500[last500.length - 1];
  console.log(`\nwindow createdAt span: ${oldest?.createdAt} -> ${newest?.createdAt}`);
  const today = (db.query(`SELECT COUNT(*) c FROM InteractionLog WHERE createdAt LIKE '2026-10-29%'`).get() as { c: number }).c;
  console.log(`InteractionLog rows createdAt LIKE '2026-10-29%': ${today}`);
} finally {
  db.close();
}
