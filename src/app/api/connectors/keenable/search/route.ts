import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { loadKeenableKey, keenableSearch } from "@/lib/connectors/keenable";

/**
 * v37.1 — Keenable search (FREE web research lane). Session-guarded.
 *
 * POST { query, maxResults?, site?, publishedAfter?, publishedBefore? }
 *   → POST api.keenable.ai/v1/search → typed outcome, sources formatted
 *     exactly like the Exa lane cards so the brain can consume either.
 *
 * The [MEASURED] Nikolina probe: three ticketing sources (BUGECE/RA/
 * Consequence) for the exact entity Exa failed — this route exists to make
 * that class answerable for free.
 */
export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as
    | { query?: unknown; maxResults?: unknown; site?: unknown; publishedAfter?: unknown; publishedBefore?: unknown }
    | null;

  const query = typeof body?.query === "string" ? body.query : "";
  if (query.trim().length < 2) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_QUERY", message: "query must be ≥2 chars" } },
      { status: 400 }
    );
  }

  const loaded = await loadKeenableKey();
  if (!loaded.ok) {
    return NextResponse.json(
      {
        ok: false,
        error:
          loaded.reason === "missing"
            ? "Keenable key not configured (vault)."
            : "Stored Keenable key is unreadable — re-save the key.",
      },
      { status: loaded.reason === "missing" ? 404 : 500 }
    );
  }

  const out = await keenableSearch(loaded.key, query, {
    maxResults: Number(body?.maxResults ?? 5),
    site: typeof body?.site === "string" && body.site.length > 0 ? body.site : undefined,
    publishedAfter:
      typeof body?.publishedAfter === "string" && body.publishedAfter.length > 0
        ? body.publishedAfter
        : undefined,
    publishedBefore:
      typeof body?.publishedBefore === "string" && body.publishedBefore.length > 0
        ? body.publishedBefore
        : undefined,
  });

  if (!out.ok) {
    return NextResponse.json({ ok: false, error: out.error }, { status: 502 });
  }
  return NextResponse.json({
    ok: true,
    search: {
      query: out.query,
      results: out.results,
      formatted: out.formatted,
      tookMs: out.tookMs,
    },
  });
}
