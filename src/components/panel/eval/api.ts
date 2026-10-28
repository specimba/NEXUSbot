"use client";

/**
 * RSI Lab frontend API contract (v35) — typed same-origin fetches for the
 * eval module. Mirrors the exa-api.ts pattern: defensive JSON parse, error
 * envelopes {ok:false, error:{code,message}} surfaced as RsiApiError with
 * the HTTP status + machine code, honest "unavailable" states in the UI.
 */

export type RsiOverview = {
  ok: true;
  papers: number;
  suites: number;
  tasks: number;
  cycles: Record<string, number>;
  runs: { today: number; done: number; error: number };
  budget: { used: number; cap: number; remaining: number; ok: boolean; day: string };
  activeCycles: Array<{ id: string; name: string; status: string; updatedAt: string }>;
  recentEvents: Array<{
    id: string;
    cycleId: string;
    seq: number;
    stage: string;
    type: string;
    hash: string;
    createdAt: string;
    chainVerified: boolean;
  }>;
};

export type RsiPaper = {
  id: string;
  citeKey: string;
  title: string;
  authorsShort: string;
  year: number;
  arxivId: string;
  url: string;
  category: string;
  relevance: string;
  oneLine: string;
  keyTechnique: string;
  appliesTo: string;
  evidence: string;
};

export type RsiPapersResponse = { ok: true; papers: RsiPaper[]; total: number };

export type RsiSuiteTask = {
  id: string;
  idx: number;
  name: string;
  prompt: string;
  verifier: string;
  verifierLabel: string;
  verifierConfig: string;
  difficulty: number;
  weight: number;
  tags: string;
};

export type RsiSuite = {
  id: string;
  key: string;
  name: string;
  category: string;
  description: string;
  grounding: string;
  version: string;
  configHash: string;
  configHashShort: string;
  frozenAt: string;
  tasks: RsiSuiteTask[];
};

export type RsiSuitesResponse = { ok: true; suites: RsiSuite[]; verifierLabels: Record<string, string> };

export type RsiRunRow = {
  id: string;
  suiteId: string;
  cycleId: string | null;
  pluginId: string | null;
  variant: string;
  status: string;
  passRate: number | null;
  judgeAvg: number | null;
  abstainRate: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  tokensAvg: number | null;
  costUnits: number | null;
  compositeScore: number | null;
  error: string;
  createdAt: string;
  finishedAt: string | null;
};

export type RsiRunDetail = RsiRunRow & {
  suiteKey: string | null;
  suiteName: string | null;
  results: Array<{
    taskId: string;
    name: string;
    ok: boolean;
    verdictDetail: string;
    latencyMs: number | null;
    tokens: number | null;
    judgeScore: number | null;
    replyExcerpt: string;
    provider: string;
    modelId: string;
  }>;
  engine: Record<string, unknown>;
};

export type RsiPlugin = {
  id: string;
  name: string;
  kind: string;
  payload: string;
  description: string;
  sourceArxiv: string;
  status: string;
  cycleId: string | null;
  createdAt: string;
};

export type RsiCycleRow = {
  id: string;
  name: string;
  thesis: string;
  techniqueRefs: string;
  status: string;
  pluginId: string | null;
  gateResults: string;
  createdAt: string;
  updatedAt: string;
};

export type RsiCycleDetail = {
  ok: true;
  cycle: {
    id: string;
    name: string;
    thesis: string;
    techniqueRefs: string;
    status: string;
    stageData: string;
    baselineSnapshotChars: number;
    baselineSnapshot: string;
    pluginId: string | null;
    suiteIds: string;
    gateResults: string;
    createdAt: string;
    updatedAt: string;
  };
  events: Array<{
    id: string;
    seq: number;
    stage: string;
    type: string;
    payload: string;
    prevHash: string;
    hash: string;
    createdAt: string;
  }>;
  runs: RsiRunRow[];
  plugin: { id: string; name: string; status: string; payload: string; description: string; sourceArxiv: string } | null;
  chain: { ok: boolean; events: number; firstBadSeq: number | null; lastHash: string | null };
};

export type RsiAdvanceResponse = {
  ok: true;
  cycle: { id: string; name: string; status: string; updatedAt: string };
  event?: { seq: number; stage: string; type: string; hash: string; createdAt: string };
  pending?: boolean;
  runs?: Array<{ id: string; status: string; variant: string }>;
  note?: string;
};

/** GET/PUT /api/rsi/budget payload — the fresh engine budget state. */
export type RsiBudgetResponse = {
  ok: true;
  budget: RsiOverview["budget"];
};

/** Owner-editable daily LLM-call cap bounds (mirrors /api/rsi/budget validation). */
export const BUDGET_CAP_MIN = 1;
export const BUDGET_CAP_MAX = 4096;
/** Quick-pick cap presets rendered in the overview budget card. */
export const BUDGET_CAP_PRESETS = [64, 128, 256, 512] as const;

export class RsiApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "RsiApiError";
    this.status = status;
    this.code = code;
  }
}

type ErrorEnvelope = { ok?: boolean; error?: { code?: string; message?: string } | string };

/** Defensive same-origin fetch with error-envelope decoding. */
export async function fetchRsiJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch {
    throw new RsiApiError("Network request failed", 0, null);
  }
  const body = (await res.json().catch(() => null)) as (T & ErrorEnvelope) | null;
  if (!res.ok || !body || body.ok === false) {
    const raw = body?.error;
    const message =
      typeof raw === "string"
        ? raw
        : raw && typeof raw.message === "string"
          ? raw.message
          : `Request failed (HTTP ${res.status})`;
    const code = typeof raw === "object" && raw !== null ? raw.code ?? null : null;
    throw new RsiApiError(message, res.status, code);
  }
  return body;
}

/** Safe JSON parse helper for stringified DB fields. */
export function parseJsonField<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

export const PAPER_CATEGORIES = [
  "harness-evolution",
  "verification-eval",
  "efficiency-substrate",
  "safety-governance",
  "training-methods",
] as const;

export const RESEARCH_EFFORT_OPTIONS = [
  { value: "low", label: "low · ~$0.03 / ~15s" },
  { value: "medium", label: "medium · ~$0.15 / ~60s" },
  { value: "high", label: "high · ~$0.50 / ~3min" },
  { value: "xhigh", label: "xhigh · ~$1+ / ~5min" },
  { value: "ultra", label: "ultra · ~$2+ / ~10min" },
] as const;

export const SUGGESTED_RESEARCH_QUERIES = [
  "state of the art recursive self-improvement agent harness evolution 2026",
  "training-free harness evolution Pareto gates",
  "LLM judge calibration reward hacking countermeasures",
] as const;

/** The 9-stage spine labels (mirrors src/lib/rsi/constants.ts — frozen). */
export const STAGE_SPINE = [
  { id: "scout", label: "Scout", action: "Mine live failure evidence (flagged rows, latency outliers, research ledger) — 0 LLM calls" },
  { id: "thesis", label: "Thesis", action: "Validate the owner thesis: one module, falsifiable, not a rejected duplicate" },
  { id: "synthesize", label: "Synthesize", action: "Draft the prompt-delta plugin (1-2 z-ai calls) + G3 delta-distance precheck" },
  { id: "shadow-eval", label: "Shadow eval", action: "Kick paired baseline + candidate runs on the frozen suite set" },
  { id: "pareto-gate", label: "Pareto gate", action: "Grade G1 non-regression, G2 Pareto, G3, G5 abstention, G7 budget" },
  { id: "canary", label: "Canary", action: "One live candidate-side call on the designated canary task" },
  { id: "promote", label: "Promote", action: "OWNER HUMAN GATE — confirm records adoption; deploy stays manual" },
  { id: "audit", label: "Audit", action: "Re-hash frozen suites + replay the event hash chain" },
  { id: "record", label: "Record", action: "Final ledger event — adopted plugin into memory" },
] as const;

export const TERMINAL_STATUSES = ["adopted", "rejected", "aborted"] as const;

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function stageIndex(status: string): number {
  return STAGE_SPINE.findIndex((s) => s.id === status);
}
