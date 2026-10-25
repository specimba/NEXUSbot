import { NextResponse } from "next/server";
import { hasBrainAccess, clampStr } from "@/lib/brain/auth";
import { runWebSearch, runPageRead, isProbablyUrl } from "@/lib/brain/search";
import { clientKey, rateLimit } from "@/lib/guard";

/**
 * POST /api/brain/search — server-side research for the OBS brain.
 *
 * Body: { query: string, num?: number, recencyDays?: number }
 *   or  { url: string }               (link-unfurl mode for page reading)
 *
 * Auth: x-nexus-token (widget ingest token) or panel session.
 * This is the backend for the shim's universalLiveWebSearch /
 * fetchDuckDuckGoInstantAnswer / fetchLiveWeather / unfurlLinksInPrompt
 * helpers — previously stubbed as no-ops, which is why the brain "could not
 * fetch anything from web".
 */
export async function POST(req: Request) {
  if (!rateLimit(`brain-search:${clientKey(req)}`, 40, 60_000)) {
    return NextResponse.json({ ok: false, error: "rate limited" }, { status: 429 });
  }
  if (!(await hasBrainAccess(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { query?: unknown; url?: unknown; num?: unknown; recencyDays?: unknown };
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
      { ok: read.ok, mode: "read", url, ...read },
      { status: read.ok ? 200 : 502 },
    );
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return NextResponse.json({ ok: false, error: "query or url required" }, { status: 400 });
  }
  const num = typeof body.num === "number" ? body.num : undefined;
  const recencyDays = typeof body.recencyDays === "number" ? body.recencyDays : undefined;

  const result = await runWebSearch(query, { num, recencyDays });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, mode: "search", error: clampStr(result.error, 200), tookMs: result.tookMs },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, mode: "search", ...result });
}
