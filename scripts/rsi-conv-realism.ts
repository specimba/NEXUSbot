/**
 * v36 RSI cycle driver — conversation-realism (owner directive 2026-10-29:
 * "intelligence and eval — RSI upgrades with better realistic conversation
 * system").
 *
 * Runs the full gated L4 loop for the realism thesis through the lab's OWN
 * machinery (engine.ts stage functions — no shortcuts, no bypasses):
 *
 *   scout → thesis → synthesize (z-ai drafts the prompt-delta plugin, G3-capped)
 *         → shadow-eval (paired baseline/candidate legs on
 *           conversation-realism-tr + persona-tr + safety-refusal)
 *         → pareto-gate (G1 non-regression / G2 Pareto / G3 / G5 / G7)
 *         → canary (one live candidate-side call)
 *
 * and STOPS at PROMOTE — the OWNER HUMAN GATE. Nothing after canary is touched,
 * nothing deploys. If a gate rejects the candidate, the honest numbers stay on
 * the cycle ledger as negative evidence (that is the lab working as designed).
 *
 * RESUMABLE: re-attaches to an existing non-terminal cycle-2 (the engine's own
 * stage statuses are the source of truth — the driver never re-creates a live
 * cycle). z-ai 429 backoff at synthesize (the gateway throttles bursts).
 *
 * Usage: bun scripts/rsi-conv-realism.ts [--no-run]   (--no-run = seed+verify only)
 */

import { db } from "@/lib/db";
import { ensurePapersSeeded, ensureSuitesSeeded } from "@/lib/rsi/seed";
import { createCycle, advanceCycle, type AdvanceBody, type AdvanceResult } from "@/lib/rsi/engine";
import { rsiBudgetState } from "@/lib/rsi/budget";

const CYCLE_NAME = "cycle-2 conversation-realism-v36";
const THESIS = [
  "Canlı sohbet gerçekçiliğimiz dört ölçülür zayıf eksende: (1) açılış tekrarı — art arda cevaplar aynı kelimeyle başlıyor ('Kanka' bağımlılığı),",
  "(2) roast/troll mesajlara kurumsal-uyumlu ton ('üzgünüm' sınıfı), (3) uzunlukta kalibrasyon eksikliği — tek kelimelik mesaja abartılı cevap,",
  "soruya yüzeysel cevap, (4) sohbetin konusuna bağlanmama. Hipotez: açılış-çeşitliliği kuralı + birkaç satırlık few-shot banter örneği +",
  "uzunluk kalibrasyonu içeren KISA bir persona prompt-deltası conversation-realism-tr bileşik skorunu yükseltir VE persona-tr ile",
  "safety-refusal non-regression eşiklerini bozmaz. Ölçüm: paired shadow-eval (baseline vs candidate), G1/G2 kapıları.",
].join(" ");
const MODULE = "persona";
const TECHNIQUE_REFS = ["2609.24972", "2610.26770", "2609.12191"];
const SHADOW_SUITES = ["conversation-realism-tr", "persona-tr", "safety-refusal"];

const TERMINAL = new Set(["adopted", "rejected", "aborted"]);
const BATTERY_TIMEOUT_MS = 30 * 60_000;

function log(...args: unknown[]): void {
  console.log(`[conv-rsi ${new Date().toISOString().slice(11, 19)}]`, ...args);
}

function fmt(n: number | null | undefined): string {
  return typeof n === "number" ? n.toFixed(3) : "n/a";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function step(cycleId: string, body: AdvanceBody, label: string): Promise<AdvanceResult> {
  const res = await advanceCycle(cycleId, body);
  if (res.ok) {
    log(label, "OK → status:", res.cycle.status, res.note ?? "");
  } else {
    log(label, "FAILED:", res.code, "—", res.message);
  }
  return res;
}

async function readCycle(cycleId: string) {
  return db.rsiCycle.findUnique({ where: { id: cycleId } });
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  try {
    return JSON.parse(text || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

type Scratch = {
  runs?: Array<{ id: string; suiteId: string; suiteKey: string; variant: string; status: string }>;
} & Record<string, unknown>;

async function pollBattery(cycleId: string): Promise<"settled" | "timeout"> {
  const deadline = Date.now() + BATTERY_TIMEOUT_MS;
  for (;;) {
    const cycle = await readCycle(cycleId);
    const runsScratch = parseJson<Scratch>(cycle?.stageData, {}).runs ?? [];
    if (runsScratch.length === 0) return "timeout";
    const live = await db.rsiRun.findMany({ where: { id: { in: runsScratch.map((r) => r.id) } } });
    const byId = new Map(live.map((r) => [r.id, r]));
    const view = runsScratch.map((r) => ({ key: r.suiteKey, v: r.variant, s: byId.get(r.id)?.status ?? "missing" }));
    const settled = view.filter((r) => r.s === "done" || r.s === "error" || r.s === "missing");
    log(`battery ${settled.length}/${view.length} — ${view.map((r) => `${r.key}:${r.v.slice(0, 4)}:${r.s}`).join(" | ")}`);
    if (settled.length === view.length) return "settled";
    if (Date.now() > deadline) return "timeout";
    await sleep(20_000);
  }
}

async function reportFinal(cycleId: string, status: string): Promise<void> {
  const cycle = await readCycle(cycleId);
  if (!cycle) return;
  const gates = parseJson<{
    input?: {
      suites?: Array<{
        suiteKey: string;
        baseComposite: number | null;
        candComposite: number | null;
        basePass: number | null;
        candPass: number | null;
        baseCost: number | null;
        candCost: number | null;
      }>;
    };
    g1?: { numbers?: { perSuite?: Array<{ suite: string; delta: number; epsilon: number; pass: boolean }> } };
  }>(cycle.gateResults, {});

  log("=== FINAL PAIRED NUMBERS (all live-measured) ===");
  for (const s of gates.input?.suites ?? []) {
    const delta = (s.candComposite ?? 0) - (s.baseComposite ?? 0);
    log(
      `${s.suiteKey}: composite ${fmt(s.baseComposite)} → ${fmt(s.candComposite)} (Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}) | pass ${fmt(s.basePass)} → ${fmt(s.candPass)} | cost ${fmt(s.baseCost)} → ${fmt(s.candCost)}`,
    );
  }
  for (const v of gates.g1?.numbers?.perSuite ?? []) {
    log(`G1 ${v.suite}: Δ=${v.delta.toFixed(3)} vs ε=${v.epsilon} → ${v.pass ? "PASS" : "FAIL"}`);
  }
  log(`cycle status: ${status}`);
}

async function main(): Promise<void> {
  const noRun = process.argv.includes("--no-run");

  // ---------------------------------------------------------------- 0) seed
  await ensurePapersSeeded();
  const suiteCount = await ensureSuitesSeeded();
  const conv = await db.rsiSuite.findUnique({
    where: { key: "conversation-realism-tr" },
    include: { tasks: true },
  });
  if (!conv) throw new Error("conversation-realism-tr missing after seeding");
  log(`suites seeded: ${suiteCount}; conversation-realism-tr tasks: ${conv.tasks.length}`);
  if (noRun) {
    log("--no-run: seed+verify complete, stopping here.");
    return;
  }

  // ----------------------------------------------------------- 1) pre-flight
  const budget = await rsiBudgetState();
  log(`budget today: ${budget.used}/${budget.cap} (remaining ${budget.remaining}, day ${budget.day})`);
  if (!budget.ok) throw new Error("budget_exceeded before start — the engine never truncates silently");

  // ------------------------------------- 2) resume or create the cycle
  let cycleId: string;
  const parked = await db.rsiCycle.findFirst({
    where: { name: CYCLE_NAME, status: { notIn: [...TERMINAL] } },
    orderBy: { createdAt: "desc" },
  });
  if (parked) {
    cycleId = parked.id;
    log(`RESUMING existing cycle ${cycleId} (status: ${parked.status})`);
  } else {
    const created = await createCycle({
      name: CYCLE_NAME,
      thesis: THESIS,
      module: MODULE,
      techniqueRefs: TECHNIQUE_REFS,
    });
    if (!created.ok) throw new Error(`createCycle failed: ${created.code} ${created.message}`);
    cycleId = created.cycle.id;
    log(`cycle created: ${cycleId} ("${CYCLE_NAME}")`);
  }

  // ------------------------------------------------- 3) stage state machine
  for (;;) {
    const cycle = await readCycle(cycleId);
    if (!cycle) throw new Error("cycle row vanished");
    const status = cycle.status;

    if (TERMINAL.has(status)) {
      await reportFinal(cycleId, status);
      log("cycle reached a terminal state — honest evidence recorded on the chain.");
      return;
    }
    if (status === "promote") {
      await reportFinal(cycleId, status);
      log("cycle is PARKED AT PROMOTE — the OWNER HUMAN GATE.");
      log("promote from the panel: RSI Lab → Cycles → cycle-2 → Advance (confirm) — deploy stays a manual Edge Cortex Deploy action.");
      return;
    }

    switch (status) {
      case "scout": {
        const res = await step(cycleId, {}, "SCOUT");
        if (!res.ok) throw new Error("scout failed");
        break;
      }
      case "thesis": {
        const res = await step(cycleId, {}, "THESIS");
        if (!res.ok) throw new Error("thesis rejected/failed");
        break;
      }
      case "synthesize": {
        // z-ai drafts the plugin — the gateway throttles bursts (429), so back
        // off patiently; every attempt is budget-counted by the engine itself.
        for (let attempt = 1; ; attempt++) {
          const res = await advanceCycle(cycleId, {});
          if (res.ok) {
            log(`SYNTHESIZE OK on attempt ${attempt} → status: ${res.cycle.status}`);
            break;
          }
          if (res.code === "BUDGET_EXCEEDED") throw new Error("budget exhausted at synthesize");
          if (res.code !== "SYNTH_UNPARSEABLE") {
            throw new Error(`synthesize failed: ${res.code} — ${res.message}`);
          }
          if (attempt >= 5) throw new Error("synthesize never parsed a plugin JSON in 5 attempts");
          const waitMs = Math.min(60_000, 20_000 * attempt);
          log(`synthesize attempt ${attempt} unparseable (likely z-ai 429) — backing off ${waitMs / 1000}s`);
          await sleep(waitMs);
        }
        const afterSynth = await readCycle(cycleId);
        const pluginRow = afterSynth?.pluginId
          ? await db.rsiPlugin.findUnique({ where: { id: afterSynth.pluginId } })
          : null;
        const payload = parseJson<{ promptDelta?: string; notes?: string }>(pluginRow?.payload, {});
        log(`plugin drafted: "${pluginRow?.name}" (${payload.promptDelta?.length ?? 0} chars)`);
        log(`promptDelta >>>\n${payload.promptDelta ?? "(none)"}\n<<<`);
        break;
      }
      case "shadow-eval": {
        const scratch = parseJson<Scratch>(cycle.stageData, {});
        if ((scratch.runs ?? []).length === 0) {
          const kick = await step(cycleId, { suiteIds: SHADOW_SUITES }, "SHADOW-EVAL kick");
          if (!kick.ok) throw new Error("shadow-eval kick failed");
        }
        let poll = await pollBattery(cycleId);
        if (poll === "timeout") throw new Error("paired battery did not settle within 30 min");
        let complete = await step(cycleId, {}, "SHADOW-EVAL complete");
        if (!complete.ok && complete.code === "SHADOW_RUN_ERROR") {
          log("SHADOW_RUN_ERROR — honest salvage: clearing the runs scratch and re-kicking ONE fresh battery");
          const fresh = await readCycle(cycleId);
          const clean = parseJson<Scratch>(fresh?.stageData, {});
          delete clean.runs;
          await db.rsiCycle.update({ where: { id: cycleId }, data: { stageData: JSON.stringify(clean) } });
          const rekick = await step(cycleId, { suiteIds: SHADOW_SUITES }, "SHADOW-EVAL re-kick");
          if (!rekick.ok) throw new Error(`re-kick failed: ${rekick.code}`);
          poll = await pollBattery(cycleId);
          if (poll === "timeout") throw new Error("salvage battery did not settle within 30 min");
          complete = await step(cycleId, {}, "SHADOW-EVAL complete");
        }
        if (!complete.ok) throw new Error(`shadow-eval complete failed: ${complete.code} — ${complete.message}`);
        break;
      }
      case "pareto-gate": {
        const res = await step(cycleId, {}, "PARETO-GATE");
        if (!res.ok) throw new Error(`pareto-gate crashed: ${res.code} — ${res.message}`);
        const gates = parseJson<Record<string, { pass?: boolean; note?: string }>>(
          (await readCycle(cycleId))?.gateResults,
          {},
        );
        for (const g of ["g1", "g2", "g3", "g5", "g7"]) {
          log(`gate ${g.toUpperCase()}: pass=${gates[g]?.pass ?? false} ${gates[g]?.note ?? ""}`);
        }
        break;
      }
      case "canary": {
        const res = await step(cycleId, {}, "CANARY");
        if (!res.ok) throw new Error(`canary crashed: ${res.code} — ${res.message}`);
        const afterCanary = await readCycle(cycleId);
        if (TERMINAL.has(afterCanary?.status ?? "")) {
          await reportFinal(cycleId, afterCanary?.status);
          log("canary incident — candidate rolled back, cycle rejected with honest numbers.");
          return;
        }
        break;
      }
      default:
        throw new Error(`unexpected cycle status "${status}"`);
    }
  }
}

main()
  .then(() => db.$disconnect())
  .catch(async (e: unknown) => {
    console.error("[conv-rsi FATAL]", e);
    await db.$disconnect().catch(() => undefined);
    process.exit(1);
  });
