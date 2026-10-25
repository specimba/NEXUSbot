import { db } from "@/lib/db";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import { clampStr } from "@/lib/brain/auth";

/**
 * NEXUS OS — Exa connector (v29.12): the brain's research engine.
 *
 * Why Exa FIRST: owner directive — paid credits partially expire unused on
 * quiet days, so the posture is "use the best tools aggressively, inside
 * honest budgets". Exa gives the brain what DuckDuckGo scraping never could:
 * neural/deep search, token-efficient highlights, livecrawl freshness, and an
 * /answer endpoint that returns GROUNDED text with real citations — the direct
 * fix for the research-hallucination class of failures (wrong WoW badge answer,
 * generic "GPT-4.5" news replies from ddg snippets).
 *
 * Vault layout (service "exa"):
 *   label "api" → EXA_API_KEY (Bearer; also accepted via x-api-key by Exa)
 *
 * Fallback ladder stays intact: env EXA_API_KEY → vault → null (callers then
 * fall back to the previous z-ai/ddg paths, nothing breaks without a key).
 *
 * P7 discipline: the key is decrypted transiently in-process for use/masking
 * only — never logged, never echoed, never embedded into an Error message.
 *
 * API ground truth (docs pasted by owner, 2026-10 + MEASURED E1 research, 2026-10-25):
 *   POST https://api.exa.ai/search      {query, numResults, type, contents{highlights|text|summary},
 *                                        includeDomains, excludeDomains, startPublishedDate,
 *                                        category, userLocation, livecrawl}
 *   POST https://api.exa.ai/answer      {query, text, systemPrompt?} → {answer, citations[]}
 *   POST https://api.exa.ai/contents    {urls, highlights?, text?}
 *
 * Monitors (scheduled searches → webhook) — docs.exa.ai/reference/monitors/*:
 *   GET  https://api.exa.ai/monitors?limit=&status=&cursor= → 200 {data:[…],hasMore,nextCursor}
 *   POST https://api.exa.ai/monitors
 *        {name?, search{query, numResults?, contents?} (required),
 *         trigger?{type:"interval", period},            // single duration, min 1h: 1h|6h|1d|7d…
 *         webhook{url, events?} (required),             // HTTPS, no redirects
 *         outputSchema?, metadata?}
 *        → 201 {…, webhookSecret} (one-time signing secret — stored in the vault)
 *   MEASURED (unauth + live-key probes, 2026-10-25):
 *     GET  /monitors        → 200 with the stored key  ✅
 *     GET  /monitors/v1     → 404 {"error":"Search monitor not found"} ❌ (old wrong path)
 *     POST /search-monitors/v1 → 404 NOT_FOUND ❌ (the original create bug)
 *     POST /v1/monitors     → 404 ❌   ·   /websets/v1 → 401 (exists, different API)
 * Pricing (dashboard): search $4.00/1k requests, contents $1.00/1k pages,
 * answer $5.00/1k answers → used for the burn-down estimate shown in the panel.
 */

export const EXA_SERVICE = "exa";
export const EXA_KEY_LABEL = "api";
export const EXA_BASE = "https://api.exa.ai";
export const EXA_TIMEOUT_MS = 12_000;

/** Published list prices → per-request estimates for the usage card. */
export const EXA_EST_USD = {
  perSearch: 0.004,
  perContentsPage: 0.001,
  perAnswer: 0.005,
} as const;

export type ExaSearchType = "auto" | "neural" | "deep" | "fast";

export type ExaResult = {
  title: string;
  url: string;
  publishedDate: string;
  author: string;
  summary: string;
  highlight: string;
};

export type ExaSearchOutcome =
  | {
      ok: true;
      provider: "exa";
      query: string;
      type: ExaSearchType;
      results: ExaResult[];
      formatted: string;
      tookMs: number;
      estCostUsd: number;
    }
  | { ok: false; provider: "exa"; error: string; tookMs: number };

export type ExaAnswerOutcome =
  | {
      ok: true;
      provider: "exa";
      answer: string;
      citations: Array<{ title?: string; url?: string; text?: string }>;
      tookMs: number;
      estCostUsd: number;
    }
  | { ok: false; provider: "exa"; error: string; tookMs: number };

// ---------------------------------------------------------------------------
// Key resolution + storage
// ---------------------------------------------------------------------------

export async function getExaKey(): Promise<string | null> {
  const envKey = (process.env.EXA_API_KEY ?? "").trim();
  if (envKey) return envKey;
  try {
    const row = await db.credential.findFirst({
      where: { service: EXA_SERVICE, label: EXA_KEY_LABEL },
      orderBy: { updatedAt: "desc" },
    });
    if (!row) return null;
    const plain = decryptSecret(row.cipher);
    return plain.trim() ? plain.trim() : null;
  } catch {
    return null;
  }
}

export async function setExaKey(secret: string): Promise<{ masked: string }> {
  const enc = encryptSecret(secret.trim());
  const existing = await db.credential.findFirst({
    where: { service: EXA_SERVICE, label: EXA_KEY_LABEL },
    orderBy: { updatedAt: "desc" },
  });
  if (existing) {
    await db.credential.update({
      where: { id: existing.id },
      data: { cipher: enc.cipher, keyId: enc.keyId, updatedAt: new Date() },
    });
  } else {
    await db.credential.create({
      data: { service: EXA_SERVICE, label: EXA_KEY_LABEL, cipher: enc.cipher, keyId: enc.keyId },
    });
  }
  return { masked: maskSecret(secret.trim()) };
}

// ---------------------------------------------------------------------------
// Usage ledger + budgets (Setting "exa.usage", "exa.budget")
// ---------------------------------------------------------------------------

export type ExaUsage = {
  day: string; // YYYY-MM-DD (UTC)
  search: number;
  contentsPages: number;
  answers: number;
  agentRuns: number;
  estCostUsd: number;
  lastRequestAt: string;
  lastError: string;
};

const USAGE_KEY = "exa.usage";
const BUDGET_KEY = "exa.budget";
/** Aggressive-by-design defaults — expiring credits are wasted credits. */
export const EXA_BUDGET_DEFAULTS = { dailySearch: 150, dailyAnswer: 80, dailyContents: 200 } as const;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyUsage(): ExaUsage {
  return {
    day: todayUtc(),
    search: 0,
    contentsPages: 0,
    answers: 0,
    agentRuns: 0,
    estCostUsd: 0,
    lastRequestAt: "",
    lastError: "",
  };
}

export async function getExaUsage(): Promise<ExaUsage> {
  const row = await db.setting.findUnique({ where: { key: USAGE_KEY } }).catch(() => null);
  if (!row?.value) return emptyUsage();
  try {
    const parsed = JSON.parse(row.value) as ExaUsage;
    return parsed.day === todayUtc() ? parsed : emptyUsage();
  } catch {
    return emptyUsage();
  }
}

async function saveUsage(u: ExaUsage): Promise<void> {
  await db.setting
    .upsert({
      where: { key: USAGE_KEY },
      create: { key: USAGE_KEY, value: JSON.stringify(u) },
      update: { value: JSON.stringify(u) },
    })
    .catch(() => {});
}

export type ExaUsageKind = "search" | "contents" | "answer" | "agent";

/** Bump the daily ledger; keeps midnight rollover honest. */
export async function bumpExaUsage(
  kind: ExaUsageKind,
  units: number,
  patch: { estCostUsd?: number; error?: string } = {},
): Promise<ExaUsage> {
  const u = await getExaUsage();
  if (kind === "search") u.search += units;
  else if (kind === "contents") u.contentsPages += units;
  else if (kind === "answer") u.answers += units;
  else if (kind === "agent") u.agentRuns += units;
  u.estCostUsd = Math.round((u.estCostUsd + (patch.estCostUsd ?? 0)) * 10000) / 10000;
  u.lastRequestAt = new Date().toISOString();
  if (patch.error) u.lastError = clampStr(patch.error, 200);
  await saveUsage(u);
  return u;
}

export type ExaBudget = { dailySearch: number; dailyAnswer: number; dailyContents: number };

export async function getExaBudget(): Promise<ExaBudget> {
  const row = await db.setting.findUnique({ where: { key: BUDGET_KEY } }).catch(() => null);
  if (row?.value) {
    try {
      const p = JSON.parse(row.value) as Partial<ExaBudget>;
      return {
        dailySearch: Number(p.dailySearch ?? EXA_BUDGET_DEFAULTS.dailySearch),
        dailyAnswer: Number(p.dailyAnswer ?? EXA_BUDGET_DEFAULTS.dailyAnswer),
        dailyContents: Number(p.dailyContents ?? EXA_BUDGET_DEFAULTS.dailyContents),
      };
    } catch {
      /* fall through to defaults */
    }
  }
  return { ...EXA_BUDGET_DEFAULTS };
}

export async function setExaBudget(patch: Partial<ExaBudget>): Promise<ExaBudget> {
  const cur = await getExaBudget();
  const next: ExaBudget = {
    dailySearch: Math.max(0, Math.min(1000, Math.round(patch.dailySearch ?? cur.dailySearch))),
    dailyAnswer: Math.max(0, Math.min(1000, Math.round(patch.dailyAnswer ?? cur.dailyAnswer))),
    dailyContents: Math.max(0, Math.min(2000, Math.round(patch.dailyContents ?? cur.dailyContents))),
  };
  await db.setting
    .upsert({
      where: { key: BUDGET_KEY },
      create: { key: BUDGET_KEY, value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) },
    })
    .catch(() => {});
  return next;
}

/** Honest gate — the caller decides how to degrade when false. */
export async function exaBudgetAllows(kind: "search" | "answer" | "contents"): Promise<boolean> {
  const [usage, budget] = await Promise.all([getExaUsage(), getExaBudget()]);
  if (kind === "search") return usage.search < budget.dailySearch;
  if (kind === "answer") return usage.answers < budget.dailyAnswer;
  return usage.contentsPages < budget.dailyContents;
}

// ---------------------------------------------------------------------------
// Low-level fetch
// ---------------------------------------------------------------------------

async function exaFetch<T>(
  path: string,
  body: Record<string, unknown> | null,
  timeoutMs = EXA_TIMEOUT_MS,
  method: "POST" | "GET" = "POST",
): Promise<{ ok: true; data: T; status: number } | { ok: false; error: string; status: number }> {
  const key = await getExaKey();
  if (!key) return { ok: false, error: "EXA_API_KEY not configured", status: 0 };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(EXA_BASE + path, {
      method,
      headers: {
        authorization: "Bearer " + key,
        "x-api-key": key,
        "content-type": "application/json",
      },
      body: method === "POST" && body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* body read failure is fine */
      }
      const scrubbed = detail.split(key).join("[redacted]");
      return { ok: false, error: `HTTP ${res.status} ${scrubbed}`.trim(), status: res.status };
    }
    const data = (await res.json()) as T;
    return { ok: true, data, status: res.status };
  } catch (err) {
    const name = err instanceof Error ? err.name : "FetchError";
    return { ok: false, error: name === "AbortError" ? "timeout" : name, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// High-level surfaces
// ---------------------------------------------------------------------------

export type ExaSearchOptions = {
  query: string;
  numResults?: number;
  type?: ExaSearchType;
  recencyDays?: number;
  includeDomains?: string[];
  text?: boolean;
  livecrawl?: boolean;
};

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Neural/deep search with token-efficient highlights — the brain's web eyes. */
export async function exaSearch(opts: ExaSearchOptions): Promise<ExaSearchOutcome> {
  const started = Date.now();
  const query = clampStr(opts.query, 400).trim();
  if (!query) return { ok: false, provider: "exa", error: "empty query", tookMs: 0 };

  if (!(await exaBudgetAllows("search"))) {
    return { ok: false, provider: "exa", error: "budget exhausted (daily search cap)", tookMs: Date.now() - started };
  }

  const numResults = Math.min(10, Math.max(1, Math.round(opts.numResults ?? 6)));
  const type: ExaSearchType = opts.type ?? "auto";
  const body: Record<string, unknown> = {
    query,
    numResults,
    type,
    contents: {
      highlights: { query: query.slice(0, 200), numSentences: 2 },
      summary: { query: "One-sentence summary of this page in plain language" },
    },
  };
  if (opts.recencyDays && opts.recencyDays > 0) {
    body.startPublishedDate = isoDaysAgo(Math.min(365, opts.recencyDays));
  }
  if (opts.includeDomains?.length) body.includeDomains = opts.includeDomains.slice(0, 10);
  if (opts.text) body.contents = { ...(body.contents as Record<string, unknown>), text: { maxCharacters: 1200 } };
  if (opts.livecrawl !== false) body.livecrawl = "always";

  const res = await exaFetch<{
    results?: Array<{
      title?: string;
      url?: string;
      publishedDate?: string;
      author?: string;
      summary?: string;
      highlights?: string[];
      text?: string;
    }>;
  }>("/search", body);

  if (!res.ok) {
    await bumpExaUsage("search", 0, { error: res.error });
    return { ok: false, provider: "exa", error: res.error, tookMs: Date.now() - started };
  }

  const results: ExaResult[] = (res.data.results ?? [])
    .filter((r) => r && (r.title || r.url))
    .slice(0, numResults)
    .map((r) => ({
      title: clampStr(r.title ?? "(no title)", 140),
      url: clampStr(r.url ?? "", 300),
      publishedDate: clampStr(r.publishedDate ?? "", 40),
      author: clampStr(r.author ?? "", 80),
      summary: clampStr(r.summary ?? "", 260),
      highlight: clampStr((r.highlights ?? []).join(" … "), 320),
    }));

  const formatted = results
    .map(
      (s, i) =>
        `[${i + 1}|${s.title}${s.publishedDate ? " · " + s.publishedDate.slice(0, 10) : ""}] ${s.summary || s.highlight} (${s.url})`,
    )
    .join("\n");

  await bumpExaUsage("search", 1, { estCostUsd: EXA_EST_USD.perSearch });
  return {
    ok: true,
    provider: "exa",
    query,
    type,
    results,
    formatted,
    tookMs: Date.now() - started,
    estCostUsd: EXA_EST_USD.perSearch,
  };
}

/** Exa /answer — grounded synthesis with citations. The hallucination killer. */
export async function exaAnswer(
  query: string,
  systemPrompt?: string,
): Promise<ExaAnswerOutcome> {
  const started = Date.now();
  const q = clampStr(query, 400).trim();
  if (!q) return { ok: false, provider: "exa", error: "empty query", tookMs: 0 };

  if (!(await exaBudgetAllows("answer"))) {
    return { ok: false, provider: "exa", error: "budget exhausted (daily answer cap)", tookMs: Date.now() - started };
  }

  const body: Record<string, unknown> = { query: q, text: true };
  if (systemPrompt) body.systemPrompt = clampStr(systemPrompt, 800);

  const res = await exaFetch<{
    answer?: string;
    citations?: Array<{ title?: string; url?: string; text?: string }>;
  }>("/answer", body, 15_000);

  if (!res.ok) {
    await bumpExaUsage("answer", 0, { error: res.error });
    return { ok: false, provider: "exa", error: res.error, tookMs: Date.now() - started };
  }

  const answer = clampStr(res.data.answer ?? "", 2400);
  const citations = (res.data.citations ?? [])
    .slice(0, 8)
    .map((c) => ({
      title: clampStr(c.title ?? "", 140),
      url: clampStr(c.url ?? "", 300),
      text: clampStr(c.text ?? "", 160),
    }))
    .filter((c) => c.url);

  await bumpExaUsage("answer", 1, { estCostUsd: EXA_EST_USD.perAnswer });
  return {
    ok: true,
    provider: "exa",
    answer,
    citations,
    tookMs: Date.now() - started,
    estCostUsd: EXA_EST_USD.perAnswer,
  };
}

/** Contents API — read known URLs with a guiding highlight query. */
export async function exaContents(
  urls: string[],
  highlightQuery?: string,
): Promise<
  | { ok: true; pages: Array<{ url: string; title: string; highlight: string; summary: string }>; tookMs: number }
  | { ok: false; error: string; tookMs: number }
> {
  const started = Date.now();
  const clean = urls
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, 5)
    .map((u) => u.trim());
  if (!clean.length) return { ok: false, error: "no valid urls", tookMs: 0 };
  if (!(await exaBudgetAllows("contents"))) {
    return { ok: false, error: "budget exhausted (daily contents cap)", tookMs: Date.now() - started };
  }
  const body: Record<string, unknown> = {
    urls: clean,
    highlights: highlightQuery
      ? { query: clampStr(highlightQuery, 200), numSentences: 2 }
      : { numSentences: 2 },
    summary: { query: "One-sentence summary of this page" },
  };
  const res = await exaFetch<{
    results?: Array<{ url?: string; title?: string; highlights?: string[]; summary?: string }>;
  }>("/contents", body);
  if (!res.ok) {
    await bumpExaUsage("contents", 0, { error: res.error });
    return { ok: false, error: res.error, tookMs: Date.now() - started };
  }
  const pages = (res.data.results ?? [])
    .slice(0, 5)
    .map((r) => ({
      url: clampStr(r.url ?? "", 300),
      title: clampStr(r.title ?? "", 140),
      highlight: clampStr((r.highlights ?? []).join(" … "), 320),
      summary: clampStr(r.summary ?? "", 260),
    }));
  await bumpExaUsage("contents", clean.length, { estCostUsd: EXA_EST_USD.perContentsPage * clean.length });
  return { ok: true, pages, tookMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Monitors — scheduled searches with automatic dedup, pushed to our webhook
// (docs.exa.ai/reference/monitors/*; paths MEASURED 2026-10-25 — see header)
// ---------------------------------------------------------------------------

export type ExaMonitor = {
  id: string;
  name?: string | null;
  status?: "active" | "paused" | "disabled" | string;
  state?: string; // legacy field name (kept for old UI payloads)
  search?: { query?: string; numResults?: number };
  trigger?: { type?: string; period?: string } | null;
  webhook?: { url?: string; events?: string[] };
  nextRunAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export async function exaListMonitors(): Promise<
  { ok: true; monitors: ExaMonitor[] } | { ok: false; error: string }
> {
  const res = await exaFetch<{ data?: ExaMonitor[]; monitors?: ExaMonitor[] } | ExaMonitor[]>(
    "/monitors?limit=20",
    null,
    EXA_TIMEOUT_MS,
    "GET",
  );
  if (!res.ok) return { ok: false, error: res.error };
  const data = res.data;
  const monitors = Array.isArray(data) ? data : (data.data ?? data.monitors ?? []);
  return { ok: true, monitors: monitors.slice(0, 20) };
}

export type ExaMonitorDraft = {
  query: string;
  numResults?: number;
  /** Single duration, minimum 1h (docs: 1h | 6h | 1d | 7d…). "1w" maps to "7d". */
  period?: "1h" | "6h" | "12h" | "1d" | "1w" | "7d";
  webhookUrl?: string;
  outputSchema?: Record<string, unknown>;
  name?: string;
};

/** Vault label for the one-time webhook signing secret returned at creation. */
export const EXA_WEBHOOK_SECRET_LABEL = "webhook-secret";

/** Docs: periods are single durations ≥ 1h; a week is written "7d". */
function normalizePeriod(period: ExaMonitorDraft["period"]): string {
  if (period === "1w") return "7d";
  return period ?? "1d";
}

export async function exaCreateMonitor(
  draft: ExaMonitorDraft,
): Promise<{ ok: true; monitor: ExaMonitor } | { ok: false; error: string }> {
  const query = clampStr(draft.query, 300).trim();
  if (!query) return { ok: false, error: "query required" };
  // webhook.url is REQUIRED by POST /monitors (docs) — fail fast with a clear
  // message instead of a raw 400 from Exa.
  const webhookUrl = (draft.webhookUrl ?? "").trim();
  if (!/^https:\/\//i.test(webhookUrl)) {
    return { ok: false, error: "webhook url required (must be https — Exa does not follow redirects)" };
  }
  const body: Record<string, unknown> = {
    search: { query, numResults: Math.min(50, Math.max(1, draft.numResults ?? 10)) },
    // Subscribe to completed runs explicitly — omitting `events` also delivers
    // lifecycle noise (monitor.created / run.created) to the panel webhook.
    webhook: { url: webhookUrl, events: ["monitor.run.completed"] },
    trigger: { type: "interval", period: normalizePeriod(draft.period) },
  };
  if (draft.name) body.name = clampStr(draft.name, 120);
  if (draft.outputSchema) body.outputSchema = draft.outputSchema;
  const res = await exaFetch<ExaMonitor & { webhookSecret?: string }>("/monitors", body);
  if (!res.ok) return { ok: false, error: res.error };
  // The signing secret is returned ONCE — persist it (encrypted vault) so the
  // webhook receiver can verify Exa-Signature later. Best-effort, never blocks.
  if (res.data.webhookSecret) {
    try {
      const enc = encryptSecret(res.data.webhookSecret);
      const existing = await db.credential.findUnique({
        where: { service_label: { service: EXA_SERVICE, label: EXA_WEBHOOK_SECRET_LABEL } },
      });
      if (existing) {
        await db.credential.update({
          where: { id: existing.id },
          data: { cipher: enc.cipher, keyId: enc.keyId, updatedAt: new Date() },
        });
      } else {
        await db.credential.create({
          data: {
            service: EXA_SERVICE,
            label: EXA_WEBHOOK_SECRET_LABEL,
            cipher: enc.cipher,
            keyId: enc.keyId,
          },
        });
      }
    } catch {
      /* verification stays optional; the monitor itself is already created */
    }
  }
  return { ok: true, monitor: res.data };
}

/** One-time Exa webhook signing secret (vault, decrypted transiently). */
export async function getExaWebhookSecret(): Promise<string | null> {
  try {
    const row = await db.credential.findUnique({
      where: { service_label: { service: EXA_SERVICE, label: EXA_WEBHOOK_SECRET_LABEL } },
    });
    if (!row) return null;
    const plain = decryptSecret(row.cipher).trim();
    return plain || null;
  } catch {
    return null;
  }
}

export const EXA_WEBHOOK_SETTING = "exa.webhook.inbox";
export type ExaWebhookItem = {
  receivedAt: string;
  monitorId: string;
  kind: string;
  payload: unknown;
};

export async function pushWebhookItem(item: ExaWebhookItem): Promise<void> {
  const row = await db.setting.findUnique({ where: { key: EXA_WEBHOOK_SETTING } }).catch(() => null);
  let inbox: ExaWebhookItem[] = [];
  try {
    inbox = row?.value ? (JSON.parse(row.value) as ExaWebhookItem[]) : [];
  } catch {
    inbox = [];
  }
  inbox.unshift(item);
  inbox = inbox.slice(0, 30);
  await db.setting
    .upsert({
      where: { key: EXA_WEBHOOK_SETTING },
      create: { key: EXA_WEBHOOK_SETTING, value: JSON.stringify(inbox) },
      update: { value: JSON.stringify(inbox) },
    })
    .catch(() => {});
}

export async function readWebhookInbox(): Promise<ExaWebhookItem[]> {
  const row = await db.setting.findUnique({ where: { key: EXA_WEBHOOK_SETTING } }).catch(() => null);
  try {
    return row?.value ? (JSON.parse(row.value) as ExaWebhookItem[]) : [];
  } catch {
    return [];
  }
}
