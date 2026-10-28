import { db } from "@/lib/db";
import {
  BUDGET_DAILY_DEFAULT,
  BUDGET_DAILY_SETTING,
  RSI_USAGE_ROLE,
} from "./constants";

/**
 * v35 RSI Lab — budget discipline (G7, loud-fail doctrine).
 *
 * Every LLM call the RSI engine makes (task leg, judge verdict, synthesize
 * draft, canary probe) writes its own UsageEvent row with meta
 * {role:"rsi-lab", runId, variant, call} — counters only, never prompt/reply
 * content (P7). The daily cap lives in Setting `rsi.callBudgetDaily`
 * (default 64, evolution-engine.json costModel). A breach fails the run
 * LOUDLY with "budget_exceeded" — the engine never silently truncates a
 * suite to fit a cap.
 */

export type RsiBudgetState = {
  used: number;
  cap: number;
  remaining: number;
  ok: boolean;
  /** UTC day the counter window covers (YYYY-MM-DD). */
  day: string;
};

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function todayUtcKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Count of RSI-attributed LLM calls since UTC midnight (UsageEvent rows). */
export async function rsiCallsToday(): Promise<number> {
  return db.usageEvent.count({
    where: {
      kind: "llm",
      meta: { contains: `"role":"${RSI_USAGE_ROLE}"` },
      ts: { gte: startOfTodayUtc() },
    },
  });
}

/** Owner-editable daily cap (Setting key rsi.callBudgetDaily, default 64). */
export async function rsiDailyCap(): Promise<number> {
  const row = await db.setting.findUnique({ where: { key: BUDGET_DAILY_SETTING } }).catch(() => null);
  const parsed = row?.value ? Number.parseInt(row.value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : BUDGET_DAILY_DEFAULT;
}

/** Full budget state for the API + gates. */
export async function rsiBudgetState(): Promise<RsiBudgetState> {
  const [used, cap] = await Promise.all([rsiCallsToday(), rsiDailyCap()]);
  return {
    used,
    cap,
    remaining: Math.max(0, cap - used),
    ok: used < cap,
    day: todayUtcKey(),
  };
}

/**
 * Pre-flight check for a batch of upcoming calls: returns remaining headroom
 * or an honest budget error. Callers fail their run LOUDLY on ok:false.
 */
export async function rsiBudgetAllows(upcoming = 1): Promise<RsiBudgetState> {
  const state = await rsiBudgetState();
  return { ...state, ok: state.remaining >= upcoming };
}

/**
 * Honest telemetry row per RSI LLM call. Static scalar meta only — never
 * prompt or reply text (P7 convention of the Usage ledger).
 */
export async function recordRsiCall(opts: {
  runId?: string;
  cycleId?: string;
  variant?: string;
  /** Which engine path spent the call. */
  call: "task" | "judge" | "judge-anchor" | "synthesize" | "canary";
  provider: string;
  modelId: string;
  latencyMs: number | null;
  tokens?: { prompt: number | null; completion: number | null } | null;
  ok: boolean;
  error?: string;
}): Promise<void> {
  const meta: Record<string, unknown> = {
    role: RSI_USAGE_ROLE,
    call: opts.call,
    provider: opts.provider,
    modelId: opts.modelId.slice(0, 128),
  };
  if (opts.runId) meta.runId = opts.runId;
  if (opts.cycleId) meta.cycleId = opts.cycleId;
  if (opts.variant) meta.variant = opts.variant;
  if (opts.error) meta.error = opts.error.slice(0, 64);
  if (opts.tokens) {
    if (opts.tokens.prompt !== null) meta.promptTokens = opts.tokens.prompt;
    if (opts.tokens.completion !== null) meta.completionTokens = opts.tokens.completion;
  }
  try {
    await db.usageEvent.create({
      data: {
        kind: "llm",
        model: opts.modelId.slice(0, 128),
        ok: opts.ok,
        latencyMs: opts.latencyMs !== null ? Math.round(opts.latencyMs) : null,
        meta: JSON.stringify(meta).slice(0, 2048),
      },
    });
  } catch {
    // Telemetry must never break the eval path; the run record itself stays
    // the source of truth for per-task numbers.
  }
}
