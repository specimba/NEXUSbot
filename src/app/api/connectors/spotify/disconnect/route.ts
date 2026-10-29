import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { deleteSpotifyOAuth, revokeSpotifyTokens } from "@/lib/connectors/spotify";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/connectors/spotify/disconnect — drop the ACCOUNT connection.
 *
 * Revokes at accounts.spotify.com best-effort (a network failure must not
 * block the local wipe), then removes the oauth vault row. The app Client ID
 * stays — reconnecting is one click. The grounding YAYIN card and the
 * deterministic lane fall to their honest NOT_CONFIGURED answers
 * automatically (the state machine makes "unconfigured" a real state).
 */
export async function DELETE(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`spotify-disconnect:${clientKey(req)}`, 20, 60_000)) {
    return NextResponse.json({ ok: false, error: { code: "RATE_LIMITED", message: "Slow down." } }, { status: 429 });
  }

  await revokeSpotifyTokens();
  await deleteSpotifyOAuth();
  return NextResponse.json({ ok: true, disconnected: true });
}
