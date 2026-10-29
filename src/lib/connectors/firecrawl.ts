import { db } from "@/lib/db";
import { decryptSecret, maskSecret } from "@/lib/crypto";

/**
 * NEXUS OS v37.1 — Firecrawl connector: the METERED scrape backup (Alexandria).
 *
 * Owner paste 2026-10-30: key fc-… with **1,400 credits** (resets Nov 29).
 * Firecrawl v2: /scrape, /crawl, /search + the Alexandria provider marketplace
 * (Apollo people-enrichment, Fiscal.ai finance, Particle podcasts, Shopify
 * catalogs — per-connector credit pricing shown in the panel of that service).
 *
 * Honesty ledger [MEASURED 2026-10-30 05:05 +03, owner's real key]:
 * - `POST https://api.firecrawl.dev/v2/scrape` {url, formats:["markdown"],
 *   onlyMainContent:true} → 200 {success:true, data:{markdown,…}}
 *   Probe: artificialanalysis.ai model page — clean markdown, ~1 credit.
 *
 * Role in the brain: LAST-resort page reader — only when TinyFish (free) AND
 * Keenable fetch (free) both fail the same page. Credits are finite and the
 * burn-down (1,400) is shown on the panel card honestly.
 */

export const FIRECRAWL_SERVICE = "firecrawl";
export const FIRECRAWL_LABEL = "api";
export const FIRECRAWL_BASE = "https://api.firecrawl.dev";
export const FIRECRAWL_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Vault access
// ---------------------------------------------------------------------------

export type FirecrawlKeyLoad =
  | { ok: true; key: string; masked: string; keyId: string; updatedAt: string }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "unreadable" };

export async function loadFirecrawlKey(): Promise<FirecrawlKeyLoad> {
  const row = await db.credential.findUnique({
    where: { service_label: { service: FIRECRAWL_SERVICE, label: FIRECRAWL_LABEL } },
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
// Scrape — metered (≈1 credit), last resort after the free lanes
// ---------------------------------------------------------------------------

export type FirecrawlScrapeOutcome =
  | { ok: true; url: string; markdown: string; tookMs: number }
  | { ok: false; error: string; status: number | null; tookMs: number };

export async function firecrawlScrape(
  key: string,
  url: string,
  opts: { maxChars?: number } = {}
): Promise<FirecrawlScrapeOutcome> {
  const target = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: "invalid url", status: null, tookMs: 0 };
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIRECRAWL_TIMEOUT_MS);
  try {
    const res = await fetch(`${FIRECRAWL_BASE}/v2/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: target, formats: ["markdown"], onlyMainContent: true }),
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text();
    const tookMs = Date.now() - started;
    let parsed: { success?: boolean; data?: { markdown?: string }; error?: string; message?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: `unparseable response: ${text.slice(0, 200)}`, status: res.status, tookMs };
    }
    if (!res.ok || parsed.success !== true) {
      return {
        ok: false,
        error: parsed.error || parsed.message || `HTTP ${res.status}`,
        status: res.status,
        tookMs,
      };
    }
    return {
      ok: true,
      url: target,
      markdown: (parsed.data?.markdown ?? "").slice(0, opts.maxChars ?? 40_000),
      tookMs,
    };
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
// Status probe — tiny scrape (1 credit), honest about the meter
// ---------------------------------------------------------------------------

export type FirecrawlStatusPayload = {
  configured: boolean;
  reachable: boolean | null;
  apiOk: boolean | null;
  error: string | null;
  credential: { masked: string; keyId: string; updatedAt: string } | null;
  probedAt: string | null;
  sampleTitle: string | null;
};

export async function probeFirecrawl(
  key: string
): Promise<Omit<FirecrawlStatusPayload, "configured" | "credential">> {
  // 1-credit probe, same shape as the Hyperbrowser probe discipline.
  const probe = await firecrawlScrape(key, "https://example.com", { maxChars: 400 });
  return {
    reachable: probe.ok || probe.status !== null,
    apiOk: probe.ok,
    error: probe.ok ? null : probe.error,
    probedAt: new Date().toISOString(),
    sampleTitle: probe.ok ? "example.com ok" : null,
  };
}
