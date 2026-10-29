import { NextResponse } from "next/server";
import { clientKey, rateLimit } from "@/lib/guard";
import { hasBrainAccess } from "@/lib/brain/auth";
import { peekNowPlaying, getSpotifyHistory, snapshotIsFresh } from "@/lib/connectors/spotify";
import { ensureGroundingFresh } from "@/lib/brain/grounding";

export const dynamic = "force-dynamic";

/**
 * GET /api/brain/nowplaying — the machine-readable now-playing feed.
 *
 * Brain-token gated (the OBS widget's x-nexus-token) OR a panel session —
 * the same gate as /api/brain/context. THE HEARTBEAT: the panel Brain tab
 * polls this every 15-20s, which keeps the in-process Spotify snapshot warm
 * with no background timer and no new mini-service (plan critique #4).
 * Responses are no-store (live data), P7-clean: booleans + track metadata,
 * never token material.
 */
export async function GET(req: Request) {
  const allowed = await hasBrainAccess(req);
  if (!allowed) {
    return NextResponse.json({ ok: false, error: { code: "UNAUTHORIZED", message: "Brain token or session required." } }, { status: 401 });
  }
  if (!rateLimit(`brain-nowplaying:${clientKey(req)}`, 120, 60_000)) {
    return NextResponse.json({ ok: false, error: { code: "RATE_LIMITED", message: "Slow down." } }, { status: 429 });
  }

  // Fire-and-forget cache warm (the poll IS the heartbeat) — never awaited.
  ensureGroundingFresh();
  const snap = peekNowPlaying();
  const history = await getSpotifyHistory(5);

  return NextResponse.json(
    {
      ok: true,
      connected: snap ? snap.state !== "NOT_CONFIGURED" && snap.state !== "NEEDS_REAUTH" : false,
      fresh: snapshotIsFresh(snap),
      snapshot: snap
        ? {
            state: snap.state,
            isPlaying: snap.isPlaying,
            track: snap.track,
            device: snap.device,
            fetchedAt: snap.fetchedAt,
            ageS: Math.max(0, Math.round((Date.now() - snap.fetchedAt) / 1000)),
          }
        : null,
      history,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
