import { db } from "@/lib/db";
import { decryptSecret, maskSecret } from "@/lib/crypto";

/**
 * NEXUS OS v37.1 — TinyFish connector: free JS-page reader + browser automation.
 *
 * Owner paste 2026-10-30: key sk-tinyfish-…; search and fetch are FREE on every
 * account ("no credits, no cost" per the capture). Platform: Agent API (automation
 * runs, browser context profiles), Browser API (CDP WebSocket, **US residential
 * proxy on every session by default** — proxy_config picks country), Fetch/Search/
 * Extract APIs, Monitor API (cron'd page/topic monitors → webhook).
 *
 * Honesty ledger [MEASURED 2026-10-30 05:00 +03, owner's real key]:
 * - `POST https://api.fetch.tinyfish.ai` {urls:[…], format:"markdown"} → 200
 *   {results:[{url, final_url, title, description, language, text(markdown)}]}
 *   Probe target: artificialanalysis.ai/leaderboards/models — the JS-board class
 *   that arena.ai PARSE_FAILED boards belong to. Clean markdown came back.
 * - Session creation (Browser API) takes 10-30s per docs — NOT probed here; the
 *   fetch lane covers the bench-reader need at zero cost and zero wait.
 *
 * Role in the brain: the free reader for JS-rendered pages where Exa/Keenable
 * contents come back empty or SPA shells (arena.ai, AA leaderboards). Browser
 * automation + monitors are parked (docs/agentmail-deep-dive.md §7).
 */

export const TINYFISH_SERVICE = "tinyfish";
export const TINYFISH_LABEL = "api";
export const TINYFISH_FETCH_BASE = "https://api.fetch.tinyfish.ai";
export const TINYFISH_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Vault access
// ---------------------------------------------------------------------------

export type TinyFishKeyLoad =
  | { ok: true; key: string; masked: string; keyId: string; updatedAt: string }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "unreadable" };

export async function loadTinyFishKey(): Promise<TinyFishKeyLoad> {
  const row = await db.credential.findUnique({
    where: { service_label: { service: TINYFISH_SERVICE, label: TINYFISH_LABEL } },
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
// Fetch — multiple URLs, markdown out (free)
// ---------------------------------------------------------------------------

export type TinyFishPage = {
  url: string;
  finalUrl: string;
  title: string;
  description: string;
  text: string;
};

export type TinyFishFetchOutcome =
  | { ok: true; pages: TinyFishPage[]; tookMs: number }
  | { ok: false; error: string; status: number | null; tookMs: number };

export async function tinyfishFetchPages(
  key: string,
  urls: string[],
  opts: { maxChars?: number } = {}
): Promise<TinyFishFetchOutcome> {
  const targets = urls.map((u) => String(u ?? "").trim()).filter((u) => /^https?:\/\//i.test(u));
  if (targets.length === 0) return { ok: false, error: "no valid urls", status: null, tookMs: 0 };
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TINYFISH_TIMEOUT_MS);
  try {
    const res = await fetch(TINYFISH_FETCH_BASE, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ urls: targets.slice(0, 5), format: "markdown" }),
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text();
    const tookMs = Date.now() - started;
    let parsed: {
      results?: Array<{ url?: string; final_url?: string; title?: string; description?: string; text?: string }>;
      /** v37.2 [MEASURED]: per-URL failures ride here, e.g.
       * {url, error:"bot_blocked"} for the arena.ai boards TinyFish's egress
       * cannot pass — results[] simply omits those URLs. */
      errors?: Array<{ url?: string; error?: string }>;
    };
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: `unparseable response: ${text.slice(0, 200)}`, status: res.status, tookMs };
    }
    if (!res.ok) {
      const errBody = parsed as unknown as { error?: string; message?: string };
      return {
        ok: false,
        error: errBody?.error || errBody?.message || `HTTP ${res.status}`,
        status: res.status,
        tookMs,
      };
    }
    // HTTP 200 can still mean partial/total bot-block — surface it honestly.
    if ((parsed.results ?? []).length === 0 && (parsed.errors ?? []).length > 0) {
      const first = parsed.errors?.[0];
      return {
        ok: false,
        error: first?.error ? `blocked: ${first.error}` : "no results (upstream error)",
        status: res.status,
        tookMs,
      };
    }
    const cap = opts.maxChars ?? 40_000;
    const pages: TinyFishPage[] = (parsed.results ?? []).map((r) => ({
      url: r.url ?? "",
      finalUrl: r.final_url ?? r.url ?? "",
      title: r.title ?? "",
      description: r.description ?? "",
      text: (r.text ?? "").slice(0, cap),
    }));
    return { ok: true, pages, tookMs };
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
// Status probe
// ---------------------------------------------------------------------------

export type TinyFishStatusPayload = {
  configured: boolean;
  reachable: boolean | null;
  apiOk: boolean | null;
  error: string | null;
  credential: { masked: string; keyId: string; updatedAt: string } | null;
  probedAt: string | null;
  sampleTitle: string | null;
};

export async function probeTinyFish(
  key: string
): Promise<Omit<TinyFishStatusPayload, "configured" | "credential">> {
  const probe = await tinyfishFetchPages(key, ["https://example.com"], { maxChars: 500 });
  return {
    reachable: probe.ok || probe.status !== null,
    apiOk: probe.ok,
    error: probe.ok ? null : probe.error,
    probedAt: new Date().toISOString(),
    sampleTitle: probe.ok ? probe.pages[0]?.title ?? null : null,
  };
}
