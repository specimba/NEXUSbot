import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { db } from "@/lib/db";
import { ensurePapersSeeded } from "@/lib/rsi/seed";

export const dynamic = "force-dynamic";

/**
 * GET /api/rsi/papers?query=&category= — the owner's curated 48-paper RSI
 * corpus (lazy-seeded from src/data/rsi/curation-papers.json). Case-insensitive
 * filter across title/oneLine/keyTechnique/authorsShort; category chips map
 * 1:1 to the corpus categories. Newest-first convention does not apply to a
 * frozen library — papers return in corpus (citeKey) order, stable for the UI.
 */
export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`rsi-papers:${clientKey(req)}`, 60, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "slow down — 60 paper reads per minute" } },
      { status: 429 },
    );
  }

  const url = new URL(req.url);
  const query = (url.searchParams.get("query") ?? "").trim().toLowerCase();
  const category = (url.searchParams.get("category") ?? "").trim();

  await ensurePapersSeeded();

  const papers = await db.rsiPaper.findMany({
    where: category ? { category } : undefined,
    orderBy: { citeKey: "asc" },
  });

  const filtered = query
    ? papers.filter((p) =>
        [p.title, p.oneLine, p.keyTechnique, p.authorsShort, p.arxivId]
          .some((f) => f.toLowerCase().includes(query)),
      )
    : papers;

  return NextResponse.json({
    ok: true,
    papers: filtered.map((p) => ({
      id: p.id,
      citeKey: p.citeKey,
      title: p.title,
      authorsShort: p.authorsShort,
      year: p.year,
      arxivId: p.arxivId,
      url: p.url,
      category: p.category,
      relevance: p.relevance,
      oneLine: p.oneLine,
      keyTechnique: p.keyTechnique,
      appliesTo: p.appliesTo,
      evidence: p.evidence,
    })),
    total: filtered.length,
  });
}
