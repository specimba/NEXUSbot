import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { buildNewsDigest, EXA_DIGEST_SETTING } from "@/lib/brain/exa-news";

export const dynamic = "force-dynamic";

/**
 * GET /api/exa/news (?refresh=1) → the AI News Radar strip of the Exa Deep
 * Research card (Task 15-b's fourth section — this backend was missing with
 * the rest). Serves the cached AI digest (30-min TTL, URL-dedup ledger) or
 * forces a fresh pull. Cost-honest: only refresh=1 can spend Exa credits.
 */
export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  const freshStart = Date.now();
  const digest = await buildNewsDigest(refresh);
  const fresh = refresh && digest.provider !== "cache";

  return NextResponse.json({
    ok: digest.ok,
    fresh,
    brief: {
      items: digest.items.map((i) => ({
        title: i.title,
        text: i.summary,
        url: i.url,
        host: (() => {
          try {
            return new URL(i.url).hostname.replace(/^www\./, "");
          } catch {
            return "";
          }
        })(),
        date: i.date || digest.builtAt.slice(0, 10),
      })),
      formatted: digest.items.map((i, idx) => `[${idx + 1}] ${i.title} (${i.source})`).join("\n"),
      provider: digest.provider,
      tookMs: fresh ? Date.now() - freshStart : 0,
      // Cached pulls spent $0.004/1k-request-equivalent once at build time;
      // only fresh pulls report the estimated per-search cost.
      costDollars: fresh ? 0.004 : 0,
      createdAt: digest.builtAt,
    },
    error: digest.ok ? undefined : digest.error,
    setting: EXA_DIGEST_SETTING,
  });
}
