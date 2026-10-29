import { NextResponse } from "next/server";
import { clientKey, rateLimit } from "@/lib/guard";
import {
  exchangeSpotifyCode,
  getSpotifyUser,
  loadSpotifyApp,
  saveSpotifyOAuth,
  spendSpotifyAuth,
} from "@/lib/connectors/spotify";
import { publicOrigin } from "@/lib/connectors/kick";

export const dynamic = "force-dynamic";

/**
 * GET /api/connectors/spotify/callback — the OAuth redirect target.
 *
 * Open by design (it is the address registered in the Spotify dashboard);
 * auth is the one-time PKCE state minted by the session-guarded authorize
 * route — a stranger without a valid state gets only an error redirect.
 *
 * Flow: spend state → exchange code+verifier (form-urlencoded, PKCE — no
 * secret) → persist the pair → fetch /v1/me for the account display name →
 * redirect to /?spotify=connected (or /?spotify=error&reason=…).
 */
export async function GET(req: Request) {
  if (!rateLimit(`spotify-callback:${clientKey(req)}`, 30, 60_000)) {
    return NextResponse.json({ ok: false, error: { code: "RATE_LIMITED", message: "Slow down." } }, { status: 429 });
  }

  const url = new URL(req.url);
  const origin = await publicOrigin(req);
  const back = (state: string, reason?: string) => {
    const u = new URL(`/?spotify=${state}`, origin);
    if (reason) u.searchParams.set("reason", reason.slice(0, 80));
    return NextResponse.redirect(u, { status: 302 });
  };

  const oauthError = url.searchParams.get("error");
  if (oauthError) return back("error", oauthError);

  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !state) return back("error", "missing_code");

  const auth = spendSpotifyAuth(state);
  if (!auth) return back("error", "state_expired");

  const app = await loadSpotifyApp();
  if (!app) return back("error", "app_missing");

  try {
    const oauth = await exchangeSpotifyCode({
      code,
      verifier: auth.verifier,
      redirectUri: auth.redirectUri,
      app,
    });
    // Persist BEFORE the /v1/me call (the pool reads the vault first).
    await saveSpotifyOAuth(oauth);
    const user = await getSpotifyUser();
    if (user) {
      await saveSpotifyOAuth({ ...oauth, account: user });
    }
    return back("connected");
  } catch (e) {
    // Never leak internals to the URL bar — a short code is enough for the
    // card to explain the failure class.
    const reason = e instanceof Error ? e.message : "exchange_failed";
    return back("error", reason);
  }
}
