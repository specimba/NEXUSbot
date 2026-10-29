/**
 * cron-failure-attitude-audit.ts (v36.1) — standing guard on the FAILURE PATH.
 *
 * Owner complaint (2026-10-28): "attitude and random connection traffic
 * errors in responses". Two jobs:
 *
 *   A) TEMPLATE AUDIT (hard-fail): every STATIC_FLOOR_LINES entry in
 *      src/lib/brain/cortex.ts must carry ZERO infra vocabulary (hatlar,
 *      bağlantı, sunucu, cereyan, üreteme, kesik, kapalı…) and must invite a
 *      retry. The v29.17 bank told viewers the machine's truth ("Cevap
 *      hatları şu an kesik"); v36.1 speaks NEXUS's truth in persona. This
 *      script keeps that from regressing — exit 1 pages the cron lane.
 *   B) LANE TELEMETRY (report): 24h traffic-tail numbers — provider mix,
 *      latency bands, static-floor hits + their residual infra-speak, and
 *      the edge-win flat band. This is the standing "random connection
 *      traffic error" metric for the 4h cron.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const db = new PrismaClient();

// Forbidden viewer-facing infra vocabulary. Word-boundary "hat\b" catches
// the standalone infra word ("hat" = phone line) without flagging "hatırla…"
// or "hata" (Turkish ı/a are word chars, so \b only fires after ASCII t).
const INFRA_FORBIDDEN_RE =
  /hat(?:lar(?:ı|ın)?|\b)|cereyan|bağlant|sunucu|sistem\b|üreteme|zaman aşımı|timeout|kesik|kapalı|dönünce|hata\b/i;
const RETRY_INVITE_RE = /tekrar|yeniden|dene/i;
const MAX_LINE_LEN = 130;

function auditTemplates(): number {
  const src = readFileSync(join(process.cwd(), "src/lib/brain/cortex.ts"), "utf8");
  const m = src.match(/const STATIC_FLOOR_LINES = \[([\s\S]*?)\];/);
  if (!m) {
    console.error("FAIL: STATIC_FLOOR_LINES block not found in cortex.ts");
    return 1;
  }
  const lines = (m[1].match(/"([^"]+)"/g) ?? []).map((s) => s.slice(1, -1));
  let bad = 0;
  console.log(`--- A) floor template audit (${lines.length} lines) ---`);
  if (lines.length < 4) {
    console.error(`FAIL: floor bank shrunk to ${lines.length} lines (need ≥4 for rotation)`);
    bad++;
  }
  for (const line of lines) {
    const hits = line.match(INFRA_FORBIDDEN_RE);
    const long = line.length > MAX_LINE_LEN;
    const noRetry = !RETRY_INVITE_RE.test(line);
    if (hits || long || noRetry) {
      bad++;
      console.error(`FAIL  ${JSON.stringify(line)}`);
      if (hits) console.error(`      infra vocab: ${JSON.stringify(hits[0])}`);
      if (long) console.error(`      too long: ${line.length} > ${MAX_LINE_LEN}`);
      if (noRetry) console.error("      no retry invite (tekrar/yeniden/dene)");
    } else {
      console.log(`PASS  ${line}`);
    }
  }
  if (!/lastStaticFloorIdx/.test(src)) {
    console.error("FAIL: pickStaticFloorLine no-immediate-repeat mechanism missing");
    bad++;
  }
  return bad;
}

async function laneTelemetry(): Promise<void> {
  const since = new Date(Date.now() - 24 * 3600_000);
  const rows = await db.interactionLog.findMany({
    where: { createdAt: { gte: since }, command: "ai" },
    select: { provider: true, latencyMs: true, response: true, createdAt: true },
  });
  console.log(`\n--- B) lane telemetry 24h (n=${rows.length}) ---`);
  const byProv = new Map<string, number>();
  for (const r of rows) byProv.set(r.provider || "?", (byProv.get(r.provider || "?") || 0) + 1);
  console.log("mix:", JSON.stringify([...byProv.entries()].sort((a, b) => b[1] - a[1])));

  const lats = rows.filter((r) => r.latencyMs).map((r) => r.latencyMs!).sort((a, b) => a - b);
  if (lats.length) {
    const p50 = lats[Math.floor(lats.length / 2)];
    const p90 = lats[Math.min(lats.length - 1, Math.floor(lats.length * 0.9))];
    const slow = lats.filter((l) => l > 12000).length;
    console.log(`latency: p50=${p50}ms p90=${p90}ms >12s=${slow}/${lats.length} (${((100 * slow) / lats.length).toFixed(1)}%)`);
  }

  const stat = rows.filter((r) => (r.provider || "") === "static");
  const statLeak = stat.filter((r) => INFRA_FORBIDDEN_RE.test(r.response || "")).length;
  console.log(`static-floor: hits=${stat.length} residual-infra-speak=${statLeak} (pre-2026-10-28 rows are v29.17 bank)`);

  const edge = rows.filter((r) => (r.provider || "") === "edge" && r.latencyMs);
  if (edge.length) {
    const el = edge.map((r) => r.latencyMs!).sort((a, b) => a - b);
    console.log(
      `edge-win flat band: n=${el.length} min=${el[0]}ms mean=${Math.round(el.reduce((s, v) => s + v, 0) / el.length)}ms max=${el[el.length - 1]}ms (5s of each = deliberate vyce lead-burn)`,
    );
  }
}

async function main(): Promise<void> {
  const bad = auditTemplates();
  await laneTelemetry();
  if (bad > 0) {
    console.error(`\nAUDIT FAILED: ${bad} template violation(s)`);
    process.exitCode = 1;
  } else {
    console.log("\nAUDIT OK: floor bank clean, telemetry above.");
  }
}
main().finally(() => process.exit(process.exitCode ?? 0));
