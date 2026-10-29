/**
 * v37.2 probe — live E2E: refresh all 6 bench kinds through the new
 * TinyFish residential-proxy rung + table parser. MEASURED evidence only.
 */
import { refreshBenchmark } from "../src/lib/benchmarks";

async function main() {
  const kinds = [
    "arena-chat",
    "arena-chat-non-english",
    "arena-chat-multi-turn",
    "arena-agent",
    "arena-agent-alignment",
    "aa-index",
  ] as const;
  for (const kind of kinds) {
    const t0 = Date.now();
    const res = await refreshBenchmark(kind, "probe-v372");
    console.log(
      `${kind}: ok=${res.ok} via=${res.ok ? res.via : "-"} models=${res.ok ? res.modelCount : 0} ` +
      `err=${res.ok ? "-" : res.error?.code} took=${((Date.now() - t0) / 1000).toFixed(1)}s`
    );
    if (res.ok && res.entries) console.log(`   #1: ${res.entries[0].model} = ${res.entries[0].score}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error("PROBE FAIL:", e.message); process.exit(1); });
