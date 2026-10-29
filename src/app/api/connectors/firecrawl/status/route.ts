import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { loadFirecrawlKey, probeFirecrawl, type FirecrawlStatusPayload } from "@/lib/connectors/firecrawl";

/**
 * v37.1 — Firecrawl connector status (the METERED backup lane). Session-guarded.
 *
 * Probe: 1-credit example.com scrape — the burn is honest and visible on the
 * card (1,400 credits reset Nov 29). This lane only earns calls when the two
 * free readers (TinyFish, Keenable) both fail the same page.
 */
function respond(status: FirecrawlStatusPayload) {
  return NextResponse.json({ ok: true, status });
}

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  const loaded = await loadFirecrawlKey();

  if (!loaded.ok && loaded.reason === "missing") {
    return respond({
      configured: false,
      reachable: null,
      apiOk: null,
      error: null,
      credential: null,
      probedAt: null,
      sampleTitle: null,
    });
  }
  if (!loaded.ok) {
    return respond({
      configured: true,
      reachable: null,
      apiOk: null,
      error: "Stored Firecrawl key is unreadable (vault key rotated out?) — re-save the key.",
      credential: null,
      probedAt: null,
      sampleTitle: null,
    });
  }

  const probe = await probeFirecrawl(loaded.key);
  return respond({
    configured: true,
    ...probe,
    credential: { masked: loaded.masked, keyId: loaded.keyId, updatedAt: loaded.updatedAt },
  });
}
