import { NextResponse } from "next/server";
import { hasBrainAccess, clampStr } from "@/lib/brain/auth";
import { runWebSearch, runPageRead, isProbablyUrl } from "@/lib/brain/search";
import { exaSearch, exaAnswer } from "@/lib/connectors/exa";
import { clientKey, rateLimit } from "@/lib/guard";

/**
 * POST /api/brain/search — server-side research for the OBS brain (v29.12).
 *
 * RESEARCH LADDER (owner directive: Exa-first, aggressive but budgeted):
 *   1. Exa search (neural/auto, highlights+summary, livecrawl) — grounded,
 *      fresh, URL-cited. `answer: true` uses the Exa /answer endpoint instead:
 *      a synthesized answer WITH citations — the anti-hallucination path.
 *   2. z-ai web_search fallback (free pool) when Exa is unconfigured,
 *      budget-exhausted, or erroring — nothing breaks without a key.
 *
 * Body: { query: string, num?: number, recencyDays?: number, answer?: boolean }
 *   or  { url: string }               (link-unfurl mode for page reading)
 *
 * Auth: x-nexus-token (widget ingest token) or panel session.
 */
export async function POST(req: Request) {
  if (!rateLimit(`brain-search:${clientKey(req)}`, 40, 60_000)) {
    return NextResponse.json({ ok: false, error: "rate limited" }, { status: 429 });
  }
  if (!(await hasBrainAccess(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { query?: unknown; url?: unknown; num?: unknown; recencyDays?: unknown; answer?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json body" }, { status: 400 });
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (url) {
    if (!isProbablyUrl(url)) {
      return NextResponse.json({ ok: false, error: "invalid url" }, { status: 400 });
    }
    const read = await runPageRead(url);
    return NextResponse.json(
      { ...read, mode: "read", url },
      { status: read.ok ? 200 : 502 },
    );
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return NextResponse.json({ ok: false, error: "query or url required" }, { status: 400 });
  }
  const num = typeof body.num === "number" ? body.num : undefined;
  const recencyDays = typeof body.recencyDays === "number" ? body.recencyDays : undefined;
  const wantAnswer = body.answer === true;

  // 1) Exa answer — grounded synthesis with citations.
  if (wantAnswer) {
    const ans = await exaAnswer(query);
    if (ans.ok) {
      return NextResponse.json({
        ok: true,
        mode: "answer",
        provider: "exa",
        query,
        answer: ans.answer,
        citations: ans.citations,
        formatted: ans.citations.length
          ? ans.answer +
            "\n\nKaynaklar: " +
            ans.citations.map((c, i) => `[${i + 1}] ${c.title || ""} ${c.url}`).join(" | ")
          : ans.answer,
        tookMs: ans.tookMs,
        estCostUsd: ans.estCostUsd,
      });
    }
    // fall through to search ladder on failure — answer mode is best-effort
  }

  // 2) Exa search — neural results with highlights.
  const exa = await exaSearch({
    query,
    numResults: num ?? 6,
    recencyDays,
    type: "auto",
  });
  if (exa.ok) {
    return NextResponse.json({
      ok: true,
      mode: "search",
      provider: "exa",
      query,
      snippets: exa.results.map((r) => ({
        title: r.title,
        text: r.summary || r.highlight,
        url: r.url,
        host: new URL(r.url).host,
        date: r.publishedDate,
      })),
      formatted: exa.formatted,
      tookMs: exa.tookMs,
      estCostUsd: exa.estCostUsd,
    });
  }

  // 3) z-ai fallback — the previous free path, unchanged contract.
  const result = await runWebSearch(query, { num, recencyDays });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, mode: "search", error: clampStr(result.error, 200), exaError: clampStr(exa.ok ? "" : exa.error, 120), tookMs: result.tookMs },
      { status: 502 },
    );
  }
  return NextResponse.json({ ...result, mode: "search", provider: "z-ai" });
}
