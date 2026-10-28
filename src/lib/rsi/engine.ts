import { db } from "@/lib/db";
import type { RsiCycle, RsiCycleEvent } from "@prisma/client";
import { listResearchJobs } from "@/lib/brain/deep-research";
import { chainHash, GENESIS_HASH } from "./hash";
import { rsiBudgetState, recordRsiCall } from "./budget";
import { rsiSingleShot, startRun, currentBaselinePersona } from "./runner";
import { recomputeSuiteHash } from "./seed";
import { verifyTask } from "./verifiers";
import {
  BUDGET_SYNTH_MAX_CALLS,
  DEFAULT_SHADOW_SUITES,
  G1_EPSILON,
  G2_COST_TOLERANCE,
  G2_EPS_PERF,
  G3_DELTA_MAX,
  G3_DELTA_MAX_CHARS,
  G3_DELTA_MAX_RATIO,
  RSI_STAGES,
  RSI_TERMINAL,
  THESIS_MODULES,
  type RsiStage,
} from "./constants";

/**
 * v35 RSI Lab — the L4 cycle state machine (9 stages, hash-chained ledger).
 *
 * Spine (evolution-engine.json cycleStages):
 *   scout → thesis → synthesize → shadow-eval → pareto-gate → canary →
 *   promote → audit → record, terminal adopted | rejected | aborted.
 *
 * Constitution invariants enforced here:
 * - PROMOTE is an OWNER HUMAN GATE: requires body {confirm:true} and all
 *   computable gates green; adoption is RECORDED ONLY — deploy remains a
 *   manual Edge Cortex Deploy action. Nothing auto-deploys, ever.
 * - Every stage appends a hash-chained event (sha256 chain, replay-verified
 *   at AUDIT); rejected cycles keep ALL numbers as negative evidence.
 * - Budget caps are G7 inputs; breaches abort loudly, never silently.
 */

// ---------------------------------------------------------------------------
// Event ledger (append-only hash chain)
// ---------------------------------------------------------------------------

export async function appendCycleEvent(
  cycleId: string,
  stage: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<RsiCycleEvent> {
  const last = await db.rsiCycleEvent.findFirst({ where: { cycleId }, orderBy: { seq: "desc" } });
  const seq = (last?.seq ?? -1) + 1;
  const prevHash = last?.hash ?? GENESIS_HASH;
  const hash = chainHash(prevHash, { stage, type, payload });
  return db.rsiCycleEvent.create({
    data: { cycleId, seq, stage, type, payload: JSON.stringify(payload).slice(0, 60_000), prevHash, hash },
  });
}

export type ChainVerification = {
  ok: boolean;
  events: number;
  firstBadSeq: number | null;
  lastHash: string | null;
};

/** Replay the whole chain: recompute every hash. O(n), zero secrets. */
export async function verifyCycleChain(cycleId: string): Promise<ChainVerification> {
  const events = await db.rsiCycleEvent.findMany({ where: { cycleId }, orderBy: { seq: "asc" } });
  let prev = GENESIS_HASH;
  let lastHash: string | null = null;
  for (const ev of events) {
    const expected = chainHash(ev.prevHash, {
      stage: ev.stage,
      type: ev.type,
      payload: JSON.parse(ev.payload || "{}"),
    });
    const linkOk = ev.prevHash === prev && ev.hash === expected;
    if (!linkOk) return { ok: false, events: events.length, firstBadSeq: ev.seq, lastHash };
    prev = ev.hash;
    lastHash = ev.hash;
  }
  return { ok: true, events: events.length, firstBadSeq: null, lastHash };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AdvanceBody = {
  suiteIds?: string[];
  confirm?: boolean;
  researchJobId?: string;
};

export type AdvanceResult =
  | { ok: true; cycle: RsiCycle; event?: RsiCycleEvent; pending?: boolean; runs?: Array<{ id: string; status: string; variant: string }>; note?: string }
  | { ok: false; code: string; message: string; cycle?: RsiCycle };

type StageData = {
  module?: string;
  researchJobId?: string;
  pluginId?: string;
  promptDeltaDistance?: number;
  synthCalls?: number;
  runs?: Array<{ id: string; suiteId: string; suiteKey: string; variant: "baseline" | "candidate"; status: string }>;
  canary?: Record<string, unknown>;
  [k: string]: unknown;
};

function readJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

// One advance at a time per cycle (cheap honest lock — seq collisions).
const inFlight = new Set<string>();

// ---------------------------------------------------------------------------
// advanceCycle — the state machine
// ---------------------------------------------------------------------------

export async function advanceCycle(cycleId: string, body: AdvanceBody = {}): Promise<AdvanceResult> {
  if (inFlight.has(cycleId)) {
    return { ok: false, code: "CYCLE_BUSY", message: "another advance is still running on this cycle — retry in a moment" };
  }
  inFlight.add(cycleId);
  try {
    const cycle = await db.rsiCycle.findUnique({ where: { id: cycleId } });
    if (!cycle) return { ok: false, code: "NOT_FOUND", message: "cycle not found" };
    const status = cycle.status;
    if ((RSI_TERMINAL as readonly string[]).includes(status)) {
      return {
        ok: false,
        code: "CYCLE_TERMINAL",
        message: `cycle is terminal (${status}) — start a new cycle for the next hypothesis`,
        cycle,
      };
    }
    if (!(RSI_STAGES as readonly string[]).includes(status)) {
      return { ok: false, code: "BAD_STATUS", message: `unknown cycle status "${status}"`, cycle };
    }
    switch (status as RsiStage) {
      case "scout":
        return await stageScout(cycle, body);
      case "thesis":
        return await stageThesis(cycle);
      case "synthesize":
        return await stageSynthesize(cycle);
      case "shadow-eval":
        return await stageShadowEval(cycle, body);
      case "pareto-gate":
        return await stageParetoGate(cycle);
      case "canary":
        return await stageCanary(cycle);
      case "promote":
        return await stagePromote(cycle, body);
      case "audit":
        return await stageAudit(cycle);
      case "record":
        return await stageRecord(cycle);
      default:
        return { ok: false, code: "BAD_STAGE", message: `unhandled stage ${status}`, cycle };
    }
  } finally {
    inFlight.delete(cycleId);
  }
}

async function moveTo(cycleId: string, status: string): Promise<RsiCycle> {
  return db.rsiCycle.update({ where: { id: cycleId }, data: { status } });
}

async function rejectCycle(cycle: RsiCycle, stage: string, reason: string, numbers: Record<string, unknown>): Promise<AdvanceResult> {
  const event = await appendCycleEvent(cycle.id, stage, "cycle-rejected", { reason, ...numbers });
  const updated = await moveTo(cycle.id, "rejected");
  // Negative-evidence plugin handling: an active plugin from this cycle is
  // demoted honestly (it never passed its gates).
  if (cycle.pluginId) {
    const plugin = await db.rsiPlugin.findUnique({ where: { id: cycle.pluginId } });
    if (plugin && plugin.status === "active") {
      await db.rsiPlugin.update({ where: { id: plugin.id }, data: { status: "rejected" } });
    }
  }
  return { ok: true, cycle: updated, event, note: `cycle rejected: ${reason}` };
}

// ---------------------------------------------------------------------------
// STAGE 1 — SCOUT: mine real failure evidence (zero LLM calls)
// ---------------------------------------------------------------------------

async function stageScout(cycle: RsiCycle, body: AdvanceBody): Promise<AdvanceResult> {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const [flagged, latencyOutliers, fallbackRoutes, lessons, lessonRows, jobs] = await Promise.all([
    db.interactionLog.count({ where: { createdAt: { gte: since }, flags: { not: "[]" } } }),
    db.interactionLog.count({ where: { createdAt: { gte: since }, latencyMs: { gte: 10_000 } } }),
    db.interactionLog.count({ where: { createdAt: { gte: since }, route: { contains: "fallback" } } }),
    db.securityLesson.count(),
    db.securityLesson.findMany({ orderBy: { lastSeenAt: "desc" }, take: 5 }),
    listResearchJobs(),
  ]);
  const lessonHits = lessonRows.reduce((s, l) => s + l.hits, 0);
  const researchJobs = jobs.slice(0, 5).map((j) => ({ id: j.id, query: j.query.slice(0, 80), status: j.status }));

  let researchJobNote = "no external research job attached";
  if (body.researchJobId) {
    const job = jobs.find((j) => j.id === body.researchJobId);
    researchJobNote = job
      ? `attached owner research job ${job.id} (status ${job.status})`
      : `research job id "${body.researchJobId}" NOT found in the ledger — recorded, not assumed`;
  }

  const event = await appendCycleEvent(cycle.id, "scout", "scout-brief", {
    flaggedLast7d: flagged,
    latencyOutliersLast7d: latencyOutliers,
    fallbackRoutesLast7d: fallbackRoutes,
    securityLessons: lessons,
    securityLessonHits: lessonHits,
    researchJobs,
    researchJobId: body.researchJobId ?? null,
    researchJobNote,
    evidenceNote:
      flagged + latencyOutliers + fallbackRoutes < 5
        ? `thin live evidence (${flagged + latencyOutliers + fallbackRoutes} rows in 7d) — the owner thesis carries this cycle; nothing is fabricated to pad the brief`
        : `live evidence rows in 7d: ${flagged + latencyOutliers + fallbackRoutes}`,
  });
  const updated = await moveTo(cycle.id, "thesis");
  return { ok: true, cycle: updated, event };
}

// ---------------------------------------------------------------------------
// STAGE 2 — THESIS: validate the owner-entered falsifiable claim (0 calls)
// ---------------------------------------------------------------------------

async function stageThesis(cycle: RsiCycle): Promise<AdvanceResult> {
  const stageData = readJson<StageData>(cycle.stageData, {});
  const thesis = cycle.thesis.trim();
  const moduleScope = String(stageData.module ?? "");
  if (thesis.length < 12) {
    return rejectCycle(cycle, "thesis", "bad-thesis: shorter than 12 chars (unfalsifiable)", { thesisChars: thesis.length });
  }
  if (!(THESIS_MODULES as readonly string[]).includes(moduleScope)) {
    return rejectCycle(cycle, "thesis", `bad-thesis: module "${moduleScope}" is not one of persona|routing|guard|tool-config|code`, {
      module: moduleScope,
    });
  }
  // Duplicate-thesis check against the rejected-cycles ledger (negative
  // evidence: no retry without new evidence).
  const dup = await db.rsiCycle.findFirst({
    where: { thesis: cycle.thesis, status: "rejected" },
    orderBy: { updatedAt: "desc" },
  });
  if (dup && dup.id !== cycle.id) {
    return rejectCycle(cycle, "thesis", "duplicate-thesis: exact thesis already rejected by an earlier cycle", {
      rejectedCycleId: dup.id,
      rejectedCycleName: dup.name,
      rejectedAt: dup.updatedAt.toISOString(),
    });
  }
  const event = await appendCycleEvent(cycle.id, "thesis", "thesis-validated", {
    thesis,
    module: moduleScope,
    techniqueRefs: readJson<string[]>(cycle.techniqueRefs, []),
    verdict: "one module, falsifiable, not a duplicate — pass to synthesize",
  });
  const updated = await moveTo(cycle.id, "synthesize");
  return { ok: true, cycle: updated, event };
}

// ---------------------------------------------------------------------------
// STAGE 3 — SYNTHESIZE: draft the prompt-delta plugin (1-2 z-ai calls, capped)
// ---------------------------------------------------------------------------

type SynthPlugin = { name: string; promptDelta: string; notes: string; inspirationArxiv: string[] };

async function zaiSynthesize(prompt: string, strictRetry: boolean): Promise<{ ok: boolean; text: string; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    const { default: ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    const res = (await zai.chat.completions.create({
      messages: [
        {
          role: "system",
          content: strictRetry
            ? "Sen bir harness-muhendisisin. Cevabin SADECE gecerli bir JSON objesi olacak — aciklama, markdown, kod blogu YOK."
            : "Sen bir harness-muhendisisin. Cevabinda gecerli bir JSON objesi bulunmali.",
        },
        { role: "user", content: prompt },
      ],
    })) as { choices?: Array<{ message?: { content?: unknown } }> };
    const raw =
      typeof res?.choices?.[0]?.message?.content === "string"
        ? res.choices[0].message.content
        : Array.isArray(res?.choices?.[0]?.message?.content)
          ? (res.choices[0].message.content as Array<{ text?: string }>).map((c) => c?.text ?? "").join(" ")
          : "";
    return { ok: raw.trim().length > 0, text: raw, latencyMs: Date.now() - started };
  } catch (e) {
    return { ok: false, text: "", latencyMs: Date.now() - started, error: e instanceof Error ? e.message.slice(0, 160) : "synth call failed" };
  }
}

/** Extract the first balanced JSON object from model text (defensive). */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1)) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function stageSynthesize(cycle: RsiCycle): Promise<AdvanceResult> {
  const stageData = readJson<StageData>(cycle.stageData, {});
  const refs = readJson<string[]>(cycle.techniqueRefs, []);

  // Resolve technique refs against the paper library (owner corpus).
  const papers = refs.length > 0 ? await db.rsiPaper.findMany({ where: { arxivId: { in: refs } } }) : [];
  const techniqueBlock =
    papers.length > 0
      ? papers.map((p) => `- ${p.title} (${p.arxivId}): ${p.oneLine} | technique: ${p.keyTechnique} | applies: ${p.appliesTo}`).join("\n")
      : refs.length > 0
        ? refs.map((r) => `- arXiv:${r} (not in the local paper library — no invented summary)`).join("\n")
        : "- (no technique refs selected — synthesize from the thesis alone)";
  const unknownRefs = refs.filter((r) => !papers.some((p) => p.arxivId === r));

  const adopted = await db.rsiPlugin.findMany({ where: { status: "adopted" } });
  const adoptedLedger =
    adopted.length > 0
      ? adopted.map((p) => `- ${p.name}: ${p.description}`).join("\n")
      : "(no adopted plugins yet — clean slate)";

  const prompt = [
    "GOREV: NEXUS OS sohbet botununun personasini (VYCE) gelistiren KUCUK, geri alinabilir bir prompt-deltasi yaz.",
    "TEZ (sahibi yazdi):",
    cycle.thesis,
    "",
    "TEKNIK KAYNAKLARI (arXiv ozetlerinden):",
    techniqueBlock,
    "",
    "MEVCUT BASELINE PERSONA (degistirilecek metin degil — delta buna EKLENECEK):",
    cycle.baselineSnapshot.slice(0, 4000),
    "",
    "ADOPTE EDILMIS PLUGIN LEDGERI (yenilerini bunlarla cakistirma):",
    adoptedLedger,
    "",
    "KISITLAR: Delta persona metnine sona eklenecek KISA bir metin olmali (en fazla 1200 karakter). Tek bir modul hedefler. Turksce. Emoji YASAK.",
    "CIKTI: JSON objesi — alanlar: name (kisa plugin adi), promptDelta (persona sonuna eklenecek Turkce metin), notes (1-2 cumle gerekce), inspirationArxiv (arxiv id dizisi).",
  ].join("\n");

  // Budget-capped 1-2 calls; every call is telemetry-counted.
  let calls = 0;
  let parsed: Record<string, unknown> | null = null;
  let lastError = "";
  for (let attempt = 1; attempt <= BUDGET_SYNTH_MAX_CALLS; attempt++) {
    const budget = await rsiBudgetState();
    if (!budget.ok) {
      return {
        ok: false,
        code: "BUDGET_EXCEEDED",
        message: `budget_exceeded: daily cap ${budget.cap} reached (${budget.used} used) — synthesize aborted loudly, cycle stays at this stage`,
        cycle,
      };
    }
    const res = await zaiSynthesize(prompt, attempt > 1);
    calls += 1;
    void recordRsiCall({
      cycleId: cycle.id,
      call: "synthesize",
      provider: "z-ai",
      modelId: "z-ai-synth",
      latencyMs: res.latencyMs,
      ok: res.ok,
      error: res.ok ? undefined : "SYNTH_CALL_FAILED",
    });
    if (res.ok) {
      parsed = extractJsonObject(res.text);
      if (parsed) break;
      lastError = `attempt ${attempt}: model text contained no valid JSON object`;
    } else {
      lastError = res.error ?? "empty model reply";
    }
  }

  if (!parsed) {
    const event = await appendCycleEvent(cycle.id, "synthesize", "synthesize-unparseable", {
      calls,
      error: lastError.slice(0, 300),
      note: "honest failure — no plugin invented; advance again to retry (each retry is budget-counted)",
    });
    void event;
    return {
      ok: false,
      code: "SYNTH_UNPARSEABLE",
      message: `synthesize could not parse a plugin JSON after ${calls} call(s): ${lastError}`,
      cycle,
    };
  }

  const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim().slice(0, 80) : "unnamed-delta";
  const promptDelta = typeof parsed.promptDelta === "string" ? parsed.promptDelta.trim() : "";
  const notes = typeof parsed.notes === "string" ? parsed.notes.trim().slice(0, 400) : "";
  const inspirationArxiv = Array.isArray(parsed.inspirationArxiv)
    ? (parsed.inspirationArxiv as unknown[]).map(String).slice(0, 8)
    : refs.slice(0, 8);

  const deltaChars = promptDelta.length;
  const baseChars = cycle.baselineSnapshot.length;
  const distance = baseChars > 0 ? deltaChars / baseChars : Number.POSITIVE_INFINITY;

  // G3-style regularization (RRSI 2609.24972, spec caps):
  const capByRatio = G3_DELTA_MAX_RATIO * baseChars;
  const overCharCap = deltaChars > G3_DELTA_MAX_CHARS;
  const overRatioCap = deltaChars > capByRatio;
  const overRrsiCap = distance > G3_DELTA_MAX;

  // Persist the plugin BEFORE the cap verdict so rejected drafts keep their
  // real text as negative evidence (status flips below).
  const plugin = await db.rsiPlugin.create({
    data: {
      name,
      kind: "prompt-delta",
      payload: JSON.stringify({ promptDelta, notes, inspirationArxiv }),
      description: notes,
      sourceArxiv: inspirationArxiv[0] ?? "",
      status: "active",
      cycleId: cycle.id,
    },
  });

  if (overCharCap || overRatioCap) {
    await db.rsiPlugin.update({ where: { id: plugin.id }, data: { status: "rejected" } });
    return rejectCycle(cycle, "synthesize", "g3-violation: prompt-delta exceeds the regularization cap", {
      pluginId: plugin.id,
      deltaChars,
      baseChars,
      charCap: G3_DELTA_MAX_CHARS,
      ratioCapChars: Math.round(capByRatio),
      ratioCap: G3_DELTA_MAX_RATIO,
      promptDeltaDistance: Number(distance.toFixed(4)),
    });
  }

  const event = await appendCycleEvent(cycle.id, "synthesize", "plugin-synthesized", {
    pluginId: plugin.id,
    pluginName: name,
    deltaChars,
    baseChars,
    promptDeltaDistance: Number(distance.toFixed(4)),
    g3Precheck: overRrsiCap
      ? `WARN: distance ${distance.toFixed(4)} exceeds the RRSI 0.10 gate cap — G3 will fail at the Pareto gate`
      : "within RRSI 0.10 gate cap",
    synthCalls: calls,
    unknownRefs,
    notes,
  });
  const updated = await db.rsiCycle.update({
    where: { id: cycle.id },
    data: {
      stageData: JSON.stringify({ ...stageData, pluginId: plugin.id, promptDeltaDistance: distance, synthCalls: calls }),
      pluginId: plugin.id,
    },
  });
  const next = await moveTo(cycle.id, "shadow-eval");
  void updated;
  return { ok: true, cycle: next, event };
}

// ---------------------------------------------------------------------------
// STAGE 4 — SHADOW EVAL: kick paired runs, poll until both legs settle
// ---------------------------------------------------------------------------

async function stageShadowEval(cycle: RsiCycle, body: AdvanceBody): Promise<AdvanceResult> {
  const stageData = readJson<StageData>(cycle.stageData, {});

  // Resolve the suite set (frozen keys → rows).
  const keys = (body.suiteIds && body.suiteIds.length > 0 ? body.suiteIds : [...DEFAULT_SHADOW_SUITES]).slice(0, 5);
  const suites = await db.rsiSuite.findMany({ where: { key: { in: keys } } });
  const missing = keys.filter((k) => !suites.some((s) => s.key === k));
  if (suites.length === 0) {
    return { ok: false, code: "NO_SUITES", message: `no frozen suites matched [${keys.join(", ")}]`, cycle };
  }

  const pluginId = cycle.pluginId;
  if (!pluginId) {
    return { ok: false, code: "NO_PLUGIN", message: "cycle has no synthesized plugin — re-run synthesize", cycle };
  }

  // Already-kicked battery: poll its runs instead of double-kicking.
  if ((stageData.runs ?? []).length > 0) {
    const runIds = stageData.runs!.map((r) => r.id);
    const live = await db.rsiRun.findMany({ where: { id: { in: runIds } } });
    const byId = new Map(live.map((r) => [r.id, r]));
    const runsView = stageData.runs!.map((r) => ({ id: r.id, status: byId.get(r.id)?.status ?? "missing", variant: r.variant }));
    const unsettled = runsView.filter((r) => r.status === "queued" || r.status === "running");
    if (unsettled.length > 0) {
      return { ok: true, cycle, pending: true, runs: runsView, note: `${unsettled.length} paired-battery leg(s) still in flight` };
    }
    const errored = runsView.filter((r) => r.status === "error" || r.status === "missing");
    if (errored.length > 0) {
      const errs = live.filter((r) => r.status === "error").map((r) => r.error.slice(0, 120));
      return {
        ok: false,
        code: "SHADOW_RUN_ERROR",
        message: `paired battery failed: ${errs.join(" | ") || "run rows missing"} — advance again to re-kick a fresh battery (budget-counted)`,
        cycle,
      };
    }
    // All legs done: aggregate gate inputs → pareto-gate.
    // Gate inputs MUST be built from the kicked battery's own suite set — the
    // completing advance may carry an empty body (pollers do), and resolving
    // suites from body/defaults here silently narrowed the gate inputs to
    // DEFAULT_SHADOW_SUITES on cycle-2 (conversation-realism-tr's −0.21
    // regression never reached G1/G2; the cycle was rejected on G2/G7 alone).
    const kickedSuiteIds = [...new Set(stageData.runs!.map((r) => r.suiteId))];
    const kickedRows = await db.rsiSuite.findMany({ where: { id: { in: kickedSuiteIds } } });
    const kickedByKey = new Map(kickedRows.map((s) => [s.id, s]));
    const kickedSuites = kickedSuiteIds
      .map((id) => kickedByKey.get(id))
      .filter((s): s is (typeof kickedRows)[number] => Boolean(s));
    if (kickedSuites.length !== kickedSuiteIds.length) {
      // Never silently narrow: a missing frozen suite row is a harness fault.
      return {
        ok: false,
        code: "GATE_INPUT_INCOMPLETE",
        message: `battery kicked on ${kickedSuiteIds.length} suite(s) but only ${kickedSuites.length} frozen rows resolve — refusing to grade a narrowed gate`,
        cycle,
      };
    }
    return await completeShadowEval(cycle, stageData, kickedSuites);
  }

  // Kick the paired battery: baseline + candidate per suite, cycle-linked.
  const kicked: NonNullable<StageData["runs"]> = [];
  for (const suite of suites) {
    for (const variant of ["baseline", "candidate"] as const) {
      const res = await startRun({ suiteId: suite.id, variant, pluginId, cycleId: cycle.id });
      if (!res.ok) {
        return {
          ok: false,
          code: res.code,
          message: `failed to kick ${variant} leg on ${suite.key}: ${res.message}`,
          cycle,
        };
      }
      kicked.push({ id: res.run.id, suiteId: suite.id, suiteKey: suite.key, variant, status: res.run.status });
    }
  }

  const event = await appendCycleEvent(cycle.id, "shadow-eval", "battery-kicked", {
    runs: kicked.map((r) => ({ id: r.id, suite: r.suiteKey, variant: r.variant })),
    suiteKeys: suites.map((s) => s.key),
    missingSuiteKeys: missing,
  });
  const updated = await db.rsiCycle.update({
    where: { id: cycle.id },
    data: {
      stageData: JSON.stringify({ ...stageData, runs: kicked }),
      suiteIds: JSON.stringify(suites.map((s) => s.id)),
    },
  });
  return {
    ok: true,
    cycle: updated,
    event,
    pending: true,
    runs: kicked.map((r) => ({ id: r.id, status: r.status, variant: r.variant })),
    note: "paired battery in flight — advance again (or poll) until both legs settle",
  };
}

type GateInputSuite = {
  suiteKey: string;
  category: string;
  baseRunId: string;
  candRunId: string;
  baseComposite: number | null;
  candComposite: number | null;
  baseCost: number | null;
  candCost: number | null;
  baseAbstain: number | null;
  candAbstain: number | null;
  basePass: number | null;
  candPass: number | null;
};

async function completeShadowEval(cycle: RsiCycle, stageData: StageData, suites: { id: string; key: string; category: string }[]): Promise<AdvanceResult> {
  const runIds = stageData.runs!.map((r) => r.id);
  const runs = await db.rsiRun.findMany({ where: { id: { in: runIds } } });
  const bySuite = new Map<string, { base?: (typeof runs)[number]; cand?: (typeof runs)[number] }>();
  for (const r of runs) {
    const entry = bySuite.get(r.suiteId) ?? {};
    if (r.variant === "baseline") entry.base = r;
    else entry.cand = r;
    bySuite.set(r.suiteId, entry);
  }

  const inputs: GateInputSuite[] = [];
  for (const suite of suites) {
    const pair = bySuite.get(suite.id);
    if (!pair?.base || !pair?.cand) continue;
    inputs.push({
      suiteKey: suite.key,
      category: suite.category,
      baseRunId: pair.base.id,
      candRunId: pair.cand.id,
      baseComposite: pair.base.compositeScore,
      candComposite: pair.cand.compositeScore,
      baseCost: pair.base.costUnits,
      candCost: pair.cand.costUnits,
      baseAbstain: pair.base.abstainRate,
      candAbstain: pair.cand.abstainRate,
      basePass: pair.base.passRate,
      candPass: pair.cand.passRate,
    });
  }
  if (inputs.length === 0) {
    return { ok: false, code: "NO_PAIRS", message: "no complete baseline/candidate pairs found in the battery", cycle };
  }

  const event = await appendCycleEvent(cycle.id, "shadow-eval", "battery-complete", {
    suites: inputs,
    note: "paired legs settled — gate inputs recorded, all numbers live-measured",
  });
  const gateResults = readJson<Record<string, unknown>>(cycle.gateResults, {});
  const updated = await db.rsiCycle.update({
    where: { id: cycle.id },
    data: { gateResults: JSON.stringify({ ...gateResults, input: { suites: inputs } }) },
  });
  void updated;
  const next = await moveTo(cycle.id, "pareto-gate");
  return { ok: true, cycle: next, event };
}

// ---------------------------------------------------------------------------
// STAGE 5 — PARETO GATE: G1 non-regression, G2 Pareto, G3, G5, G7 (+G4/G6 pending)
// ---------------------------------------------------------------------------

type GateVerdict = { pass: boolean; numbers: Record<string, unknown>; note?: string };

async function stageParetoGate(cycle: RsiCycle): Promise<AdvanceResult> {
  const gateResults = readJson<{ input?: { suites: GateInputSuite[] } } & Record<string, unknown>>(cycle.gateResults, {});
  const inputs = gateResults.input?.suites ?? [];
  if (inputs.length === 0) {
    return { ok: false, code: "NO_GATE_INPUTS", message: "no gate inputs — re-run shadow-eval first", cycle };
  }
  const stageData = readJson<StageData>(cycle.stageData, {});

  // G1 — per-suite paired non-regression: candComposite - baseComposite >= -epsilon(category).
  const g1Verdicts = inputs.map((s) => {
    const epsilon = G1_EPSILON[s.category] ?? 0;
    const delta = (s.candComposite ?? 0) - (s.baseComposite ?? 0);
    return {
      suite: s.suiteKey,
      category: s.category,
      delta: Number(delta.toFixed(4)),
      epsilon,
      pass: delta >= -epsilon,
    };
  });
  const g1: GateVerdict = {
    pass: g1Verdicts.every((v) => v.pass),
    numbers: { perSuite: g1Verdicts, rule: "cand - base >= -epsilon (0 safety/reliability/discipline, 0.10 persona, 0.05 research)" },
  };

  // G2 — Pareto dominance: S_cand >= S_base + eps AND C_cand <= C_base * (1+delta).
  const mean = (xs: Array<number | null>) => {
    const xs2 = xs.filter((x): x is number => x !== null);
    return xs2.length > 0 ? xs2.reduce((a, b) => a + b, 0) / xs2.length : null;
  };
  const sBase = mean(inputs.map((s) => s.baseComposite));
  const sCand = mean(inputs.map((s) => s.candComposite));
  const cBase = mean(inputs.map((s) => s.baseCost));
  const cCand = mean(inputs.map((s) => s.candCost));
  const g2: GateVerdict =
    sBase !== null && sCand !== null && cBase !== null && cCand !== null
      ? {
          pass: sCand >= sBase + G2_EPS_PERF && cCand <= cBase * (1 + G2_COST_TOLERANCE),
          numbers: {
            sBase: Number(sBase.toFixed(4)),
            sCand: Number(sCand.toFixed(4)),
            cBase: Number(cBase.toFixed(4)),
            cCand: Number(cCand.toFixed(4)),
            epsPerf: G2_EPS_PERF,
            costTolerance: G2_COST_TOLERANCE,
          },
          note: "S = equal-weight mean of per-suite composites; C = mean costUnits (1.0*tokensAvg + 0.5*p95s)",
        }
      : { pass: false, numbers: { sBase, sCand, cBase, cCand }, note: "missing metric rows — runs did not aggregate" };

  // G3 — prompt-delta regularization (recorded at synthesize).
  const distance = typeof stageData.promptDeltaDistance === "number" ? stageData.promptDeltaDistance : Number.NaN;
  const g3: GateVerdict = Number.isFinite(distance)
    ? { pass: distance <= G3_DELTA_MAX, numbers: { promptDeltaDistance: Number(distance.toFixed(4)), cap: G3_DELTA_MAX, arxiv: "2609.24972" } }
    : { pass: false, numbers: {}, note: "promptDeltaDistance not recorded — synthesize incomplete" };

  // G5 — abstention reliability (zero tolerance, both directions where measured).
  const abstainMeasured = inputs.filter((s) => s.baseAbstain !== null && s.candAbstain !== null);
  const reliabilitySuites = abstainMeasured.filter((s) => s.category === "reliability");
  const g5: GateVerdict =
    abstainMeasured.length === 0
      ? { pass: true, numbers: {}, note: "not measured: no abstention-verified tasks in the chosen suite set" }
      : {
          pass: abstainMeasured.every((s) => (s.candAbstain ?? 0) >= (s.baseAbstain ?? 0)) &&
            reliabilitySuites.every((s) => (s.candAbstain ?? 0) >= (s.baseAbstain ?? 0)),
          numbers: {
            perSuite: abstainMeasured.map((s) => ({ suite: s.suiteKey, base: s.baseAbstain, cand: s.candAbstain })),
            reliabilitySuitesChecked: reliabilitySuites.map((s) => s.suiteKey),
          },
        };

  // G7 — budget ceiling (stage caps + daily cap, loud fail).
  const budget = await rsiBudgetState();
  const synthCalls = typeof stageData.synthCalls === "number" ? stageData.synthCalls : 0;
  const g7: GateVerdict = {
    pass: budget.ok && synthCalls <= BUDGET_SYNTH_MAX_CALLS,
    numbers: { used: budget.used, cap: budget.cap, remaining: budget.remaining, synthCalls, synthCap: BUDGET_SYNTH_MAX_CALLS },
  };

  // G4 — counterfactual anti-shortcut: PENDING until the owner authors the
  // transformation registry (never fabricated here).
  const g4 = { status: "PENDING", note: "owner-authored counterfactual protocol variants (paraphrase/order-shuffle/format) not yet authored — gain-survival unverified" };
  // G6 — judge calibration: provisional author-anchors recorded; binding
  // kappa-on-owner-anchors gate PENDING (never fabricated).
  const g6 = {
    status: "PROVISIONAL",
    note: "provisional author-anchor agreement recorded per judged run; binding G6 (kappa >= 0.6 on owner anchors) PENDING",
  };

  const allGreen = g1.pass && g2.pass && g3.pass && g5.pass && g7.pass;
  const verdicts = { g1, g2, g3, g4, g5, g6, g7, allGreen };

  const event = await appendCycleEvent(cycle.id, "pareto-gate", allGreen ? "gates-green" : "gates-failed", {
    ...verdicts,
    input: inputs,
    rule: "G1/G2/G3/G5/G7 are the hard promote gates; G4/G6 are recorded PENDING (owner artifacts) and surfaced at the human gate",
  });

  await db.rsiCycle.update({
    where: { id: cycle.id },
    data: { gateResults: JSON.stringify({ ...gateResults, ...verdicts }) },
  });

  if (!allGreen) {
    const failed = [g1, g2, g3, g5, g7].filter((g) => !g.pass);
    return rejectCycle(cycle, "pareto-gate", `gate failure: ${failed.length} hard gate(s) failed`, { verdicts });
  }
  const next = await moveTo(cycle.id, "canary");
  return { ok: true, cycle: next, event };
}

// ---------------------------------------------------------------------------
// STAGE 6 — CANARY: one live candidate-side call on the designated task
// ---------------------------------------------------------------------------

async function stageCanary(cycle: RsiCycle): Promise<AdvanceResult> {
  const stageData = readJson<StageData>(cycle.stageData, {});
  const pluginId = cycle.pluginId;
  if (!pluginId) return { ok: false, code: "NO_PLUGIN", message: "cycle has no plugin", cycle };
  const plugin = await db.rsiPlugin.findUnique({ where: { id: pluginId } });
  if (!plugin) return { ok: false, code: "NO_PLUGIN", message: "plugin row missing", cycle };
  const payload = readJson<{ promptDelta?: string }>(plugin.payload, {});
  const delta = typeof payload.promptDelta === "string" ? payload.promptDelta : "";
  if (!delta) return { ok: false, code: "NO_DELTA", message: "plugin has no promptDelta", cycle };

  // Designated canary task: the reliability-latency suite's latency task,
  // falling back to the first task of the chosen suite set.
  let canaryTask = await db.rsiTask.findFirst({
    where: { suite: { key: "reliability-latency" }, verifier: "latency" },
    orderBy: { idx: "asc" },
  });
  let canarySuiteKey = "reliability-latency";
  if (!canaryTask) {
    const suiteIds = readJson<string[]>(cycle.suiteIds, []);
    const firstSuite = suiteIds.length > 0 ? await db.rsiSuite.findUnique({ where: { id: suiteIds[0] } }) : null;
    if (firstSuite) {
      canaryTask = await db.rsiTask.findFirst({ where: { suiteId: firstSuite.id }, orderBy: { idx: "asc" } });
      canarySuiteKey = firstSuite.key;
    }
  }
  if (!canaryTask) return { ok: false, code: "NO_CANARY_TASK", message: "no canary task resolvable", cycle };

  const budget = await rsiBudgetState();
  if (!budget.ok) {
    return {
      ok: false,
      code: "BUDGET_EXCEEDED",
      message: `budget_exceeded: daily cap ${budget.cap} reached (${budget.used} used) — canary aborted loudly`,
      cycle,
    };
  }

  const persona = `${cycle.baselineSnapshot}\n\n${delta}`;
  const shot = await rsiSingleShot({
    persona,
    prompt: canaryTask.prompt,
    budget: { cycleId: cycle.id, variant: "candidate", call: "canary" },
  });
  if (!shot.ok) {
    return rejectCycle(cycle, "canary", "canary-incident: engine call failed", { error: shot.error.slice(0, 300) });
  }

  const verdict = await verifyTask(canaryTask.verifier, canaryTask.verifierConfig, {
    taskPrompt: canaryTask.prompt,
    reply: shot.reply,
    latencyMs: shot.latencyMs,
  });
  const canaryRecord = {
    taskId: canaryTask.id,
    name: canaryTask.name,
    suiteKey: canarySuiteKey,
    latencyMs: Math.round(shot.latencyMs),
    verdictOk: Boolean(verdict.ok),
    verdictDetail: verdict.detail.slice(0, 300),
    replyExcerpt: shot.reply.slice(0, 200),
    provider: shot.provider,
    modelId: shot.modelId,
  };

  const incident = !verdict.ok || shot.latencyMs > 12_000;
  const event = await appendCycleEvent(
    cycle.id,
    "canary",
    incident ? "canary-incident" : "canary-pass",
    { ...canaryRecord, incident },
  );
  await db.rsiCycle.update({
    where: { id: cycle.id },
    data: { stageData: JSON.stringify({ ...stageData, canary: canaryRecord }) },
  });

  if (incident) {
    await db.rsiPlugin.update({ where: { id: plugin.id }, data: { status: "rejected" } });
    return rejectCycle(cycle, "canary", "canary-incident: candidate-side single call failed its verdict or latency band — rolled back", canaryRecord);
  }
  const next = await moveTo(cycle.id, "promote");
  return { ok: true, cycle: next, event };
}

// ---------------------------------------------------------------------------
// STAGE 7 — PROMOTE: the OWNER HUMAN GATE (confirm-only; never auto-deploy)
// ---------------------------------------------------------------------------

async function stagePromote(cycle: RsiCycle, body: AdvanceBody): Promise<AdvanceResult> {
  const verdicts = readJson<Record<string, GateVerdict | { status: string }>>(cycle.gateResults, {});
  const hardGates: Array<[string, GateVerdict | undefined]> = [
    ["g1", verdicts.g1 as GateVerdict | undefined],
    ["g2", verdicts.g2 as GateVerdict | undefined],
    ["g3", verdicts.g3 as GateVerdict | undefined],
    ["g5", verdicts.g5 as GateVerdict | undefined],
    ["g7", verdicts.g7 as GateVerdict | undefined],
  ];
  const notGreen = hardGates.filter(([, v]) => !v?.pass);
  if (notGreen.length > 0) {
    return {
      ok: false,
      code: "GATES_NOT_GREEN",
      message: `refused: hard gate(s) not green — ${notGreen.map(([k]) => k.toUpperCase()).join(", ")}`,
      cycle,
    };
  }
  if (body.confirm !== true) {
    return {
      ok: false,
      code: "OWNER_CONFIRM_REQUIRED",
      message:
        "owner human gate: pass {confirm:true} to record adoption. Deploy remains a manual Edge Cortex Deploy action — the engine never deploys.",
      cycle,
    };
  }

  // Record adoption + causal improvement edges (before/after from the pairs).
  const pluginId = cycle.pluginId!;
  const plugin = await db.rsiPlugin.findUnique({ where: { id: pluginId } });
  if (!plugin) return { ok: false, code: "NO_PLUGIN", message: "plugin row missing at promote", cycle };
  await db.rsiPlugin.update({ where: { id: plugin.id }, data: { status: "adopted" } });

  const input = readJson<{ input?: { suites: GateInputSuite[] } }>(cycle.gateResults, {});
  for (const s of input.input?.suites ?? []) {
    await db.rsiImprovementEdge.create({
      data: {
        cycleId: cycle.id,
        technique: plugin.name,
        metric: `composite:${s.suiteKey}`,
        before: s.baseComposite ?? 0,
        after: s.candComposite ?? 0,
      },
    });
    await db.rsiImprovementEdge.create({
      data: {
        cycleId: cycle.id,
        technique: plugin.name,
        metric: `costUnits:${s.suiteKey}`,
        before: s.baseCost ?? 0,
        after: s.candCost ?? 0,
      },
    });
  }

  const g4 = verdicts.g4 as { status?: string } | undefined;
  const g6 = verdicts.g6 as { status?: string } | undefined;
  const event = await appendCycleEvent(cycle.id, "promote", "promotion-recorded", {
    pluginId,
    pluginName: plugin.name,
    improvementEdges: (input.input?.suites ?? []).length * 2,
    pendingGates: { g4: g4?.status ?? "PENDING", g6: g6?.status ?? "PENDING" },
    note: "promotion recorded — deploy remains an owner action (Edge Cortex Deploy); the engine never deploys",
  });
  const next = await moveTo(cycle.id, "audit");
  return { ok: true, cycle: next, event };
}

// ---------------------------------------------------------------------------
// STAGE 8 — AUDIT: suite hashes + chain replay + calibration record
// ---------------------------------------------------------------------------

async function stageAudit(cycle: RsiCycle): Promise<AdvanceResult> {
  const suiteIds = readJson<string[]>(cycle.suiteIds, []);
  const suiteRows =
    suiteIds.length > 0
      ? await db.rsiSuite.findMany({ where: { id: { in: suiteIds } } })
      : await db.rsiSuite.findMany();
  const suiteHashes: Array<{ key: string; ok: boolean; storedHash: string; recomputedHash: string }> = [];
  for (const s of suiteRows) {
    const recomputed = await recomputeSuiteHash(s.id);
    suiteHashes.push({
      key: s.key,
      ok: recomputed === s.configHash,
      storedHash: s.configHash.slice(0, 12),
      recomputedHash: (recomputed ?? "none").slice(0, 12),
    });
  }
  const suitesOk = suiteHashes.length > 0 && suiteHashes.every((h) => h.ok);

  const chain = await verifyCycleChain(cycle.id);
  const gateResults = readJson<{ g6?: { status?: string } } & Record<string, unknown>>(cycle.gateResults, {});
  const calibration = gateResults.g6?.status ?? "PENDING";

  const auditOk = suitesOk && chain.ok;
  const event = await appendCycleEvent(cycle.id, "audit", auditOk ? "audit-ok" : "audit-failed", {
    auditChainOk: chain.ok,
    chainEvents: chain.events,
    firstBadSeq: chain.firstBadSeq,
    suitesOk,
    suiteHashes,
    calibration,
    note: "frozen suites re-hashed from live task rows; event chain replayed hash-by-hash",
  });

  if (!auditOk) {
    return rejectCycle(cycle, "audit", "tamper-audit-failed: suite hash mismatch or chain break — promotion voided", {
      auditChainOk: chain.ok,
      firstBadSeq: chain.firstBadSeq,
      suiteHashes,
    });
  }
  const next = await moveTo(cycle.id, "record");
  return { ok: true, cycle: next, event };
}

// ---------------------------------------------------------------------------
// STAGE 9 — RECORD: final ledger event → adopted
// ---------------------------------------------------------------------------

async function stageRecord(cycle: RsiCycle): Promise<AdvanceResult> {
  const plugin = cycle.pluginId ? await db.rsiPlugin.findUnique({ where: { id: cycle.pluginId } }) : null;
  const event = await appendCycleEvent(cycle.id, "record", "cycle-recorded", {
    pluginId: plugin?.id ?? null,
    pluginName: plugin?.name ?? null,
    memoryLedger: plugin ? `adopted plugin "${plugin.name}" recorded in the improvement ledger` : "no plugin recorded",
    negativeEvidence: "all gate numbers remain on the cycle row and event chain for future thesis screening",
  });
  const next = await moveTo(cycle.id, "adopted");
  return { ok: true, cycle: next, event };
}

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

export async function abortCycle(cycleId: string): Promise<AdvanceResult> {
  const cycle = await db.rsiCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) return { ok: false, code: "NOT_FOUND", message: "cycle not found" };
  if ((RSI_TERMINAL as readonly string[]).includes(cycle.status)) {
    return { ok: false, code: "CYCLE_TERMINAL", message: `cycle already terminal (${cycle.status})`, cycle };
  }
  const event = await appendCycleEvent(cycleId, cycle.status, "cycle-aborted", {
    by: "owner",
    note: "aborted from a live stage — negative evidence preserved on the chain",
  });
  if (cycle.pluginId) {
    const plugin = await db.rsiPlugin.findUnique({ where: { id: cycle.pluginId } });
    if (plugin && plugin.status === "active") {
      await db.rsiPlugin.update({ where: { id: plugin.id }, data: { status: "rejected" } });
    }
  }
  const updated = await moveTo(cycleId, "aborted");
  return { ok: true, cycle: updated, event };
}

// ---------------------------------------------------------------------------
// Creation (route helper): baseline snapshot comes from cortex, read-only
// ---------------------------------------------------------------------------

export async function createCycle(opts: {
  name: string;
  thesis: string;
  module: string;
  techniqueRefs: string[];
}): Promise<{ ok: true; cycle: RsiCycle } | { ok: false; code: string; message: string }> {
  const name = opts.name.trim().slice(0, 120);
  const thesis = opts.thesis.trim().slice(0, 2000);
  const moduleScope = opts.module.trim();
  const refs = opts.techniqueRefs.map((r) => r.trim()).filter(Boolean).slice(0, 8);
  if (name.length < 3) return { ok: false, code: "BAD_NAME", message: "name must be at least 3 chars" };
  if (thesis.length < 12) return { ok: false, code: "BAD_THESIS", message: "thesis must be at least 12 chars (falsifiable claim)" };
  if (!(THESIS_MODULES as readonly string[]).includes(moduleScope)) {
    return { ok: false, code: "BAD_MODULE", message: "module must be one of persona|routing|guard|tool-config|code" };
  }

  // Baseline snapshot: the CURRENT persona prompt via cortex's own builder —
  // read-only import (cortex is never edited); provenance noted in stageData.
  const baselineSnapshot = currentBaselinePersona();

  const cycle = await db.rsiCycle.create({
    data: {
      name,
      thesis,
      techniqueRefs: JSON.stringify(refs),
      status: "scout",
      stageData: JSON.stringify({ module: moduleScope, baselineProvenance: "cortex.buildSystemPrompt@eval-fixed-inputs (v34.3 persona)" }),
      baselineSnapshot,
    },
  });
  const event = await appendCycleEvent(cycle.id, "scout", "cycle-created", {
    name,
    thesis,
    module: moduleScope,
    techniqueRefs: refs,
    baselineChars: baselineSnapshot.length,
  });
  void event;
  return { ok: true, cycle };
}
