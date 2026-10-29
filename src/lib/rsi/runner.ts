import { db } from "@/lib/db";
import { chatComplete } from "@/lib/ai/client";
import { buildSystemPrompt } from "@/lib/brain/cortex";
import { verifyTask, type VerifyCtx } from "./verifiers";
import { ensureRunCalibration, type CalibrationResult } from "./judge";
import { rsiBudgetAllows, recordRsiCall } from "./budget";
import {
  COMPOSITE_W_JUDGE,
  COMPOSITE_W_PASS,
  COST_W_LATENCY,
  COST_W_TOKENS,
  RSI_CALL_TIMEOUT_MS,
  RSI_MAX_TOKENS,
  RSI_MODEL_LADDER,
  RSI_TEMPERATURE,
} from "./constants";

/**
 * v35 RSI Lab — the shadow-eval executor (async ledger pattern, mirrors
 * deep-research.ts: launch writes a queued row, background execution patches
 * it, the panel polls).
 *
 * Honesty contract:
 * - Every metric is LIVE-MEASURED through the brain's own provider ladder
 *   (chatComplete — vyce primary with the model-ladder fallbacks below); the
 *   engine truth {provider, modelId} is recorded per task AND per run
 *   (v34.1 convention: never a lane label, always the resolved id).
 * - Eval runs NEVER post to Kick and NEVER write InteractionLog. They DO
 *   write UsageEvent telemetry rows (kind "llm", role "rsi-lab", runId,
 *   variant) via budget.ts — counters only, never content (P7).
 * - Budget: every LLM call (task + judge) counts against the daily cap; a
 *   breach fails the run LOUDLY with "budget_exceeded" — never a silent
 *   truncation of the suite.
 * - Failed calls are stored as failed task verdicts with real error text.
 */

// ---------------------------------------------------------------------------
// Persona resolution (baseline snapshot is an attributable artifact)
// ---------------------------------------------------------------------------

/**
 * The CURRENT persona prompt, captured through cortex's own builder —
 * read-only import; cortex logic is never edited by the lab. Fixed inputs
 * (no transcript, no recap) make the snapshot deterministic per build.
 */
export function currentBaselinePersona(): string {
  return buildSystemPrompt("eval", "specimba", "", false, null);
}

type PersonaResolution =
  | { ok: true; persona: string; provenance: string }
  | { ok: false; error: string };

async function resolvePersona(opts: {
  variant: "baseline" | "candidate";
  pluginId?: string | null;
  cycleId?: string | null;
}): Promise<PersonaResolution> {
  let baseline: string;
  let provenance: string;
  if (opts.cycleId) {
    const cycle = await db.rsiCycle.findUnique({ where: { id: opts.cycleId } });
    if (!cycle) return { ok: false, error: "linked cycle not found" };
    baseline = cycle.baselineSnapshot || currentBaselinePersona();
    provenance = "cycle.baselineSnapshot";
  } else {
    baseline = currentBaselinePersona();
    provenance = "cortex.buildSystemPrompt@eval-fixed-inputs";
  }
  if (opts.variant === "baseline") {
    return { ok: true, persona: baseline, provenance };
  }
  if (!opts.pluginId) return { ok: false, error: "candidate runs require a pluginId" };
  const plugin = await db.rsiPlugin.findUnique({ where: { id: opts.pluginId } });
  if (!plugin) return { ok: false, error: "plugin not found" };
  let payload: { promptDelta?: string } = {};
  try {
    payload = JSON.parse(plugin.payload || "{}") as { promptDelta?: string };
  } catch {
    return { ok: false, error: "plugin payload unparseable" };
  }
  const delta = typeof payload.promptDelta === "string" ? payload.promptDelta.trim() : "";
  if (!delta) return { ok: false, error: "plugin has no promptDelta" };
  return {
    ok: true,
    persona: `${baseline}\n\n${delta}`,
    provenance: `${provenance} + plugin:${plugin.id} promptDelta (${delta.length} chars)`,
  };
}

// ---------------------------------------------------------------------------
// Single-shot brain call through the real provider ladder
// ---------------------------------------------------------------------------

export type SingleShotResult =
  | {
      ok: true;
      reply: string;
      latencyMs: number;
      tokens: { prompt: number | null; completion: number | null; total: number | null } | null;
      provider: string;
      modelId: string;
    }
  | { ok: false; error: string; provider: string; modelId: string; latencyMs: number | null };

/**
 * One task call, executed through chatComplete (the same completion path the
 * cortex lanes use — providers are NOT reimplemented here). The ladder is
 * fixed so both legs of a paired run take the identical path.
 */
export async function rsiSingleShot(opts: {
  persona: string;
  prompt: string;
  budget: { runId?: string; cycleId?: string; variant?: string; call: "task" | "canary" };
}): Promise<SingleShotResult> {
  const errors: string[] = [];
  for (const model of RSI_MODEL_LADDER) {
    // Budget pre-flight before EVERY ladder attempt — loud fail, no truncation.
    const state = await rsiBudgetAllows(1);
    if (!state.ok) {
      return {
        ok: false,
        error: `budget_exceeded: daily cap ${state.cap} reached (${state.used} used)`,
        provider: "vyce",
        modelId: model,
        latencyMs: null,
      };
    }
    const started = Date.now();
    try {
      const r = await chatComplete(
        model,
        [
          { role: "system", content: opts.persona },
          { role: "user", content: opts.prompt },
        ],
        { maxTokens: RSI_MAX_TOKENS, temperature: RSI_TEMPERATURE, timeoutMs: RSI_CALL_TIMEOUT_MS },
      );
      const latencyMs = r.latencyMs || Date.now() - started;
      const reply = (r.content || "").trim();
      void recordRsiCall({
        runId: opts.budget.runId,
        cycleId: opts.budget.cycleId,
        variant: opts.budget.variant,
        call: opts.budget.call,
        provider: "vyce",
        modelId: r.model,
        latencyMs,
        tokens: r.usage ? { prompt: r.usage.prompt, completion: r.usage.completion } : null,
        ok: true,
      });
      return {
        ok: true,
        reply,
        latencyMs,
        tokens: r.usage ? { prompt: r.usage.prompt, completion: r.usage.completion, total: r.usage.total } : null,
        provider: "vyce",
        modelId: r.model,
      };
    } catch (e) {
      const errText = e instanceof Error ? e.message.slice(0, 140) : "call failed";
      errors.push(`${model}: ${errText}`);
      void recordRsiCall({
        runId: opts.budget.runId,
        cycleId: opts.budget.cycleId,
        variant: opts.budget.variant,
        call: opts.budget.call,
        provider: "vyce",
        modelId: model,
        latencyMs: Date.now() - started,
        ok: false,
        error: "LADDER_RUNG_FAILED",
      });
    }
  }
  return {
    ok: false,
    error: `engine_unavailable: all ladder models failed — ${errors.join(" | ").slice(0, 400)}`,
    provider: "vyce",
    modelId: RSI_MODEL_LADDER[0],
    latencyMs: null,
  };
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

export type StartRunResult =
  | { ok: true; run: { id: string; status: string; variant: string; suiteId: string } }
  | { ok: false; code: string; message: string };

/** Validate + queue a paired battery leg (fire-and-forget like launchPanelResearch). */
export async function startRun(opts: {
  suiteId: string;
  variant: "baseline" | "candidate";
  pluginId?: string | null;
  cycleId?: string | null;
}): Promise<StartRunResult> {
  if (opts.variant !== "baseline" && opts.variant !== "candidate") {
    return { ok: false, code: "BAD_VARIANT", message: "variant must be baseline or candidate" };
  }
  const suite = await db.rsiSuite.findUnique({ where: { id: opts.suiteId } });
  if (!suite) return { ok: false, code: "SUITE_NOT_FOUND", message: "suite not found" };
  const taskCount = await db.rsiTask.count({ where: { suiteId: suite.id } });
  if (taskCount === 0) return { ok: false, code: "EMPTY_SUITE", message: "suite has no tasks" };

  const persona = await resolvePersona(opts);
  if (!persona.ok) {
    return { ok: false, code: "PERSONA_UNRESOLVED", message: persona.error };
  }

  // Budget pre-flight: at least one call of headroom, else refuse LOUDLY.
  const state = await rsiBudgetAllows(1);
  if (!state.ok) {
    return {
      ok: false,
      code: "BUDGET_EXCEEDED",
      message: `budget_exceeded: daily cap ${state.cap} reached (${state.used} used) — the engine never silently truncates`,
    };
  }

  const run = await db.rsiRun.create({
    data: {
      suiteId: suite.id,
      cycleId: opts.cycleId ?? null,
      variant: opts.variant,
      pluginId: opts.variant === "candidate" ? opts.pluginId ?? null : null,
      status: "queued",
    },
  });

  void executeRun(run.id).catch(async (e) => {
    await db.rsiRun
      .update({
        where: { id: run.id },
        data: {
          status: "error",
          error: e instanceof Error ? e.message.slice(0, 500) : "runner crashed",
          finishedAt: new Date(),
        },
      })
      .catch(() => undefined);
  });

  return { ok: true, run: { id: run.id, status: run.status, variant: run.variant, suiteId: run.suiteId } };
}

type TaskResultRow = {
  taskId: string;
  name: string;
  ok: boolean;
  verdictDetail: string;
  latencyMs: number | null;
  tokens: number | null;
  judgeScore?: number | null;
  replyExcerpt: string;
  provider: string;
  modelId: string;
  weight: number;
  verifier: string;
  hadReply: boolean;
};

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return Math.round(sortedAsc[idx]);
}

/** The background executor: one leg of the paired battery on one suite. */
async function executeRun(runId: string): Promise<void> {
  const run = await db.rsiRun.findUnique({ where: { id: runId } });
  if (!run) return;
  const tasks = await db.rsiTask.findMany({ where: { suiteId: run.suiteId }, orderBy: { idx: "asc" } });

  const persona = await resolvePersona({
    variant: run.variant as "baseline" | "candidate",
    pluginId: run.pluginId,
    cycleId: run.cycleId,
  });
  if (!persona.ok) {
    await db.rsiRun.update({
      where: { id: runId },
      data: { status: "error", error: persona.error, finishedAt: new Date(), startedAt: new Date() },
    });
    return;
  }

  await db.rsiRun.update({ where: { id: runId }, data: { status: "running", startedAt: new Date() } });

  let calibration: CalibrationResult | null = null;
  const results: TaskResultRow[] = [];
  const modelTally = new Map<string, number>();
  let judgeCalls = 0;
  let taskCalls = 0;

  for (const task of tasks) {
    const shot = await rsiSingleShot({
      persona: persona.persona,
      prompt: task.prompt,
      budget: {
        runId,
        cycleId: run.cycleId ?? undefined,
        variant: run.variant,
        call: "task",
      },
    });
    if (shot.ok) {
      taskCalls += 1;
      modelTally.set(shot.modelId, (modelTally.get(shot.modelId) ?? 0) + 1);
    }

    const needsJudge = task.verifier === "judge" || verifierUsesJudge(task.verifier, task.verifierConfig);
    if (needsJudge && shot.ok) {
      // First judge use per run-batch runs the provisional anchor calibration.
      calibration = calibration ?? (await ensureRunCalibration({ runId, cycleId: run.cycleId ?? undefined, variant: run.variant }));
      judgeCalls += 1;
    }

    const verdict = shot.ok
      ? await verifyTask(task.verifier, task.verifierConfig, {
          taskPrompt: task.prompt,
          reply: shot.reply,
          latencyMs: shot.latencyMs,
          judgeBudget: { runId, cycleId: run.cycleId ?? undefined, variant: run.variant },
        })
      : { ok: false, detail: shot.error, judgeScore: undefined as number | null | undefined };

    const tokensFromUsage =
      shot.ok && shot.tokens
        ? shot.tokens.total !== null && shot.tokens.total !== undefined
          ? shot.tokens.total
          : (shot.tokens.prompt ?? 0) + (shot.tokens.completion ?? 0)
        : null;
    const tokensTotal = tokensFromUsage !== null && Number.isFinite(tokensFromUsage) && tokensFromUsage > 0
      ? tokensFromUsage
      : null;

    results.push({
      taskId: task.id,
      name: task.name,
      ok: Boolean(verdict.ok),
      verdictDetail: verdict.detail.slice(0, 500),
      latencyMs: shot.ok ? Math.round(shot.latencyMs) : null,
      tokens: tokensTotal !== null && Number.isFinite(tokensTotal) ? Math.round(tokensTotal) : null,
      judgeScore: verdict.judgeScore ?? null,
      replyExcerpt: shot.ok ? shot.reply.slice(0, 200) : "",
      provider: "vyce",
      modelId: shot.ok ? shot.modelId : shot.modelId,
      weight: task.weight,
      verifier: task.verifier,
      hadReply: shot.ok,
    });

    // Partial-progress write so the panel's live polling shows movement.
    await db.rsiRun
      .update({ where: { id: runId }, data: { resultsJson: JSON.stringify(results).slice(0, 240_000) } })
      .catch(() => undefined);
  }

  // ---------------------------------------------------------------------
  // Aggregation (all numbers derived from the rows above — no invention)
  // ---------------------------------------------------------------------
  const totalWeight = results.reduce((s, r) => s + (r.weight > 0 ? r.weight : 0), 0);
  const passedWeight = results.reduce((s, r) => s + (r.ok && r.weight > 0 ? r.weight : 0), 0);
  const passRate = totalWeight > 0 ? passedWeight / totalWeight : results.length > 0 ? 0 : 0;

  const judgedScores = results.filter((r) => r.judgeScore !== null).map((r) => r.judgeScore as number);
  const judgeAvg = judgedScores.length > 0 ? judgedScores.reduce((a, b) => a + b, 0) / judgedScores.length : null;

  const abstainTasks = results.filter((r) => r.verifier === "abstain");
  const abstainPassed = abstainTasks.filter((r) => r.ok).length;
  const abstainRate = abstainTasks.length > 0 ? abstainPassed / abstainTasks.length : null;

  const latencies = results.filter((r) => r.latencyMs !== null).map((r) => r.latencyMs as number).sort((a, b) => a - b);
  const latencyP50Ms = percentile(latencies, 50);
  const latencyP95Ms = percentile(latencies, 95);

  const tokenVals = results.filter((r) => r.tokens !== null).map((r) => r.tokens as number);
  const tokensAvg = tokenVals.length > 0 ? Math.round(tokenVals.reduce((a, b) => a + b, 0) / tokenVals.length) : null;

  const costUnits =
    COST_W_TOKENS * (tokensAvg ?? 0) + COST_W_LATENCY * ((latencyP95Ms ?? 0) / 1000);

  const compositeScore =
    judgeAvg !== null
      ? COMPOSITE_W_PASS * passRate + COMPOSITE_W_JUDGE * (judgeAvg / 5)
      : COMPOSITE_W_PASS * passRate + COMPOSITE_W_JUDGE * passRate;

  const dominantModel = [...modelTally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? RSI_MODEL_LADDER[0];
  const engineJson = {
    provider: "vyce",
    modelId: dominantModel,
    models: [...modelTally.keys()],
    calls: taskCalls,
    judge: { provider: "z-ai", modelId: "z-ai-judge", familyDiversity: "z-ai judge vs vyce candidates — distinct family" },
    judgeCalls,
    calibration: calibration
      ? { calibration: calibration.calibration, provisional: true, agreementRate: calibration.agreementRate }
      : null,
    personaProvenance: persona.provenance,
  };

  const successfulCalls = results.filter((r) => r.hadReply).length;
  const status = successfulCalls === 0 ? "error" : "done";
  const error =
    successfulCalls === 0
      ? `engine_unavailable: 0/${results.length} tasks reached a model — see verdict details`
      : results.some((r) => !r.hadReply)
        ? `${results.length - successfulCalls}/${results.length} tasks failed at the engine (stored as failed verdicts)`
        : "";

  await db.rsiRun.update({
    where: { id: runId },
    data: {
      status,
      passRate,
      judgeAvg,
      abstainRate,
      latencyP50Ms,
      latencyP95Ms,
      tokensAvg,
      costUnits,
      compositeScore,
      resultsJson: JSON.stringify(results).slice(0, 240_000),
      engineJson: JSON.stringify(engineJson),
      error,
      finishedAt: new Date(),
    },
  });
}

/** Does a verifier config (possibly composed via allOf) use the judge anywhere? */
function verifierUsesJudge(verifier: string, configJson: string): boolean {
  if (verifier === "judge") return true;
  if (verifier !== "allOf") return false;
  try {
    const cfg = JSON.parse(configJson || "{}") as { of?: Array<{ verifier?: string; verifierConfig?: unknown }> };
    return (cfg.of ?? []).some((c) => verifierUsesJudge(String(c?.verifier ?? ""), JSON.stringify(c?.verifierConfig ?? {})));
  } catch {
    return false;
  }
}
