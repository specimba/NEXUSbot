"use client";

import { formatDistanceToNow } from "date-fns";

/**
 * Exa frontend API contract (Task 15-b) — shared by the connector card, the
 * deep-research card and the Overview "AI Gündem" tile.
 *
 * The backend routes (/api/connectors/exa/*, /api/exa/*, /api/brain/search
 * mode:"answer") are implemented in parallel (Task 15-a): until they land,
 * every fetch below can 404/503 — all callers must treat that as an honest
 * "unavailable" state, never a crash. Types are declared HERE (frontend-local)
 * on purpose: no import from src/lib/connectors/* so the panel keeps compiling
 * regardless of backend progress.
 */

export type ExaCredential = {
  masked: string;
  keyId: string;
  updatedAt: string;
};

/** GET /api/connectors/exa/status → { ok, status } */
export type ExaStatus = {
  configured: boolean;
  reachable: boolean | null;
  apiOk: boolean | null;
  error: string | null;
  credential: ExaCredential | null;
  probedAt: string | null;
  probeTarget: string;
  capabilities: string[];
  spend: { totalDollars30d: number; calls30d: number } | null;
};

export type ExaStatusResponse = { ok: true; status: ExaStatus };

/** POST /api/connectors/exa/key {action:"push-edge"} */
export type PushEdgeResponse = {
  ok: true;
  pushed: boolean;
  secretName: string;
  note: string;
};

export type ExaCitation = { title: string; url: string };

/** POST /api/brain/search {query, mode:"answer"} */
export type BrainAnswerResponse = {
  ok: true;
  mode: "answer";
  provider: string;
  answer: string;
  citations: ExaCitation[];
  tookMs: number;
  costDollars: number;
};

export type ResearchEffort = "low" | "medium" | "high" | "xhigh" | "ultra";

export const RESEARCH_EFFORTS: ReadonlyArray<{ value: ResearchEffort; label: string }> = [
  // v33 — labels switched to MEASURED costs (live probe runs 2026-10-27:
  // low ≈ $0.03/15s/3 searches, medium ≈ $0.15/60s/12 searches,
  // high ≈ $0.50/160s/60 searches; xhigh/ultra scale up from high).
  { value: "low", label: "low · ~$0.03 / ~15s" },
  { value: "medium", label: "medium · ~$0.15 / ~60s" },
  { value: "high", label: "high · ~$0.50 / ~3min" },
  { value: "xhigh", label: "xhigh · ~$1+ / ~5min" },
  { value: "ultra", label: "ultra · ~$2+ / ~10min" },
];

/** Row shape from GET /api/exa/research (list) and POST /api/exa/research (launch) */
export type ResearchJob = {
  id: string;
  query: string;
  effort: string;
  status: string;
  stopReason: string | null;
  costDollars: number | null;
  tookMs: number | null;
  error: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  answerPreview?: string;
};

export type ResearchListResponse = { ok: true; jobs: ResearchJob[] };
export type ResearchLaunchResponse = { ok: true; job: ResearchJob };

/** GET /api/exa/research/{id} job shape */
export type ResearchDetail = {
  id: string;
  query: string;
  effort: string;
  status: string;
  stopReason: string | null;
  answer: string;
  citations: ExaCitation[];
  structured: Record<string, unknown> | null;
  costDollars: number | null;
  tookMs: number | null;
  error: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type ResearchDetailResponse = { ok: true; job: ResearchDetail };

export type NewsItem = {
  title: string;
  text: string;
  url: string;
  host: string;
  date: string;
};

/** GET /api/exa/news → { ok, fresh, brief } */
export type NewsBrief = {
  items: NewsItem[];
  formatted: string;
  provider: string;
  tookMs: number;
  costDollars: number;
  createdAt: string;
};

export type ExaNewsResponse = { ok: true; fresh: boolean; brief: NewsBrief };

/**
 * Typed fetch failure carrying the HTTP status + machine error code so callers
 * can branch (EXA_NOT_CONFIGURED hints, 429 honest rate-limit toasts, …).
 */
export class ExaApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "ExaApiError";
    this.status = status;
    this.code = code;
  }
}

type ErrorEnvelope = { ok?: boolean; error?: { code?: string; message?: string } | string };

/**
 * Defensive same-origin fetch: res.ok check + safe JSON parse. Backend error
 * envelopes are { error: { code, message } } (502 plain-string variants
 * tolerated). 404/503 before the backend lands → ExaApiError with the HTTP
 * status, so every caller can render an honest "unavailable" line.
 */
export async function fetchExaJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch {
    throw new ExaApiError("Network request failed", 0, null);
  }
  const body = (await res.json().catch(() => null)) as (T & ErrorEnvelope) | null;
  if (!res.ok || !body || body.ok === false) {
    const raw = body?.error;
    const message =
      typeof raw === "string"
        ? raw
        : (raw && typeof raw.message === "string" ? raw.message : `Request failed (HTTP ${res.status})`);
    const code = typeof raw === "object" && raw !== null ? raw.code ?? null : null;
    throw new ExaApiError(message, res.status, code);
  }
  return body;
}

/** EXA_NOT_CONFIGURED detection tolerant to code OR message encoding. */
export function isNotConfigured(err: unknown): boolean {
  if (err instanceof ExaApiError) {
    return err.code === "EXA_NOT_CONFIGURED" || err.message.includes("EXA_NOT_CONFIGURED");
  }
  return err instanceof Error && err.message.includes("EXA_NOT_CONFIGURED");
}

/** Rate-limit detection (HTTP 429 / RATE_LIMITED code) for honest toasts. */
export function isRateLimited(err: unknown): boolean {
  return (
    err instanceof ExaApiError && (err.status === 429 || err.code === "RATE_LIMITED")
  );
}

/** Hostname for citation rows when the title is empty (never throws). */
export function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** date-fns relative time, null-safe against missing/invalid timestamps. */
export function relativeTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return formatDistanceToNow(d, { addSuffix: true });
}
