import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { kickCallbackUrl, loadKickApp, mintKickAuth, requestOrigin } from "@/lib/connectors/kick";

export const dynamic = "force-dynamic";

/**
 * POST /api/kick/state — start the OAuth 2.1 round-trip.
 *
 * Session-guarded: mints the one-time PKCE {state → verifier, redirectUri}
 * pair server-side and returns the full authorize URL. The verifier NEVER
 * leaves the panel — the callback spends it (single-use, 10-min TTL), so a
 * stolen state value buys nothing.
 */
export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`kick-state:${clientKey(req)}`, 12, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many connect attempts — wait a minute." } },
      { status: 429 },
    );
  }

  const app = await loadKickApp();
  if (!app) {
    return NextResponse.json(
      { ok: false, error: { code: "APP_MISSING", message: "Save the Kick app credentials first." } },
      { status: 400 },
    );
  }

  const redirectUri = kickCallbackUrl(requestOrigin(req));
  const { authorizeUrl } = mintKickAuth(app, redirectUri);
  return NextResponse.json({ ok: true, authorizeUrl, redirectUri });
}
