import { clampStr } from "./auth";

/**
 * Server-side research for the NEXUS brain (v29.8).
 *
 * The Kickbot dump's web-intel helpers were builder-injected; our runtime shim
 * had to stub them as honest no-ops, which left the brain with frozen LLM
 * knowledge only (viewers asking for news got nothing). This module is the
 * real backend for those helpers: the z-ai web_search + page_reader functions
 * run here (server side only), no viewer device, no OBS, no CORS.
 */

export type WebSnippet = {
  title: string;
  text: string;
  url: string;
  host: string;
  date: string;
};

export type SearchResult =
  | { ok: true; query: string; snippets: WebSnippet[]; formatted: string; tookMs: number }
  | { ok: false; error: string; tookMs: number };

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export function extractOgImage(html: string): string {
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1];
  }
  return "";
}

export function isProbablyUrl(text: string): boolean {
  const t = String(text || "").trim();
  return /^https?:\/\/[^\s]+\.[^\s]{2,}$/i.test(t);
}

/** web_search via the z-ai function surface (server side only). */
export async function runWebSearch(
  query: string,
  opts: { num?: number; recencyDays?: number } = {},
): Promise<SearchResult> {
  const started = Date.now();
  const cleanQuery = clampStr(query, 300).trim();
  if (!cleanQuery) return { ok: false, error: "empty query", tookMs: 0 };
  const num = Math.min(6, Math.max(1, Math.round(opts.num ?? 4)));
  try {
    const { default: ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    const args: Record<string, unknown> = { query: cleanQuery, num };
    const recency = Math.min(90, Math.max(1, Math.round(opts.recencyDays ?? 21)));
    args.recency_days = recency;
    const raw = (await zai.functions.invoke("web_search", args as never)) as Array<{
      url?: string;
      name?: string;
      snippet?: string;
      host_name?: string;
      date?: string;
    }>;
    const snippets: WebSnippet[] = (Array.isArray(raw) ? raw : [])
      .filter((r) => r && (r.name || r.snippet))
      .slice(0, num)
      .map((r) => ({
        title: clampStr(r.name || "(no title)", 140),
        text: clampStr(r.snippet || "", 320),
        url: clampStr(r.url || "", 300),
        host: clampStr(r.host_name || "", 80),
        date: clampStr(r.date || "", 40),
      }));
    const formatted = snippets
      .map((s, i) => `[${i + 1}|${s.host}${s.date ? " · " + s.date : ""}] ${s.title} — ${s.text}${s.url ? ` (${s.url})` : ""}`)
      .join("\n");
    return { ok: true, query: cleanQuery, snippets, formatted, tookMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message.slice(0, 200) : "web_search failed",
      tookMs: Date.now() - started,
    };
  }
}

/** page_reader via the z-ai function surface — link unfurling for the brain. */
export async function runPageRead(
  url: string,
): Promise<{ ok: boolean; title: string; text: string; imageUrl: string; publishedTime: string; error: string }> {
  const cleanUrl = clampStr(url, 500).trim();
  try {
    if (!/^https?:\/\//i.test(cleanUrl)) throw new Error("not an http(s) url");
    const { default: ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    const res = (await zai.functions.invoke("page_reader", { url: cleanUrl })) as {
      code?: number;
      data?: { html?: string; title?: string; publishedTime?: string };
    };
    const html = res?.data?.html || "";
    return {
      ok: Boolean(html),
      title: clampStr(res?.data?.title || "", 160),
      text: clampStr(stripHtml(html), 3_200),
      imageUrl: extractOgImage(html),
      publishedTime: clampStr(res?.data?.publishedTime || "", 40),
      error: html ? "" : "empty page body",
    };
  } catch (err) {
    return {
      ok: false,
      title: "",
      text: "",
      imageUrl: "",
      publishedTime: "",
      error: err instanceof Error ? err.message.slice(0, 200) : "page_reader failed",
    };
  }
}
