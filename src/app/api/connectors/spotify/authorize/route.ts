import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { loadSpotifyApp, mintSpotifyAuth, spotifyCallbackUrl } from "@/lib/connectors/spotify";
import { publicOrigin } from "@/lib/connectors/kick";

export const dynamic = "force-dynamic";

/**
 * POST /api/connectors/spotify/authorize — start the OAuth PKCE round-trip.
 *
 * Session-guarded: mints the one-time {state → verifier, redirectUri} pair
 * server-side and returns the full accounts.spotify.com authorize URL. The
 * redirect_uri is the PUBLIC origin (anchored truth via kick.ts publicOrigin)
 * — the exact string the card tells the owner to register in the Spotify
 * dashboard. The verifier never leaves the panel.
 */
export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`spotify-authorize:${clientKey(req)}`, 12, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many connect attempts — wait a minute." } },
      { status: 429 },
    );
  }

  const app = await loadSpotifyApp();
  if (!app) {
    return NextResponse.json(
      { ok: false, error: { code: "APP_MISSING", message: "Save the Spotify Client ID first." } },
      { status: 400 },
    );
  }

  const origin = await publicOrigin(req);
  const redirectUri = spotifyCallbackUrl(origin);
  const { authorizeUrl } = mintSpotifyAuth(app, redirectUri);
  return NextResponse.json({ ok: true, authorizeUrl, redirectUri });
}
