import { db } from "./db";
import {
  hyperbrowserBaseUrl,
  loadHyperbrowserKey,
} from "./connectors/hyperbrowser";
import { loadEgressPool, pickProxies, proxiedFetch } from "./egress";

/**
 * NEXUS OS — model benchmark refresh pipeline (task R18-c).
 *
 * Owner requirement: fresh model-ordering knowledge every 6 hours from six
 * sources (Artificial Analysis + five arena.ai leaderboards). This module is
 * the fetch/parse/store pipeline; the panel route, the BenchmarksCard and the
 * bench-cadence mini-service all sit on top of it.
 *
 * Honesty doctrine (P7 / §11 / [MEASURED] worklog conventions):
 * - NEVER fabricate. Entries exist only when they were actually parsed from
 *   upstream bytes; a board that parses without scores keeps rows with
 *   score:null (rank is still real data). A parse that fails the model-family
 *   sanity check is PARSE_FAILED — garbage is never stored as success.
 * - Metric honesty (R19-b): every source declares the METRIC it measures
 *   (metricLabel, e.g. "Arena Elo (chat)" vs "Net Improvement % (agent)") —
 *   boards are NEVER rendered as bare unlabeled numbers again, because a
 *   20.77 next to a 1517 is two different metrics on two different scales.
 * - Sanity-range guard (R19-b): every parsed score is checked against its
 *   kind's plausible range (BENCH_SCORE_RANGES). An out-of-range number is a
 *   parse anomaly — the entry is KEPT as a rank-only row (score:null) and a
 *   warning note is attached to the snapshot, so a future source-board
 *   redesign (score column swapped for votes/CI/…) can never silently store
 *   nonsense as if it were the metric.
 * - Failures are STORED as honest snapshots ({ok:false, error}) so the card and
 *   cadence service can report and retry them; error messages are static-ish
 *   strings — no secrets, no key material, no upstream body dumps.
 * - The Hyperbrowser key lives in the vault, is decrypted transiently in
 *   process and used only in the x-api-key header. It is never logged.
 *
 * Transport layering [MEASURED 2026-10-23]:
 * 1. Direct fetch (12 s, browser-like UA). artificialanalysis.ai answers 200
 *    in ~93 ms and embeds model data in Next.js RSC flight chunks
 *    (self.__next_f). arena.ai leaderboards answer 403 Cloudflare challenges
 *    ("Just a moment…") — direct bytes exist but carry no data → step 2.
 * 2. Hyperbrowser scrape (vault key, api.hyperbrowser.ai): POST /api/scrape
 *    {url, formats:["markdown"]} → {jobId}; poll GET /api/scrape/{jobId} until
 *    status "completed" → data.markdown (~17 s for an arena board). Versioned
 *    variants /api/v2/scrape, /v1/scrape, /api/v3/scrape all answer 404 —
 *    /api/scrape is the only live route.
 * 3. If (and only if) the DIRECT transport failed (network error — not an
 *    unparseable 200/403), retry the direct fetch through the Webshare pool
 *    (loadEgressPool → pickProxies(pool, 3) → proxiedFetch; some pool nodes
 *    are dead, 3 picks per the R18-0 measurement).
 *
 * Storage (no schema changes — Settings KV + L0 events):
 * - Snapshot JSON per kind at Setting key "bench.snapshot.<kind>" (upsert
 *   pattern mirrors ai/custom-providers.ts saveProviders).
 * - One Event row per refresh attempt: source "system", type "bench.refresh",
 *   level ok?"info":"warn", payload {kind, ok, via, modelCount, error} clamped
 *   small. No secrets, no bodies, no key material (P7).
 *
 * Import style: RELATIVE imports on purpose (./db, ./connectors/hyperbrowser,
 * ./egress) so this module can be imported by plain `bun` scripts outside the
 * Next build as well as by the Next app. [MEASURED] bun resolves both styles;
 * the Next build resolves relative imports natively — relative wins because it
 * works in both worlds.
 */

// ---------------------------------------------------------------------------
// Source contract (stable — R18-b's UI and the cadence service depend on it)
// ---------------------------------------------------------------------------

export type BenchKind =
  | "aa-index"
  | "arena-chat"
  | "arena-chat-non-english"
  | "arena-chat-multi-turn"
  | "arena-agent"
  | "arena-agent-alignment";

export type BenchSource = {
  readonly kind: BenchKind;
  readonly label: string;
  readonly url: string;
  /** The metric this board actually scores on — rendered wherever scores are. */
  readonly metricLabel: string;
  /** "percent" scores render with a % suffix; "plain" are bare numbers. */
  readonly metricUnit: BenchMetricUnit;
};

export type BenchMetricUnit = "percent" | "plain";

export const BENCH_SOURCES: readonly BenchSource[] = [
  {
    kind: "aa-index",
    label: "Artificial Analysis",
    url: "https://artificialanalysis.ai/",
    metricLabel: "Intelligence Index",
    metricUnit: "plain",
  },
  {
    kind: "arena-chat",
    label: "Arena · Chat · Text",
    url: "https://arena.ai/leaderboard/chat/text",
    metricLabel: "Arena Elo (chat)",
    metricUnit: "plain",
  },
  {
    kind: "arena-chat-non-english",
    label: "Arena · Chat · Non-English",
    url: "https://arena.ai/leaderboard/chat/text/non-english",
    metricLabel: "Arena Elo (chat)",
    metricUnit: "plain",
  },
  {
    kind: "arena-chat-multi-turn",
    label: "Arena · Chat · Multi-Turn",
    url: "https://arena.ai/leaderboard/chat/text/multi-turn",
    metricLabel: "Arena Elo (chat)",
    metricUnit: "plain",
  },
  {
    kind: "arena-agent",
    label: "Arena · Agent",
    url: "https://arena.ai/leaderboard/agent",
    metricLabel: "Net Improvement % (agent)",
    metricUnit: "percent",
  },
  {
    kind: "arena-agent-alignment",
    label: "Arena · Agent · Alignment",
    url: "https://arena.ai/leaderboard/agent/alignment",
    metricLabel: "Alignment Index",
    metricUnit: "plain",
  },
];

/**
 * Plausible score ranges per kind [MEASURED against the live boards R18-c]:
 * chat boards are Elo-like (~1500s), the agent board is a Net Improvement
 * percentage (−100…100), the alignment + intelligence indices are 0…100.
 * These are a parse-time GUARD against future source redesigns — not a claim
 * that today's data is wrong. A number outside its range is an anomaly: the
 * entry keeps its rank but its score is nulled (never silently stored).
 */
export const BENCH_SCORE_RANGES: Readonly<Record<BenchKind, { min: number; max: number }>> = {
  "aa-index": { min: 0, max: 100 },
  "arena-chat": { min: 800, max: 1600 },
  "arena-chat-non-english": { min: 800, max: 1600 },
  "arena-chat-multi-turn": { min: 800, max: 1600 },
  "arena-agent": { min: -100, max: 100 },
  "arena-agent-alignment": { min: 0, max: 100 },
};

export function benchSource(kind: BenchKind): BenchSource {
  const src = BENCH_SOURCES.find((s) => s.kind === kind);
  if (!src) throw new Error(`unknown benchmark kind: ${kind}`);
  return src;
}

// ---------------------------------------------------------------------------
// Entry + snapshot shapes
// ---------------------------------------------------------------------------

/** One leaderboard row. score/rank null = honestly unknown (row still useful). */
export type BenchEntry = {
  model: string;
  norm: string;
  score: number | null;
  rank: number | null;
};

export type BenchVia = "direct" | "hyperbrowser" | "pool" | "failed";

export type BenchError = { code: "FETCH_FAILED" | "PARSE_FAILED" | "UPSTREAM_UNAVAILABLE"; message: string };

/** Stored snapshot JSON (Settings KV "bench.snapshot.<kind>"). */
export type BenchSnapshot = {
  ok: boolean;
  kind: BenchKind;
  label: string;
  url: string;
  /** Metric this board scores on (R19-b) — snapshots since R19-b carry it;
   *  older stored snapshots are re-derived from BENCH_SOURCES on read. */
  metricLabel: string;
  metricUnit: BenchMetricUnit;
  fetchedAt: string; // ISO
  via: BenchVia;
  modelCount: number | null;
  error: BenchError | null;
  /** Parse-anomaly warnings (R19-b) — e.g. out-of-range scores. null = clean. */
  notes: string | null;
  entries: BenchEntry[];
};

/** Result of one refresh attempt (returned by refreshBenchmark / the API). */
export type BenchRefreshResult = {
  kind: BenchKind;
  ok: boolean;
  via: BenchVia;
  modelCount: number | null;
  error: BenchError | null;
};

export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export function isStale(snap: BenchSnapshot | null): boolean {
  if (!snap) return true;
  const t = Date.parse(snap.fetchedAt);
  if (!Number.isFinite(t)) return true;
  return Date.now() - t > STALE_AFTER_MS;
}

/** Lowercased, non-alphanumerics stripped — the stable model key. */
export function normalizeBenchKey(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const MAX_ENTRIES = 300;

// Sanity gate: a real AI leaderboard must contain at least one recognizable
// model family. A parse that produces none is garbage → PARSE_FAILED.
const MODEL_FAMILY_RE = /gpt|gemini|claude|qwen|deepseek|llama|grok|kimi|mistral|glm|sonnet|opus/;

// ---------------------------------------------------------------------------
// Generic entry finalization (dedupe → sort → cap → rank)
// ---------------------------------------------------------------------------

type RawEntry = { model: string; score: number | null };

/**
 * Dedupe by norm (keep the max score), sort score desc with model-name
 * tiebreak, cap at 300, assign rank from final order. Returns null when the
 * family sanity check fails — never store garbage as success.
 */
function finalizeEntries(raw: RawEntry[]): BenchEntry[] | null {
  const byNorm = new Map<string, RawEntry>();
  for (const r of raw) {
    const name = r.model.trim().slice(0, 128);
    if (!name) continue;
    const norm = normalizeBenchKey(name);
    if (!norm) continue;
    const prev = byNorm.get(norm);
    if (!prev || (r.score !== null && (prev.score === null || r.score > prev.score))) {
      byNorm.set(norm, { model: name, score: r.score });
    }
  }
  const list = [...byNorm.values()];
  const recognized = list.some((e) => MODEL_FAMILY_RE.test(e.model.toLowerCase()));
  if (!recognized || list.length === 0) return null;
  list.sort((a, b) => {
    const sa = a.score ?? Number.NEGATIVE_INFINITY;
    const sb = b.score ?? Number.NEGATIVE_INFINITY;
    if (sa !== sb) return sb - sa;
    return a.model.localeCompare(b.model);
  });
  const capped = list.slice(0, MAX_ENTRIES);
  return capped.map((e, i) => ({
    model: e.model,
    norm: normalizeBenchKey(e.model),
    score: e.score,
    rank: i + 1,
  }));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// HTML / flight parsing (artificialanalysis.ai)
// ---------------------------------------------------------------------------

/** Concatenate + JS-unescape all self.__next_f.push([1,"…"]) flight chunks. */
function extractFlightText(html: string): string {
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(JSON.parse(`"${m[1]}"`) as string);
    } catch {
      // tolerate a malformed chunk — the rest of the payload is still usable
    }
  }
  return out.join("");
}

/**
 * Scan a text blob (flight payload, __NEXT_DATA__, JSON-LD, whatever) for
 * JSON objects carrying {name, intelligenceIndex}. Brace-matches from every
 * {"id":" start; JSON.parse candidates; keeps tolerant survivors.
 * [MEASURED] against the live flight payload: 54 raw objects → deduped set.
 * Returns RAW rows (finalize + range guard happen in parseForKind).
 */
function parseAaObjects(text: string): RawEntry[] | null {
  if (!text) return null;
  const starts: number[] = [];
  const re = /\{"id":"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) starts.push(m.index);
  const raw: RawEntry[] = [];
  for (const start of starts) {
    // brace-match (string/escape aware)
    let depth = 0;
    let end = -1;
    let inStr = false;
    let esc = false;
    for (let j = start; j < Math.min(start + 300_000, text.length); j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }
    if (end === -1) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(text.slice(start, end));
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const o = obj as Record<string, unknown>;
    if (typeof o.name !== "string") continue;
    const scoreRaw = o.intelligenceIndex;
    if (typeof scoreRaw !== "number" || !Number.isFinite(scoreRaw)) continue;
    raw.push({ model: o.name, score: round2(scoreRaw) });
  }
  return raw.length > 0 ? raw : null;
}

/**
 * Fallback for the Hyperbrowser-markdown flavor of artificialanalysis.ai
 * [MEASURED]: the Intelligence Index section lists the top models as
 * "[Name](https://artificialanalysis.ai/models/…)" links followed by ONE
 * concatenated digits line (e.g. "5855535353525246464545" = 2-char scores in
 * board order). Pairs digits to the consecutive link run only when lengths
 * line up (even digit count ≤ 2×links); unpaired rows keep score:null — rank
 * is still real data. Returns RAW rows (finalize + range guard in parseForKind).
 */
function parseAaMarkdown(markdown: string): RawEntry[] | null {
  if (!markdown) return null;
  const idx = markdown.indexOf("Intelligence Index");
  if (idx === -1) return null;
  const lines = markdown.slice(idx).split("\n");
  const names: string[] = [];
  let digits: string | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("#")) break; // next section — no digits line found
    const m = MARKDOWN_LINK_RE.exec(t);
    if (m && /artificialanalysis\.ai\/models\//.test(m[2])) {
      const name = m[1].trim();
      if (name && !names.includes(name) && names.length < MAX_ENTRIES) names.push(name);
      continue;
    }
    if (/^\d{4,}$/.test(t)) {
      digits = t;
      break;
    }
  }
  if (names.length === 0) return null;
  const raw: RawEntry[] = names.map((model) => ({ model, score: null }));
  if (digits && digits.length % 2 === 0 && digits.length / 2 <= names.length) {
    const k = digits.length / 2;
    for (let i = 0; i < k; i++) {
      const v = Number(digits.slice(i * 2, i * 2 + 2));
      if (Number.isFinite(v)) raw[i] = { model: names[i], score: v };
    }
  }
  return raw.length > 0 ? raw : null;
}

// ---------------------------------------------------------------------------
// Markdown board parsing (arena.ai via Hyperbrowser)
// ---------------------------------------------------------------------------

const MARKDOWN_LINK_RE = /^\[([^\]]+)\]\((https?:\/\/\S+)\)$/;

function linkName(line: string): string | null {
  const m = MARKDOWN_LINK_RE.exec(line.trim());
  if (!m) return null;
  return m[1].trim();
}

/** A "lab · license" or plain lab line — skipped when walking back to a name. */
function isMetaLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.includes("\u00b7")) return true; // "Anthropic · Proprietary"
  if (/^(Google|OpenAI|Anthropic|Meta|xAI|Alibaba|Mistral|Microsoft|NVIDIA|Cohere|DeepSeek|AI21|Perplexity|Tencent|Xiaomi|Z\.ai|Moonshot|01\.ai)$/.test(t)) {
    return true;
  }
  return false;
}

/**
 * Arena boards via Hyperbrowser markdown [MEASURED on all four shapes]:
 * rows arrive as alternating cell lines:
 *   chat:     rank, spread, [lab], [Model](url), "Lab · License", "1517±7"
 *   agent:    rank, spread, [lab], [Model](url), "Lab · License", "20.77%±2.38%"
 *   alignment: rank, spread, "GPT-6.1 Sol" (PLAIN), "OpenAI", "87.9±1.5"
 * Anchor on the per-board score line, then walk back over non-empty lines to
 * the model name (a markdown link's anchor text, or the plain name line).
 * [RE-VERIFIED LIVE R19-b]: the agent board's standalone "20.77%±2.38%" cell
 * sits directly under the "Net Improvement" column header, immediately after
 * the model+lab lines — the concatenated trailing cells (sub-scores, votes,
 * cost) are correctly NOT matched by the anchored regex.
 * Returns RAW rows (finalize + range guard happen in parseForKind).
 */
function parseArenaMarkdown(markdown: string, kind: BenchKind): RawEntry[] | null {
  if (!markdown) return null;
  const scoreRes: RegExp[] =
    kind === "arena-agent"
      ? [/^(-?\d+(?:\.\d+)?)%\u00b1\d+(?:\.\d+)?%$/] // Net Improvement %
      : kind === "arena-agent-alignment"
        ? [/^(\d{1,3}(?:\.\d+)?)\u00b1\d+(?:\.\d+)?\s*(?:Preliminary)?$/] // Alignment Index
        : [/^(\d{3,4})\u00b1\d+\s*(?:Preliminary)?$/, /^(\d{3,4})\s*(?:Preliminary)$/]; // Elo
  const lines = markdown.split("\n");
  const raw: RawEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    let score: number | null = null;
    for (const re of scoreRes) {
      const m = re.exec(t);
      if (m) {
        const v = Number(m[1]);
        if (Number.isFinite(v)) score = v;
        break;
      }
    }
    if (score === null) continue;
    // walk back over non-empty lines to find the model name
    let name: string | null = null;
    let seen = 0;
    for (let j = i - 1; j >= 0 && j > i - 14; j--) {
      const prev = lines[j].trim();
      if (!prev) continue;
      seen++;
      const linked = linkName(prev);
      if (linked && !/arena\.ai/.test(prev)) {
        name = linked;
        break;
      }
      if (seen >= 2 && !isMetaLine(prev) && !/^-?[\d.,%\u00b1]+$/.test(prev) && prev.length >= 2) {
        // alignment-style plain name line (2+ non-empty lines above the score)
        name = prev;
        break;
      }
      if (seen >= 6) break;
    }
    if (name) raw.push({ model: name, score });
  }
  return raw.length > 0 ? raw : null;
}

// ---------------------------------------------------------------------------
// Transport layer 1 — direct fetch
// ---------------------------------------------------------------------------

const DIRECT_TIMEOUT_MS = 12_000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type DirectFetchOutcome =
  | { kind: "ok"; status: number; text: string }
  | { kind: "transport-failed" }
  | { kind: "http-error"; status: number };

async function directGet(url: string): Promise<DirectFetchOutcome> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS),
    });
    const text = (await res.text()).slice(0, 4 * 1024 * 1024);
    if (res.ok) return { kind: "ok", status: res.status, text };
    return { kind: "http-error", status: res.status };
  } catch {
    return { kind: "transport-failed" };
  }
}

// ---------------------------------------------------------------------------
// Transport layer 2 — Hyperbrowser scrape (vault key, x-api-key header)
// ---------------------------------------------------------------------------

const HB_SCRAPE_TIMEOUT_MS = 110_000; // POST (~0.3 s) + polls to ~100 s [MEASURED ~17 s/board]
const HB_POLL_INTERVAL_MS = 3_000;

type HbScrapeOutcome =
  | { kind: "ok"; markdown: string }
  | { kind: "no-key" }
  | { kind: "auth-failed"; status: number }
  | { kind: "http-error"; status: number }
  | { kind: "job-failed"; status: string }
  | { kind: "timeout" }
  | { kind: "network" };

async function hbScrape(url: string): Promise<HbScrapeOutcome> {
  const keyLoad = await loadHyperbrowserKey();
  if (!keyLoad.ok) return { kind: "no-key" };
  const base = hyperbrowserBaseUrl();
  const headers = { "x-api-key": keyLoad.key, "Content-Type": "application/json" };
  // key plaintext lives only in the header below — never logged, never returned

  let jobId: string | null = null;
  try {
    const res = await fetch(`${base}/api/scrape`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url, formats: ["markdown"] }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 403) return { kind: "auth-failed", status: res.status };
    if (!res.ok) return { kind: "http-error", status: res.status };
    const body = (await res.json().catch(() => null)) as { jobId?: unknown } | null;
    if (!body || typeof body.jobId !== "string") return { kind: "http-error", status: res.status };
    jobId = body.jobId;
  } catch {
    return { kind: "network" };
  }

  const deadline = Date.now() + HB_SCRAPE_TIMEOUT_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, HB_POLL_INTERVAL_MS));
    try {
      const res = await fetch(`${base}/api/scrape/${encodeURIComponent(jobId)}`, {
        headers: { "x-api-key": keyLoad.key },
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401 || res.status === 403) return { kind: "auth-failed", status: res.status };
      if (!res.ok) return { kind: "http-error", status: res.status };
      const body = (await res.json().catch(() => null)) as
        | { status?: unknown; data?: { markdown?: unknown } | null }
        | null;
      const status = typeof body?.status === "string" ? body.status : "";
      if (status === "completed") {
        const md = body?.data && typeof body.data.markdown === "string" ? body.data.markdown : null;
        return md ? { kind: "ok", markdown: md } : { kind: "job-failed", status: "completed-empty" };
      }
      if (status === "failed" || status === "error" || status === "canceled" || status === "cancelled") {
        return { kind: "job-failed", status: status };
      }
      // pending/running/queued/unknown → keep polling until the deadline
    } catch {
      return { kind: "network" };
    }
    if (Date.now() > deadline) return { kind: "timeout" };
  }
}

// ---------------------------------------------------------------------------
// Transport layer 3 — Webshare pool retry (only after direct transport failure)
// ---------------------------------------------------------------------------

async function poolGet(url: string): Promise<DirectFetchOutcome> {
  const poolLoad = await loadEgressPool();
  if (!poolLoad.ok || poolLoad.pool.length === 0) return { kind: "transport-failed" };
  const picks = pickProxies(poolLoad.pool, 3); // some nodes are dead — 3 picks [MEASURED R18-0]
  for (const proxy of picks) {
    const r = await proxiedFetch(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        },
      },
      { proxy, timeoutMs: 15_000 },
    );
    if ("status" in r && r.status >= 200 && r.status < 300) {
      return { kind: "ok", status: r.status, text: r.bodyText };
    }
  }
  return { kind: "transport-failed" };
}

// ---------------------------------------------------------------------------
// Per-kind fetch + parse pipeline
// ---------------------------------------------------------------------------

/** Parsed outcome: finalized entries (null = unrecognizable) + range-anomaly count. */
type ParseOutcome = { entries: BenchEntry[] | null; rangeWarnings: number };

/**
 * Sanity-range guard (R19-b): nulls any parsed score outside its kind's
 * plausible range (BENCH_SCORE_RANGES) BEFORE dedupe/sort/rank, so the row
 * degrades to the honest rank-only pattern and can never masquerade as the
 * metric. Returns the guarded rows + how many scores were anomalous.
 */
function applyScoreRangeGuard(kind: BenchKind, raw: RawEntry[]): { raw: RawEntry[]; warnings: number } {
  const range = BENCH_SCORE_RANGES[kind];
  let warnings = 0;
  const guarded = raw.map((r) => {
    if (r.score === null) return r;
    if (r.score < range.min || r.score > range.max) {
      warnings++;
      return { model: r.model, score: null };
    }
    return r;
  });
  return { raw: guarded, warnings };
}

/** Raw-row extraction per kind (no finalize, no range guard yet). */
function collectRawEntries(kind: BenchKind, source: "html" | "markdown", text: string): RawEntry[] | null {
  if (kind === "aa-index") {
    if (source === "html") {
      // primary: RSC flight chunks → model objects with intelligenceIndex
      const flight = extractFlightText(text);
      const fromFlight = parseAaObjects(flight);
      if (fromFlight) return fromFlight;
      // tolerate a plain __NEXT_DATA__ page or any embedded JSON objects
      return parseAaObjects(text);
    }
    return parseAaMarkdown(text);
  }
  return parseArenaMarkdown(text, kind);
}

function parseForKind(kind: BenchKind, source: "html" | "markdown", text: string): ParseOutcome {
  const raw = collectRawEntries(kind, source, text);
  if (!raw || raw.length === 0) return { entries: null, rangeWarnings: 0 };
  const guarded = applyScoreRangeGuard(kind, raw);
  return { entries: finalizeEntries(guarded.raw), rangeWarnings: guarded.warnings };
}

/**
 * Parse-only entry point (used by the refresh pipeline and safe for
 * diagnostics): turns fetched HTML/markdown into finalized entries (range
 * guard applied — out-of-range scores come back as null), or null when the
 * family sanity check fails. Never fabricates.
 */
export function parseBenchPayload(kind: BenchKind, medium: "html" | "markdown", text: string): BenchEntry[] | null {
  return parseForKind(kind, medium, text).entries;
}

function staticMessage(code: BenchError["code"], source: BenchSource): string {
  switch (code) {
    case "FETCH_FAILED":
      return `${source.url} could not be fetched — the site or the network path is down (direct + proxy pool).`;
    case "PARSE_FAILED":
      return `${source.url} answered but no leaderboard rows could be recognized (SPA/layout change suspected).`;
    case "UPSTREAM_UNAVAILABLE":
      return `${source.url} is JS/Cloudflare-guarded and the Hyperbrowser scrape fallback was unavailable — store a Hyperbrowser key in the vault or retry later.`;
  }
}

export type FetchBenchmarksOutcome =
  | { ok: true; via: BenchVia; entries: BenchEntry[]; modelCount: number; rangeWarnings: number }
  | { ok: false; error: BenchError };

/**
 * Layered, honest fetch+parse for one source. NEVER fabricates entries.
 * Order: direct → Hyperbrowser (JS rendering) → pool retry (transport only).
 * The ok branch carries rangeWarnings: how many parsed scores fell outside
 * the kind's plausible metric range and were degraded to score:null (R19-b).
 */
export async function fetchBenchmarks(kind: BenchKind): Promise<FetchBenchmarksOutcome> {
  const source = benchSource(kind);

  let directTransportFailed = false;

  // Layer 1 — direct
  const direct = await directGet(source.url);
  if (direct.kind === "ok") {
    const parsed = parseForKind(kind, "html", direct.text);
    if (parsed.entries) {
      return { ok: true, via: "direct", entries: parsed.entries, modelCount: parsed.entries.length, rangeWarnings: parsed.rangeWarnings };
    }
    // 200 bytes with no usable data (SPA) → try the renderer next
  } else if (direct.kind === "transport-failed") {
    directTransportFailed = true; // pool retry is allowed later for this case only
  }
  // direct.kind === "http-error" (e.g. 403 Cloudflare challenge [MEASURED on
  // arena.ai]) → bytes blocked, not a transport failure → renderer next

  // Layer 2 — Hyperbrowser scrape (the JS-rendering fallback)
  const hb = await hbScrape(source.url);
  if (hb.kind === "ok") {
    const parsed = parseForKind(kind, "markdown", hb.markdown);
    if (parsed.entries) {
      return { ok: true, via: "hyperbrowser", entries: parsed.entries, modelCount: parsed.entries.length, rangeWarnings: parsed.rangeWarnings };
    }
    // markdown present but unparseable → honest PARSE_FAILED at the tail
  } else if (hb.kind === "no-key" && !directTransportFailed && direct.kind !== "ok") {
    // JS/Cloudflare-guarded source + no vault key to render it → the one
    // honest verdict is "unavailable", before any further guesses.
    return { ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: staticMessage("UPSTREAM_UNAVAILABLE", source) } };
  }

  // Layer 3 — pool retry, ONLY for direct transport failures
  let pooledGotContent = false;
  if (directTransportFailed) {
    const pooled = await poolGet(source.url);
    if (pooled.kind === "ok") {
      const parsed = parseForKind(kind, "html", pooled.text);
      if (parsed.entries) {
        return { ok: true, via: "pool", entries: parsed.entries, modelCount: parsed.entries.length, rangeWarnings: parsed.rangeWarnings };
      }
      pooledGotContent = true;
    }
  }

  // Layer 4 — honest failure classification (static messages, no internals)
  const gotContent = direct.kind === "ok" || hb.kind === "ok" || pooledGotContent;
  if (gotContent) {
    return { ok: false, error: { code: "PARSE_FAILED", message: staticMessage("PARSE_FAILED", source) } };
  }
  if (directTransportFailed) {
    return { ok: false, error: { code: "FETCH_FAILED", message: staticMessage("FETCH_FAILED", source) } };
  }
  return { ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: staticMessage("UPSTREAM_UNAVAILABLE", source) } };
}

// ---------------------------------------------------------------------------
// Snapshots (Settings KV) + L0 event rows
// ---------------------------------------------------------------------------

function snapshotKey(kind: BenchKind): string {
  return `bench.snapshot.${kind}`;
}

function sanitizeSnapshot(raw: unknown): BenchSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const src = BENCH_SOURCES.find((s) => s.kind === o.kind);
  if (!src || typeof o.fetchedAt !== "string" || typeof o.via !== "string") return null;
  const errRaw = o.error as Record<string, unknown> | null | undefined;
  const error =
    errRaw && typeof errRaw === "object" && typeof errRaw.code === "string" && typeof errRaw.message === "string"
      ? { code: errRaw.code as BenchError["code"], message: errRaw.message }
      : null;
  const entriesRaw = Array.isArray(o.entries) ? o.entries : [];
  const entries: BenchEntry[] = [];
  for (const e of entriesRaw.slice(0, MAX_ENTRIES)) {
    if (!e || typeof e !== "object") continue;
    const eo = e as Record<string, unknown>;
    if (typeof eo.model !== "string") continue;
    entries.push({
      model: eo.model,
      norm: typeof eo.norm === "string" ? eo.norm : normalizeBenchKey(eo.model),
      score: typeof eo.score === "number" && Number.isFinite(eo.score) ? eo.score : null,
      rank: typeof eo.rank === "number" && Number.isFinite(eo.rank) ? eo.rank : null,
    });
  }
  return {
    ok: o.ok === true,
    kind: src.kind,
    label: src.label,
    url: src.url,
    // metricLabel/metricUnit: snapshots written since R19-b carry them; older
    // stored payloads are re-derived from the static BENCH_SOURCES map so they
    // render labeled too (never trust the stored copy over the static truth).
    metricLabel: src.metricLabel,
    metricUnit: src.metricUnit,
    fetchedAt: o.fetchedAt,
    via: o.via as BenchVia,
    modelCount: typeof o.modelCount === "number" ? o.modelCount : entries.length,
    error,
    notes: typeof o.notes === "string" && o.notes.trim().length > 0 ? o.notes.trim().slice(0, 512) : null,
    entries,
  };
}

export async function getBenchmarkSnapshot(kind: BenchKind): Promise<BenchSnapshot | null> {
  try {
    const row = await db.setting.findUnique({ where: { key: snapshotKey(kind) } });
    if (!row) return null;
    return sanitizeSnapshot(JSON.parse(row.value));
  } catch {
    return null;
  }
}

async function saveSnapshot(snap: BenchSnapshot): Promise<void> {
  const value = JSON.stringify(snap);
  await db.setting.upsert({
    where: { key: snapshotKey(snap.kind) },
    update: { value },
    create: { key: snapshotKey(snap.kind), value },
  });
}

async function logRefreshEvent(result: BenchRefreshResult): Promise<void> {
  try {
    const payload = JSON.stringify({
      kind: result.kind,
      ok: result.ok,
      via: result.via,
      modelCount: result.modelCount,
      error: result.error ? { code: result.error.code } : null,
    }).slice(0, 2048);
    await db.event.create({
      data: {
        source: "system",
        type: "bench.refresh",
        level: result.ok ? "info" : "warn",
        payload,
      },
    });
  } catch {
    // L0 event write is best-effort — a failed telemetry row must never
    // masquerade as a failed benchmark refresh.
  }
}

// ---------------------------------------------------------------------------
// Refresh orchestration (per-kind in-process mutex)
// ---------------------------------------------------------------------------

const inflight = new Map<BenchKind, Promise<BenchRefreshResult>>();

/** Static warning when parsed scores fall outside the kind's plausible range. */
function rangeWarningNote(warnings: number): string {
  return `${warnings} ${warnings === 1 ? "entry scored" : "entries scored"} outside the plausible range for this metric — score column may have changed on the source board`;
}

async function runRefresh(kind: BenchKind, trigger: string | undefined): Promise<BenchRefreshResult> {
  const source = benchSource(kind);
  const fetchedAt = new Date().toISOString();
  const outcome = await fetchBenchmarks(kind);
  const snap: BenchSnapshot = outcome.ok
    ? {
        ok: true,
        kind,
        label: source.label,
        url: source.url,
        metricLabel: source.metricLabel,
        metricUnit: source.metricUnit,
        fetchedAt,
        via: outcome.via,
        modelCount: outcome.modelCount,
        error: null,
        notes: outcome.rangeWarnings > 0 ? rangeWarningNote(outcome.rangeWarnings) : null,
        entries: outcome.entries,
      }
    : {
        ok: false,
        kind,
        label: source.label,
        url: source.url,
        metricLabel: source.metricLabel,
        metricUnit: source.metricUnit,
        fetchedAt,
        via: "failed",
        modelCount: null,
        error: outcome.error,
        notes: null,
        entries: [],
      };
  try {
    await saveSnapshot(snap);
  } catch {
    // KV write failed: still return the honest refresh outcome + event row;
    // the snapshot store stays at its previous value (never a fake success).
  }
  const result: BenchRefreshResult = {
    kind,
    ok: snap.ok,
    via: snap.via,
    modelCount: snap.modelCount,
    error: snap.error,
  };
  await logRefreshEvent(result);
  void trigger; // informational only (api/service) — never logged with secrets
  return result;
}

/**
 * Refresh one benchmark source (fetch → parse → snapshot KV + L0 event row).
 * Per-kind in-process mutex: concurrent callers await the same promise.
 */
export function refreshBenchmark(kind: BenchKind, trigger?: string): Promise<BenchRefreshResult> {
  const existing = inflight.get(kind);
  if (existing) return existing;
  const p = runRefresh(kind, trigger).finally(() => {
    inflight.delete(kind);
  });
  inflight.set(kind, p);
  return p;
}

/** All 6 kinds with their current stored snapshots (missing → null-shaped). */
export async function listBenchmarkStates(): Promise<BenchSnapshot[]> {
  const out: BenchSnapshot[] = [];
  for (const src of BENCH_SOURCES) {
    const snap = await getBenchmarkSnapshot(src.kind);
    if (snap) {
      out.push(snap);
      continue;
    }
    out.push({
      ok: false,
      kind: src.kind,
      label: src.label,
      url: src.url,
      metricLabel: src.metricLabel,
      metricUnit: src.metricUnit,
      fetchedAt: "",
      via: "failed",
      modelCount: null,
      error: null,
      notes: null,
      entries: [],
    });
  }
  return out;
}
