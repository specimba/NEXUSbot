import { db } from "@/lib/db";
import { decryptSecret, maskSecret } from "@/lib/crypto";

/**
 * Hyperbrowser REST connector (T-205) — browser-agent sessions (REST + CDP).
 *
 * Honesty ledger (probed from this sandbox, 2026-10-22):
 *
 * [MEASURED]
 * - `GET https://api.hyperbrowser.ai/v1/health` → 404 (Express HTML "Cannot GET") —
 *   there is NO `/v1` prefix on the API host.
 * - `GET /v1/sessions`, `POST /v1/session`, `GET /v1/session/{id}` → all 404 HTML.
 * - `GET https://app.hyperbrowser.ai/api/health` → 401 JSON `{"error":"NOT AUTHENTICATED"}`.
 * - `GET https://api.hyperbrowser.ai/api/sessions` (no key / fake key) → 401 JSON
 *   `{"error":"NOT AUTHENTICATED"}`; `POST /api/session` and `GET /api/session/{id}`
 *   with a fake key → same 401 JSON. A JSON 401 therefore proves the route exists
 *   AND the key was rejected (unknown routes answer with HTML 404 instead).
 * - Official docs (fetched live): base `https://api.hyperbrowser.ai/api`, auth via
 *   the `x-api-key` header, `POST /api/session`, `GET /api/sessions`,
 *   `GET /api/session/{id}`.
 *
 * [INFERRED — from the docs text only; not live-verifiable without a real key]
 * - Success shapes: list payload is `{ sessions: [...] }` (or a bare array);
 *   session objects carry `id`, `status`, `webdriverEndpoint`, `viewport`,
 *   `startTime`, `endTime`. Types below therefore use optional fields with a
 *   string-index fallback and every consumer must tolerate absence.
 *
 * Design rules:
 * - Base URL is config-driven (`HYPERBROWSER_BASE_URL`, names only — P7-safe) so a
 *   route change can be patched without a code release.
 * - Every failure surfaces as a typed result — no throws across the network boundary.
 * - The API key is NEVER logged, echoed, or embedded into error strings.
 */

export const HYPERBROWSER_SERVICE = "hyperbrowser";
export const HYPERBROWSER_LABEL = "default";

/** Shape returned by GET /api/connectors/hyperbrowser/status (shared with the panel card). */
export type HyperbrowserStatusPayload = {
  configured: boolean;
  reachable: boolean | null;
  apiOk: boolean | null;
  error: string | null;
  credential: { masked: string; keyId: string; updatedAt: string } | null;
  probedAt: string | null;
  probeTarget: string;
  sessionsCount: number | null;
};

const DEFAULT_BASE_URL = "https://api.hyperbrowser.ai";
export const HYPERBROWSER_TIMEOUT_MS = 8_000;

/** Config-driven base URL (trailing slashes trimmed). Hostname only — never a secret. */
export function hyperbrowserBaseUrl(): string {
  const raw = process.env.HYPERBROWSER_BASE_URL?.trim();
  return (raw && raw.length > 0 ? raw : DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** Public host of the probe target (safe to display in the panel). */
export function hyperbrowserProbeTarget(): string {
  try {
    return new URL(hyperbrowserBaseUrl()).host;
  } catch {
    return hyperbrowserBaseUrl();
  }
}

// ---------------------------------------------------------------------------
// Vault access
// ---------------------------------------------------------------------------

export type HyperbrowserKeyLoad =
  | { ok: true; key: string; masked: string; keyId: string; updatedAt: string }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "unreadable" };

/**
 * Loads the Hyperbrowser key from the encrypted vault (service "hyperbrowser",
 * label "default"). Plaintext exists only inside the calling process; the masked
 * preview (last 4 chars) is safe for the panel. Never logs the key (P7).
 */
export async function loadHyperbrowserKey(): Promise<HyperbrowserKeyLoad> {
  const row = await db.credential.findUnique({
    where: { service_label: { service: HYPERBROWSER_SERVICE, label: HYPERBROWSER_LABEL } },
  });
  if (!row) return { ok: false, reason: "missing" };
  try {
    const key = decryptSecret(row.cipher);
    return {
      ok: true,
      key,
      masked: maskSecret(key),
      keyId: row.keyId,
      updatedAt: row.updatedAt.toISOString(),
    };
  } catch {
    // VaultIntegrityError or anything else — honest "unreadable", zero key leakage.
    return { ok: false, reason: "unreadable" };
  }
}

// ---------------------------------------------------------------------------
// Typed REST client
// ---------------------------------------------------------------------------

/** [INFERRED from docs] Session object — all fields optional, tolerate unknown shape. */
export type HyperbrowserSession = {
  id?: string;
  status?: string;
  webdriverEndpoint?: string;
  viewport?: { width?: number; height?: number };
  startTime?: string;
  endTime?: string;
  [key: string]: unknown;
};

export type HyperbrowserSessionList = HyperbrowserSession[] | { sessions?: HyperbrowserSession[] };

/** [INFERRED from docs] Minimal create-session options. */
export type HyperbrowserCreateSessionOpts = {
  useStealth?: boolean;
  useProxy?: boolean;
  acceptCookies?: boolean;
};

export type HyperbrowserFailure =
  | { ok: false; kind: "network"; error: string }
  | { ok: false; kind: "timeout"; error: string }
  | { ok: false; kind: "http"; status: number; error: string }
  | { ok: false; kind: "parse"; status: number; error: string };

export type HyperbrowserResult<T> = { ok: true; status: number; data: T } | HyperbrowserFailure;

async function hbFetch<T>(
  apiKey: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<HyperbrowserResult<T>> {
  const method = init?.method ?? "GET";
  let res: Response;
  try {
    res = await fetch(`${hyperbrowserBaseUrl()}${path}`, {
      method,
      headers: {
        "x-api-key": apiKey,
        ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(HYPERBROWSER_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        ok: false,
        kind: "timeout",
        error: `Hyperbrowser API did not respond within ${HYPERBROWSER_TIMEOUT_MS / 1000}s`,
      };
    }
    return {
      ok: false,
      kind: "network",
      error: `network error reaching Hyperbrowser: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      // body unreadable — status code alone still surfaces honestly
    }
    return {
      ok: false,
      kind: "http",
      status: res.status,
      error: `Hyperbrowser API HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    };
  }

  try {
    return { ok: true, status: res.status, data: (await res.json()) as T };
  } catch {
    return { ok: false, kind: "parse", status: res.status, error: "Hyperbrowser API returned a non-JSON body" };
  }
}

/** POST /api/session — create a browser session. [ROUTE VERIFIED; 200 shape INFERRED] */
export function createHyperbrowserSession(
  apiKey: string,
  opts: HyperbrowserCreateSessionOpts = {},
): Promise<HyperbrowserResult<HyperbrowserSession>> {
  return hbFetch<HyperbrowserSession>(apiKey, "/api/session", {
    method: "POST",
    body: opts,
  });
}

/** GET /api/sessions — list sessions. [ROUTE VERIFIED (401 shape); list shape INFERRED] */
export function listHyperbrowserSessions(
  apiKey: string,
): Promise<HyperbrowserResult<HyperbrowserSessionList>> {
  return hbFetch<HyperbrowserSessionList>(apiKey, "/api/sessions");
}

/** GET /api/session/{id} — session detail. [ROUTE VERIFIED (401 shape); 200 shape INFERRED] */
export function getHyperbrowserSession(
  apiKey: string,
  sessionId: string,
): Promise<HyperbrowserResult<HyperbrowserSession>> {
  return hbFetch<HyperbrowserSession>(
    apiKey,
    `/api/session/${encodeURIComponent(sessionId)}`,
  );
}

// ---------------------------------------------------------------------------
// Live probe (used by the status route)
// ---------------------------------------------------------------------------

export type HyperbrowserProbe =
  | { ok: true; sessionsCount: number | null }
  | { ok: false; kind: "auth" | "http" | "timeout" | "network" | "parse"; status?: number; error: string };

/**
 * Cheapest authenticated read (GET /api/sessions). Distinguishes:
 * - ok            → key accepted, API healthy
 * - kind "auth"   → host reachable, key rejected (401)
 * - kind "http"   → host reachable, other API error
 * - kind "parse"  → host reachable, unexpected body
 * - kind "timeout"/"network" → host not reachable
 */
export async function probeHyperbrowser(apiKey: string): Promise<HyperbrowserProbe> {
  const r = await listHyperbrowserSessions(apiKey);
  if (r.ok) {
    const d: unknown = r.data;
    let count: number | null = null;
    if (Array.isArray(d)) count = d.length;
    else if (d && typeof d === "object") {
      const sessions = (d as { sessions?: unknown }).sessions;
      if (Array.isArray(sessions)) count = sessions.length;
    }
    return { ok: true, sessionsCount: count };
  }
  if (r.kind === "http" && r.status === 401) {
    return { ok: false, kind: "auth", status: 401, error: "Hyperbrowser rejected the stored key (HTTP 401)" };
  }
  return { ok: false, kind: r.kind, status: r.kind === "http" || r.kind === "parse" ? r.status : undefined, error: r.error };
}

// ---------------------------------------------------------------------------
// HyperAgent tasks (v33) — browser deep-research lane.
//
// MEASURED with the live vault key, 2026-10-27 19:27 +03 (temp-hb-agent-probe):
//   POST /api/task/hyper-agent  {version:"1.1.0", task, llm, maxSteps}
//     → 200 {jobId, liveUrl, liveDomain}
//   GET  /api/task/hyper-agent/{jobId}
//     → 200 {jobId, status:"running"|"completed"|"failed", createdAt, finishedAt,
//            data:{steps:[…], finalResult:"…"},
//            metadata:{inputTokens, outputTokens, numTaskStepsCompleted},
//            error:null, liveUrl, jobParams:{…}}
//   PUT  /api/task/hyper-agent/{jobId}/stop   (docs; stop-before-complete)
//   MEASURED: gemini-3-flash-preview, 2-step read task → ~11s end-to-end.
//   llm options (docs): gpt-4o, gpt-5.2, claude-sonnet-4-6, claude-haiku-5-5,
//     gemini-3-flash-preview, …
// The 8s HYPERBROWSER_TIMEOUT_MS is for session reads; task create + detail
// fetches use their own longer budget (below) — a cloud browser step can
// legitimately take tens of seconds, and the poll loop carries the wait.
// ---------------------------------------------------------------------------

export type HyperAgentLlm = "gemini-3-flash-preview" | "claude-sonnet-4-6" | "claude-haiku-5-5" | "gpt-4o" | "gpt-5.2";

export type HyperAgentRunOpts = {
  /** Clear, specific task description (the docs' #1 best practice — vague
   *  tasks wander; the owner's "random wasting browser" complaint). */
  task: string;
  llm?: HyperAgentLlm;
  maxSteps?: number;
  /** Wall-clock wait budget; the session closes at completion either way. */
  pollBudgetMs?: number;
};

export type HyperAgentRunOutcome =
  | {
      ok: true;
      jobId: string;
      finalResult: string;
      status: string;
      stepsCompleted: number | null;
      tookMs: number;
      llm: string;
    }
  | { ok: false; error: string; tookMs: number; jobId?: string; status?: string };

const AGENT_FETCH_TIMEOUT_MS = 20_000;

/**
 * Run one HyperAgent task to completion (create → poll → finalResult).
 * Grounded-browser lane for questions the search agent misses: the task
 * template must name the exact question + require the agent to cite what it
 * actually saw — no free-roaming.
 */
export async function hbAgentRun(opts: HyperAgentRunOpts): Promise<HyperAgentRunOutcome> {
  const started = Date.now();
  const keyLoad = await loadHyperbrowserKey();
  if (!keyLoad.ok) {
    return { ok: false, error: keyLoad.reason === "missing" ? "HYPERBROWSER_API_KEY not configured" : "stored key unreadable", tookMs: 0 };
  }
  const task = opts.task.trim().slice(0, 4_000);
  if (!task) return { ok: false, error: "empty task", tookMs: 0 };

  const llm: HyperAgentLlm = opts.llm ?? "gemini-3-flash-preview";
  const maxSteps = Math.min(40, Math.max(4, opts.maxSteps ?? 20));
  const budget = opts.pollBudgetMs ?? 120_000;

  // Create (route MEASURED; 200 shape {jobId, liveUrl}).
  let jobId = "";
  try {
    const res = await fetch(`${hyperbrowserBaseUrl()}/api/task/hyper-agent`, {
      method: "POST",
      headers: { "x-api-key": keyLoad.key, "content-type": "application/json" },
      body: JSON.stringify({ version: "1.1.0", task, llm, maxSteps }),
      cache: "no-store",
      signal: AbortSignal.timeout(AGENT_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      return { ok: false, error: `HyperAgent create HTTP ${res.status}${detail ? `: ${detail}` : ""}`, tookMs: Date.now() - started };
    }
    const j = (await res.json()) as { jobId?: string; id?: string };
    jobId = j.jobId ?? j.id ?? "";
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "HyperAgent create timed out" : `HyperAgent create failed: ${name}`, tookMs: Date.now() - started };
  }
  if (!jobId) return { ok: false, error: "HyperAgent create returned no jobId", tookMs: Date.now() - started };

  // Poll the DETAIL endpoint (status + data together; 5s interval).
  let lastStatus = "running";
  let finalResult = "";
  let steps: number | null = null;
  while (Date.now() - started < budget) {
    await new Promise((r) => setTimeout(r, 5_000));
    try {
      const res = await fetch(`${hyperbrowserBaseUrl()}/api/task/hyper-agent/${encodeURIComponent(jobId)}`, {
        headers: { "x-api-key": keyLoad.key },
        cache: "no-store",
        signal: AbortSignal.timeout(AGENT_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) continue; // transient — keep polling inside the budget
      const j = (await res.json()) as {
        status?: string;
        data?: { finalResult?: string };
        metadata?: { numTaskStepsCompleted?: number };
      };
      lastStatus = j.status ?? lastStatus;
      steps = j.metadata?.numTaskStepsCompleted ?? steps;
      if (lastStatus === "completed" || lastStatus === "failed") {
        finalResult = j.data?.finalResult ?? "";
        break;
      }
    } catch {
      /* transient poll failure — loop continues while budget remains */
    }
  }

  const tookMs = Date.now() - started;
  if (lastStatus === "completed") {
    if (!finalResult.trim()) {
      return { ok: false, jobId, status: lastStatus, error: "HyperAgent completed with empty result", tookMs };
    }
    return { ok: true, jobId, finalResult: finalResult.slice(0, 4_000), status: lastStatus, stepsCompleted: steps, tookMs, llm };
  }
  return {
    ok: false,
    jobId,
    status: lastStatus,
    error:
      lastStatus === "failed"
        ? "HyperAgent task failed"
        : `HyperAgent still ${lastStatus} after ${Math.round(budget / 1000)}s (session closes at provider; result not collected)`,
    tookMs,
  };
}
