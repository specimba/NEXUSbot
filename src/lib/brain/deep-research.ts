import { db } from "@/lib/db";
import { clampStr, redactSecrets } from "@/lib/brain/auth";
import {
  exaAgentRun,
  exaAnswer,
  exaBudgetAllows,
  getExaKey,
  type ExaAgentEffort,
} from "@/lib/connectors/exa";
import { hbAgentRun, loadHyperbrowserKey } from "@/lib/connectors/hyperbrowser";
import { kickSendBotMessage } from "@/lib/connectors/kick";

/**
 * NEXUS OS — v33 DEEP RESEARCH: the live-data lanes.
 *
 * Owner directive (2026-10-27): "exa also has very good agent frontier LLM
 * usage we can spend our credits with that too fast reach meaningful searches
 * — today Israel poll happening, we need active news and poll related latest
 * up to date reliable honest answers. And more reliable hyperbrowser usage —
 * not random wasting browser and deep search words and giving shitty unrelated
 * answers out of context."
 *
 * Architecture (all routes MEASURED 2026-10-27, see connectors' headers):
 *
 *   CHAT LANE (this module)      PANEL LANE (/api/exa/research)
 *   ────────────────────────     ─────────────────────────────
 *   !ai question classified      Owner launches a run in the
 *   as poll/market/live-news →   Exa Deep Research card →
 *   cortex answers with a        ledger row (queued) → background
 *   holding line → webhook       runner: exaAgentRun → HyperAgent
 *   fires queueDeepResearch →   fallback → row completed with
 *   exaAgentRun (medium,         answer + citations + REAL cost.
 *   Polymarket etc.) → Hyper-
 *   Agent fallback → exaAnswer
 *   last resort → follow-up
 *   message posted to Kick chat
 *   + InteractionLog row.
 *
 * Why the agent and not the fast ladder: polls/odds/prices ROT FAST, and the
 * fast /answer lane answers from search snippets with no data providers. The
 * measured medium-effort agent run (Turkish structured output + Polymarket)
 * answered the Netanyahu-poll question with seat projections, live Polymarket
 * percentages, an asOf date and citations in ~60s for $0.10 — exactly the
 * "latest up to date reliable honest answers" the owner asked for. The
 * holding line covers the latency; the follow-up carries the ground truth.
 */

// ---------------------------------------------------------------------------
// Classification — NARROW by design: only questions where a live data
// provider or a real agent crawl measurably beats the fast grounded ladder.
// ---------------------------------------------------------------------------

export type DeepResearchKind = "poll" | "market" | "news";

export type DeepResearchClass = {
  deep: boolean;
  kind: DeepResearchKind;
  effort: ExaAgentEffort;
  dataSources: Array<{ provider: string }>;
};

// Polls / elections / prediction markets. Turkish chat: "anket", "seçim",
// "kim kazanacak", "kaç koltuk/sandalye", "olasılık" + English shapes.
const POLL_RE =
  /(?:anket|se[çc]im|sandalye|koltuk\s*da[ğg]|ba[sş]bakan|cumhurba[sş]kan|aday\s*kim|kim\s*kazan(?:acak|[ıi]r)|kazan(?:acak|ir)\s*m[ıi]|oy\s*oran|olas[ıi]l[ıi]k|polymarket|bahis\s*oran|prediction\s*market|who\s*will\s*win|election|\bpolls?\b|\bodds\b|seat\s*projection)/i;

// Live prices/values — requires a NOW anchor so "fiyatı neydi" (historical)
// stays on the fast research ladder.
const PRICE_THING_RE =
  /(?:fiyat|kuru?|de[ğg]er[ıi]?|hisse|borsa|btc|bitcoin|ethereum|eth\b|alt[ıi]n|dolar|euro|sterlin|gram\s*alt[ıi]n|stock|price|rate)/i;
const NOW_ANCHOR_RE =
  /(?:[sş]u\s*an|[sş]imdiki|bug[uü]n|g[uü]ncel|canl[ıi]|ka[çc]\s*(?:tl|dolar|euro|dolar|lira)|ne\s*kadar|latest|\blive\b|\bnow\b)/i;

// Live events / breaking developments on a specific topic. "son dakika" here
// is NOT the digest command ("son dakika haber özeti" stays NEWS_RE — the
// caller checks that first); this is "son dakika <topic> ne oluyor".
const LIVE_EVENT_RE =
  /(?:son\s*dakika|canl[ıi]\s*(?:sonu[çc]|skor|durum)|ma[çc]\s*(?:[sş]u\s*an|skoru|durumu|sonucu)|breaking|live\s*(?:score|result|update)|geli[sş]me\s*var\s*m[ıi]|en\s*son\s*geli[sş]meler)/i;

const URL_RE_LOCAL = /https?:\/\/[^\s]+/i;

/** Sync, allocation-free: is this a live-data question the agent lanes own? */
export function classifyDeepResearch(prompt: string): DeepResearchClass {
  const p = String(prompt || "");
  const empty: DeepResearchClass = { deep: false, kind: "news", effort: "medium", dataSources: [] };
  if (!p.trim() || p.length < 6 || URL_RE_LOCAL.test(p)) return empty;

  if (POLL_RE.test(p)) {
    return {
      deep: true,
      kind: "poll",
      effort: "medium",
      // MEASURED: polymarket data-source rides free on the run (usage
      // dataSources.polymarket cost 0 on the probe run) and answers the
      // "poll + odds" class the owner asked about.
      dataSources: [{ provider: "polymarket" }],
    };
  }
  if (PRICE_THING_RE.test(p) && NOW_ANCHOR_RE.test(p)) {
    return {
      deep: true,
      kind: "market",
      effort: "medium",
      // pyth = real-time market prices (provider string validated live).
      dataSources: [{ provider: "pyth" }, { provider: "polymarket" }],
    };
  }
  if (LIVE_EVENT_RE.test(p)) {
    return { deep: true, kind: "news", effort: "medium", dataSources: [] };
  }
  return empty;
}

// ---------------------------------------------------------------------------
// Availability + guards (single-flight, cooldown, budgets)
// ---------------------------------------------------------------------------

const CHAT_COOLDOWN_MS = 120_000;
const DEEP_USAGE_SETTING = "deep.research.usage";

type DeepUsage = {
  day: string; // YYYY-MM-DD UTC
  chatRuns: number;
  hbRuns: number;
  lastChatAt: number;
};

type DeepStores = {
  inFlight: Map<string, number>; // normalized prompt → started-at
  lastChatRunAt: number;
};
const deepStores: DeepStores = (() => {
  const g = globalThis as typeof globalThis & { __nexusDeepStores?: DeepStores };
  if (!g.__nexusDeepStores) g.__nexusDeepStores = { inFlight: new Map(), lastChatRunAt: 0 };
  return g.__nexusDeepStores;
})();

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function readUsage(): Promise<DeepUsage> {
  const row = await db.setting.findUnique({ where: { key: DEEP_USAGE_SETTING } }).catch(() => null);
  try {
    const parsed = row?.value ? (JSON.parse(row.value) as DeepUsage) : null;
    if (parsed && parsed.day === todayUtc()) return parsed;
  } catch {
    /* fresh below */
  }
  return { day: todayUtc(), chatRuns: 0, hbRuns: 0, lastChatAt: 0 };
}

async function writeUsage(u: DeepUsage): Promise<void> {
  await db.setting
    .upsert({
      where: { key: DEEP_USAGE_SETTING },
      create: { key: DEEP_USAGE_SETTING, value: JSON.stringify(u) },
      update: { value: JSON.stringify(u) },
    })
    .catch(() => {});
}

/** Hyperbrowser daily cap (chat + panel lanes share it). HB credits are the
 *  scarcer pool; Exa agent runs have their own exaBudgetAllows("agent"). */
const HB_DAILY_CAP = 10;

async function hbBudgetAllows(): Promise<boolean> {
  const u = await readUsage();
  return u.hbRuns < HB_DAILY_CAP;
}

export type DeepResearchAvailability = {
  ok: boolean;
  reason: string;
  hyper: boolean;
};

/**
 * Gate for the CHAT lane. Returns ok:false with an honest reason when the
 * question should fall through to the normal fast research ladder (never
 * promise a follow-up we cannot deliver).
 */
export async function deepResearchAvailable(cls: DeepResearchClass): Promise<DeepResearchAvailability> {
  const hyper = (await loadHyperbrowserKey()).ok;
  if (!cls.deep) return { ok: false, reason: "not a deep question", hyper };
  const exaArmed = Boolean(await getExaKey());
  if (!exaArmed) return { ok: false, reason: "exa key not configured", hyper };
  if (!(await exaBudgetAllows("agent"))) return { ok: false, reason: "agent budget exhausted", hyper };
  if (deepStores.inFlight.size > 0) return { ok: false, reason: "a deep run is already in flight", hyper };
  if (Date.now() - deepStores.lastChatRunAt < CHAT_COOLDOWN_MS) {
    return { ok: false, reason: "chat cooldown active", hyper };
  }
  return { ok: true, reason: "", hyper };
}

// ---------------------------------------------------------------------------
// Chat lane — follow-up message + interaction log row
// ---------------------------------------------------------------------------

const CHAT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description:
        "Answer in TURKISH (Türkçe), 2-4 sentences, max 60 words, plain text, no emojis, no markdown, no URLs inside the answer. Give concrete numbers with dates.",
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    keyFacts: {
      type: "array",
      items: { type: "string" },
      description: "Max 3 most important facts in Turkish, each under 12 words.",
    },
    asOf: { type: "string", description: "Date the data is current as of (YYYY-MM-DD)" },
  },
  required: ["answer"],
};

function kindDirective(kind: DeepResearchKind, prompt: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const base = `Kick canlı yayın sohbetinden izleyici sorusu: "${prompt}" — bugünün tarihi ${today}.`;
  if (kind === "poll") {
    return (
      base +
      " Research the LATEST polling / election data and live prediction-market odds for this exact question (a Polymarket data source is attached). Give this week's numbers: seat counts, percentages, odds, with the dates they were published. The 'answer' field MUST be in Turkish."
    );
  }
  if (kind === "market") {
    return (
      base +
      " Research the CURRENT live value/price for this exact question (real-time price data sources are attached). Give the current number, the 24h change if relevant, and the timestamp of the data. The 'answer' field MUST be in Turkish."
    );
  }
  return (
    base +
    " Research the LATEST developments on this exact topic from the last 48 hours. Report only what reliable recent sources actually say, with dates. The 'answer' field MUST be in Turkish."
  );
}

function hbTaskTemplate(prompt: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    `You are the research agent for a live-stream AI. A viewer asked (Turkish): "${prompt}"`,
    `Today's date: ${today}.`,
    "STRICT RULES:",
    "1. Research THIS exact question only — do not wander into related topics.",
    "2. Prefer primary, recent sources (last 7 days for news, polls, prices).",
    "3. If you cannot find reliable current data, say so plainly — NEVER invent numbers or dates.",
    "4. Answer in TURKISH, 2-4 sentences, max 60 words, plain text, no emojis, no markdown.",
    "5. End your answer with the source domains you actually read, like: (kaynak: site1.com, site2.com)",
  ].join("\n");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Kick clamp is transport-level (480 graphemes); stay tighter here for a
 *  readable follow-up: answer + data date + up to 2 source hosts. */
function formatChatFollowUp(
  winner: string,
  answer: string,
  asOf: string,
  hosts: string[],
): string {
  const bits: string[] = [];
  const clean = answer.replace(/\s+/g, " ").trim();
  bits.push(`Güncel veri: ${clean}`);
  const today = todayUtc();
  if (asOf && asOf !== today) bits.push(`(veri tarihi: ${asOf})`);
  const uniqueHosts = Array.from(new Set(hosts.filter(Boolean))).slice(0, 2);
  if (uniqueHosts.length) bits.push(`kaynak: ${uniqueHosts.join(", ")}`);
  return clampStr(bits.join(" — "), 460);
}

async function writeDeepRow(opts: {
  channel: string;
  sender: string;
  prompt: string;
  reply: string;
  modelLabel: string;
  modelId: string;
  provider: string;
  latencyMs: number;
}): Promise<void> {
  try {
    await db.interactionLog.create({
      data: {
        channel: clampStr(opts.channel, 40).toLowerCase() || "specimba",
        username: opts.sender.toLowerCase().replace(/[^a-z0-9_]/g, "") || "izleyici",
        displayHandle: clampStr(opts.sender, 60),
        command: "ai",
        message: clampStr(redactSecrets(opts.prompt), 2000),
        response: clampStr(redactSecrets(opts.reply), 2000),
        model: clampStr(opts.modelLabel, 80),
        modelId: clampStr(opts.modelId, 120),
        provider: opts.provider.toLowerCase(),
        route: "panel-cortex/cortex-deep",
        status: "ok",
        latencyMs: Math.min(600_000, Math.max(0, Math.round(opts.latencyMs))),
        promptTokens: null,
        completionTokens: null,
        webUsed: true,
        flags: "[]",
        injectionScore: 0,
        memoryUsed: false,
        error: "",
      },
    });
  } catch {
    /* observability only */
  }
}

/**
 * Fire-and-forget chat deep research. Called by the webhook AFTER the
 * holding-line reply was sent; posts the follow-up message + log row when
 * the agent lanes finish. Guards: single-flight, 120s cooldown, daily
 * budgets (exa agent via its own ledger, hyperbrowser via HB_DAILY_CAP).
 */
export async function queueDeepResearch(opts: {
  channel: string;
  sender: string;
  prompt: string;
  kind: DeepResearchKind;
  effort: ExaAgentEffort;
}): Promise<boolean> {
  const norm = opts.prompt.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 160);
  if (deepStores.inFlight.has(norm)) return false;
  if (deepStores.inFlight.size > 0) return false; // one lane at a time globally
  if (Date.now() - deepStores.lastChatRunAt < CHAT_COOLDOWN_MS) return false;
  deepStores.inFlight.set(norm, Date.now());
  deepStores.lastChatRunAt = Date.now();
  const started = Date.now();

  try {
    const usage = await readUsage();
    usage.chatRuns += 1;
    usage.lastChatAt = Date.now();
    await writeUsage(usage);

    // Lane 1 — Exa Agent (measured medium ≈ 60s / $0.10 with data sources).
    const agent = await exaAgentRun({
      query: kindDirective(opts.kind, opts.prompt),
      effort: opts.effort,
      dataSources: classifyDeepResearch(opts.prompt).dataSources,
      outputSchema: CHAT_OUTPUT_SCHEMA,
      pollBudgetMs: 110_000,
    });
    if (agent.ok) {
      const reply = formatChatFollowUp(
        "exa",
        agent.answer,
        agent.asOf,
        agent.citations.map((c) => hostOf(c.url)),
      );
      const send = await kickSendBotMessage(reply);
      console.log(
        `[deep-research] exa-agent ok kind=${opts.kind} effort=${agent.effort} run=${agent.runId} ${agent.tookMs}ms cost=${agent.costUsd ?? "?"} send=${send.ok ? "sent" : `FAIL:${send.code ?? "?"}`}`,
      );
      await writeDeepRow({
        channel: opts.channel,
        sender: opts.sender,
        prompt: opts.prompt,
        reply,
        modelLabel: `EXA AGENT // ${agent.effort.toUpperCase()}`,
        modelId: `exa:agent:${agent.effort}`,
        provider: "exa",
        latencyMs: Date.now() - started,
      });
      return true;
    }
    console.warn(`[deep-research] exa-agent lane failed: ${agent.error}`);

    // Lane 2 — HyperAgent browser fallback (only when configured + budget).
    if ((await loadHyperbrowserKey()).ok && (await hbBudgetAllows())) {
      const hb = await hbAgentRun({
        task: hbTaskTemplate(opts.prompt),
        llm: "claude-sonnet-4-6",
        maxSteps: 18,
        pollBudgetMs: 100_000,
      });
      const u2 = await readUsage();
      u2.hbRuns += 1;
      await writeUsage(u2);
      if (hb.ok) {
        const reply = formatChatFollowUp("hyper", hb.finalResult, "", []);
        const send = await kickSendBotMessage(reply);
        console.log(
          `[deep-research] hyperagent ok job=${hb.jobId} steps=${hb.stepsCompleted ?? "?"} ${hb.tookMs}ms send=${send.ok ? "sent" : `FAIL:${send.code ?? "?"}`}`,
        );
        await writeDeepRow({
          channel: opts.channel,
          sender: opts.sender,
          prompt: opts.prompt,
          reply,
          modelLabel: "HYPER // BROWSER RESEARCH",
          modelId: `hyper:agent:${hb.llm}`,
          provider: "hyperbrowser",
          latencyMs: Date.now() - started,
        });
        return true;
      }
      console.warn(`[deep-research] hyperagent lane failed: ${hb.error}`);
    }

    // Lane 3 — fast grounded /answer as the honest last resort.
    const fast = await exaAnswer(
      opts.prompt,
      "Sen bir Kick yayınının AI komutanısın. Türkçe, KISA (2-4 cümle, max 60 kelime), güncel veriyi net ver. Kaynak ekleme; sadece cevabı yaz.",
    );
    if (fast.ok && fast.answer.trim()) {
      const hosts = (fast.citations ?? []).map((c) => hostOf(c.url ?? "")).filter(Boolean);
      const reply = formatChatFollowUp("exa-fast", fast.answer, "", hosts);
      const send = await kickSendBotMessage(reply);
      console.log(`[deep-research] exa-answer fallback ok ${fast.tookMs}ms send=${send.ok ? "sent" : `FAIL:${send.code ?? "?"}`}`);
      await writeDeepRow({
        channel: opts.channel,
        sender: opts.sender,
        prompt: opts.prompt,
        reply,
        modelLabel: "VYCE // EXA ANSWER",
        modelId: "exa:answer",
        provider: "exa",
        latencyMs: Date.now() - started,
      });
      return true;
    }

    // All lanes missed — the honest line. Never invented data.
    const floor = "Derin hatlar bu soruda yavaş kaldı — kusura bakma, birkaç dakika sonra tekrar atarsan net kaynaklı cevabı koyarım.";
    const send = await kickSendBotMessage(floor);
    console.warn(`[deep-research] all lanes failed; floor send=${send.ok}`);
    await writeDeepRow({
      channel: opts.channel,
      sender: opts.sender,
      prompt: opts.prompt,
      reply: floor,
      modelLabel: "STATIC // NEXUS-CORTEX",
      modelId: "static-floor",
      provider: "tool",
      latencyMs: Date.now() - started,
    });
    return false;
  } finally {
    deepStores.inFlight.delete(norm);
  }
}

// ---------------------------------------------------------------------------
// Panel lane — the /api/exa/research job ledger (Task 15-a backend, v33)
// ---------------------------------------------------------------------------

export const RESEARCH_LEDGER_KEY = "exa.research.ledger";

export type ResearchJobRow = {
  id: string;
  provider: "exa" | "hyperbrowser";
  query: string;
  effort: string;
  status: "queued" | "running" | "completed" | "failed" | "stopped";
  stopReason: string | null;
  answer: string;
  keyFacts: string[];
  citations: Array<{ title: string; url: string }>;
  structured: Record<string, unknown> | null;
  costDollars: number | null;
  tookMs: number | null;
  error: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

async function readLedger(): Promise<ResearchJobRow[]> {
  const row = await db.setting.findUnique({ where: { key: RESEARCH_LEDGER_KEY } }).catch(() => null);
  try {
    const list = row?.value ? (JSON.parse(row.value) as ResearchJobRow[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function writeLedger(list: ResearchJobRow[]): Promise<void> {
  await db.setting
    .upsert({
      where: { key: RESEARCH_LEDGER_KEY },
      create: { key: RESEARCH_LEDGER_KEY, value: JSON.stringify(list) },
      update: { value: JSON.stringify(list) },
    })
    .catch(() => {});
}

export async function listResearchJobs(): Promise<ResearchJobRow[]> {
  const list = await readLedger();
  // newest first for the card
  return list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export async function getResearchJob(id: string): Promise<ResearchJobRow | null> {
  const list = await readLedger();
  return list.find((j) => j.id === id) ?? null;
}

async function patchJob(id: string, patch: Partial<ResearchJobRow>): Promise<void> {
  const list = await readLedger();
  const idx = list.findIndex((j) => j.id === id);
  if (idx === -1) return;
  list[idx] = { ...list[idx], ...patch, updatedAt: new Date().toISOString() };
  await writeLedger(list);
}

async function runPanelJob(id: string, query: string, effort: ExaAgentEffort, hyperArmed: boolean): Promise<void> {
  const started = Date.now();
  await patchJob(id, { status: "running" });

  // Lane 1 — Exa Agent. Panel runs are free-form (no outputSchema): the
  // measured no-schema runs still return grounding citations and the agent's
  // own markdown synthesis reads better in the card's answer pane.
  const agent = await exaAgentRun({
    query,
    effort,
    dataSources: classifyDeepResearch(query).deep ? classifyDeepResearch(query).dataSources : undefined,
    pollBudgetMs: undefined, // effort-calibrated default (up to 10min for ultra)
  });

  const current = await getResearchJob(id);
  if (!current || current.status === "stopped") {
    // Owner stopped it mid-flight; the result (and its cost) is discarded
    // honestly — the exa usage ledger still recorded the spend.
    return;
  }

  if (agent.ok) {
    await patchJob(id, {
      status: "completed",
      provider: "exa",
      answer: agent.answer,
      keyFacts: agent.keyFacts,
      citations: agent.citations,
      structured: agent.structured,
      costDollars: agent.costUsd,
      tookMs: agent.tookMs,
      stopReason: agent.stopReason,
      error: "",
      completedAt: new Date().toISOString(),
    });
    return;
  }

  // Lane 2 — HyperAgent fallback (strict template, reliable browser lane).
  if (hyperArmed && (await hbBudgetAllows())) {
    const hb = await hbAgentRun({
      task: hbTaskTemplate(query),
      llm: "claude-sonnet-4-6",
      maxSteps: 24,
      pollBudgetMs: 180_000,
    });
    const u = await readUsage();
    u.hbRuns += 1;
    await writeUsage(u);
    if (hb.ok) {
      await patchJob(id, {
        status: "completed",
        provider: "hyperbrowser",
        answer: hb.finalResult,
        keyFacts: [],
        citations: [],
        structured: null,
        costDollars: null,
        tookMs: hb.tookMs,
        stopReason: null,
        error: "",
        completedAt: new Date().toISOString(),
      });
      return;
    }
    await patchJob(id, {
      status: "failed",
      error: `exa: ${agent.error} | hyperbrowser: ${hb.error}`,
      tookMs: Date.now() - started,
      completedAt: new Date().toISOString(),
    });
    return;
  }

  await patchJob(id, {
    status: "failed",
    error: agent.error,
    tookMs: agent.tookMs,
    completedAt: new Date().toISOString(),
  });
}

export type LaunchResult =
  | { ok: true; job: ResearchJobRow }
  | { ok: false; code: "EXA_NOT_CONFIGURED" | "EXA_BUDGET_EXHAUSTED" | "TOO_MANY_ACTIVE" | "BAD_INPUT"; message: string };

/** Launch a panel deep-research run (returns immediately; runner polls). */
export async function launchPanelResearch(opts: {
  query: string;
  effort: ExaAgentEffort;
}): Promise<LaunchResult> {
  const query = clampStr(opts.query, 2_000).trim();
  if (query.length < 3) return { ok: false, code: "BAD_INPUT", message: "query must be at least 3 chars" };

  const key = await getExaKey();
  if (!key) return { ok: false, code: "EXA_NOT_CONFIGURED", message: "Save your Exa API key first" };
  if (!(await exaBudgetAllows("agent"))) {
    return { ok: false, code: "EXA_BUDGET_EXHAUSTED", message: "Daily agent-run budget exhausted — raise it in the Exa connector card" };
  }

  const list = await readLedger();
  const active = list.filter((j) => j.status === "queued" || j.status === "running").length;
  if (active >= 2) return { ok: false, code: "TOO_MANY_ACTIVE", message: "Two runs are already in flight — wait for one to finish" };

  const hyperArmed = (await loadHyperbrowserKey()).ok;
  const now = new Date().toISOString();
  const job: ResearchJobRow = {
    id: `panel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    provider: "exa",
    query,
    effort: opts.effort,
    status: "queued",
    stopReason: null,
    answer: "",
    keyFacts: [],
    citations: [],
    structured: null,
    costDollars: null,
    tookMs: null,
    error: "",
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  await writeLedger([job, ...list].slice(0, 30));
  void runPanelJob(job.id, query, opts.effort, hyperArmed).catch(async (e) => {
    await patchJob(job.id, {
      status: "failed",
      error: e instanceof Error ? e.message : "runner crashed",
      completedAt: new Date().toISOString(),
    }).catch(() => undefined);
  });
  return { ok: true, job };
}

/** Owner pressed Stop: mark stopped; the runner discards the late result. */
export async function stopResearchJob(id: string): Promise<ResearchJobRow | null> {
  const job = await getResearchJob(id);
  if (!job) return null;
  if (job.status === "queued" || job.status === "running") {
    await patchJob(id, { status: "stopped", stopReason: "halted by owner" });
  }
  return (await getResearchJob(id)) ?? job;
}
