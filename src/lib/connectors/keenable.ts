import { db } from "@/lib/db";
import { decryptSecret, maskSecret } from "@/lib/crypto";

/**
 * NEXUS OS v37.1 — Keenable connector: the FREE web research lane.
 *
 * Owner paste 2026-10-30: key with **100,000 free requests** (renews Nov 29),
 * 10 req/s org limit; SELECT (table answers) free until Nov 1. The capture's
 * entire partner-MCP catalog (xAI, Higgsfield, OpenReview, OpenRouter,
 * Letterboxd, ElevenLabs, AA benchmarks…) rides on this one API.
 *
 * Honesty ledger [MEASURED 2026-10-30 04:45 +03, owner's real key]:
 * - `POST /v1/search` {query, max_results?} → 200
 *   {query, mode:"pro", results:[{title, url, description, snippet, acquired_at, published_at?}]}
 *   Probe "DJ Nikolina Istanbul 74 Hall konser 26 Aralik" returned THREE
 *   ticketing sources (BUGECE, RA, Consequence) that Exa never found —
 *   the exact Turkish-collouqial failure class, for free.
 * - `GET /v1/fetch?url=…&max_chars=` → 200 {url, title, content(markdown)}
 * - WRONG path `POST /search` → {"error":"Not found"} — the docs table is
 *   literal: Search=POST /v1/search, Fetch=GET /v1/fetch.
 * - Auth: `X-API-Key: keen_…` (Bearer also works; X-API-Key wins if both).
 * - Public keyless twins exist at /v1/{search|fetch}/public with X-Keenable-Title — not
 *   used: we have a key and the org pool is ours.
 *
 * Role in the brain: Exa stays PRIMARY (owner doctrine — use the best tools
 * aggressively). Keenable is the FREE fallback for exactly two classes:
 *   1. Exa returned irrelevant/empty AND the research gate still wants sources
 *      (the Nikolina class: Exa → pipe-smoking guides).
 *   2. Query classes where Exa burn is not worth it (low-stakes chit-chat
 *      research the gate currently drops) — free lane answers with sources.
 * Date filters: published_after/before, acquired_after/before, query_time
 * (point-in-time) — passed through when provided; relative deltas like "7d"
 * are accepted by the API [EXTERNAL doc ground truth].
 */

export const KEENABLE_SERVICE = "keenable";
export const KEENABLE_LABEL = "api";
export const KEENABLE_BASE = "https://api.keenable.ai";
export const KEENABLE_TIMEOUT_MS = 12_000;

export type KeenableResult = {
  title: string;
  url: string;
  description: string;
  snippet: string;
  acquired_at?: string;
  published_at?: string;
};

export type KeenableSearchOpts = {
  maxResults?: number;
  site?: string;
  publishedAfter?: string;
  publishedBefore?: string;
};

// ---------------------------------------------------------------------------
// Vault access
// ---------------------------------------------------------------------------

export type KeenableKeyLoad =
  | { ok: true; key: string; masked: string; keyId: string; updatedAt: string }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "unreadable" };

export async function loadKeenableKey(): Promise<KeenableKeyLoad> {
  const row = await db.credential.findUnique({
    where: { service_label: { service: KEENABLE_SERVICE, label: KEENABLE_LABEL } },
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
    return { ok: false, reason: "unreadable" };
  }
}

// ---------------------------------------------------------------------------
// HTTP core
// ---------------------------------------------------------------------------

export type KeenableCall<T> =
  | { ok: true; data: T; tookMs: number }
  | { ok: false; error: string; status: number | null; tookMs: number };

async function keenableFetch<T>(
  key: string,
  path: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number }
): Promise<KeenableCall<T>> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? KEENABLE_TIMEOUT_MS);
  try {
    const res = await fetch(`${KEENABLE_BASE}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        "X-API-Key": key,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text();
    const tookMs = Date.now() - started;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 300) };
    }
    if (!res.ok) {
      const errBody = parsed as { error?: string | { message?: string } };
      const msg =
        typeof errBody?.error === "string" ? errBody.error : JSON.stringify(errBody).slice(0, 200);
      return { ok: false, error: msg || `HTTP ${res.status}`, status: res.status, tookMs };
    }
    return { ok: true, data: parsed as T, tookMs };
  } catch (e) {
    const tookMs = Date.now() - started;
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: msg === "The operation was aborted." ? "timeout" : msg,
      status: null,
      tookMs,
    };
  }
}

// ---------------------------------------------------------------------------
// Search — the free research fallback lane
// ---------------------------------------------------------------------------

export type KeenableSearchOutcome =
  | {
      ok: true;
      provider: "keenable";
      query: string;
      results: KeenableResult[];
      formatted: string;
      tookMs: number;
    }
  | { ok: false; provider: "keenable"; error: string; tookMs: number };

/** Compact multi-line source list for the brain's prompt cards. */
export function formatKeenableResults(query: string, results: KeenableResult[]): string {
  if (results.length === 0) return "";
  const lines = results.slice(0, 5).map((r, i) => {
    const date = r.published_at?.slice(0, 10) ?? "";
    const src = r.title ? ` — ${r.title}` : "";
    const snip = (r.snippet ?? r.description ?? "").replace(/\s+/g, " ").slice(0, 240);
    return `${i + 1}. ${r.url}${src}${date ? ` (${date})` : ""}: ${snip}`;
  });
  return `[Keenable ücretsiz web araması — "${query}"]\n${lines.join("\n")}`;
}

export async function keenableSearch(
  key: string,
  query: string,
  opts: KeenableSearchOpts = {}
): Promise<KeenableSearchOutcome> {
  const q = String(query ?? "").trim().slice(0, 400);
  if (q.length < 2) return { ok: false, provider: "keenable", error: "query too short", tookMs: 0 };
  const body: Record<string, unknown> = {
    query: q,
    max_results: Math.max(1, Math.min(10, opts.maxResults ?? 5)),
  };
  if (opts.site) body.site = opts.site;
  if (opts.publishedAfter) body.published_after = opts.publishedAfter;
  if (opts.publishedBefore) body.published_before = opts.publishedBefore;
  const res = await keenableFetch<{ results?: KeenableResult[]; mode?: string }>(key, "/v1/search", {
    method: "POST",
    body,
  });
  if (!res.ok) return { ok: false, provider: "keenable", error: res.error, tookMs: res.tookMs };
  const results = (res.data.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    description: r.description ?? "",
    snippet: r.snippet ?? "",
    acquired_at: r.acquired_at,
    published_at: r.published_at,
  }));
  return {
    ok: true,
    provider: "keenable",
    query: q,
    results,
    formatted: formatKeenableResults(q, results),
    tookMs: res.tookMs,
  };
}

// ---------------------------------------------------------------------------
// Fetch — page content as markdown (free)
// ---------------------------------------------------------------------------

export type KeenableFetchOutcome =
  | { ok: true; url: string; title: string; content: string; tookMs: number }
  | { ok: false; error: string; tookMs: number };

export async function keenableFetchPage(
  key: string,
  url: string,
  opts: { maxChars?: number; prompt?: string } = {}
): Promise<KeenableFetchOutcome> {
  const target = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(target)) {
    return { ok: false, error: "invalid url", tookMs: 0 };
  }
  const params = new URLSearchParams({ url: target });
  if (opts.maxChars) params.set("max_chars", String(Math.max(500, Math.min(50_000, opts.maxChars))));
  if (opts.prompt) params.set("prompt", String(opts.prompt).slice(0, 2_000));
  const res = await keenableFetch<{ url: string; title: string; content: string }>(
    key,
    `/v1/fetch?${params.toString()}`
  );
  if (!res.ok) return { ok: false, error: res.error, tookMs: res.tookMs };
  return {
    ok: true,
    url: res.data.url,
    title: res.data.title ?? "",
    content: res.data.content ?? "",
    tookMs: res.tookMs,
  };
}

// ---------------------------------------------------------------------------
// Status probe
// ---------------------------------------------------------------------------

export type KeenableStatusPayload = {
  configured: boolean;
  reachable: boolean | null;
  apiOk: boolean | null;
  error: string | null;
  credential: { masked: string; keyId: string; updatedAt: string } | null;
  probedAt: string | null;
  sampleResultCount: number | null;
};

export async function probeKeenable(
  key: string
): Promise<Omit<KeenableStatusPayload, "configured" | "credential">> {
  // One tiny search — proves key + endpoint + shape in a single honest call.
  const probe = await keenableSearch(key, "nexus bot agent systems", { maxResults: 2 });
  return {
    reachable: probe.tookMs > 0 && (!probe.ok ? probe.error !== "timeout" : true),
    apiOk: probe.ok,
    error: probe.ok ? null : probe.error,
    probedAt: new Date().toISOString(),
    sampleResultCount: probe.ok ? probe.results.length : null,
  };
}
