import { NextResponse } from "next/server";
import { clientKey, rateLimit } from "@/lib/guard";
import {
  exchangeKickCode,
  getKickUser,
  loadKickApp,
  publicOrigin,
  saveKickOAuth,
  spendKickAuth,
} from "@/lib/connectors/kick";

export const dynamic = "force-dynamic";

/**
 * GET /api/kick/callback — the OAuth 2.1 redirect target.
 *
 * Open by design: it is the address the owner registers in the Kick
 * Create-an-App form and id.kick.com redirects their browser here. Auth is
 * the one-time PKCE state minted by the session-guarded /api/kick/state —
 * a stranger hitting this route without a valid state gets nothing but a
 * redirect back to the panel with an error flag.
 *
 * Flow: spend state → exchange code+verifier (form-urlencoded, id.kick.com)
 * → fetch /public/v1/users → persist the rotated pair with the account →
 * redirect to /?kick=connected (or /?kick=error&reason=…).
 */
export async function GET(req: Request) {
  if (!rateLimit(`kick-callback:${clientKey(req)}`, 30, 60_000)) {
    return NextResponse.json({ ok: false, error: { code: "RATE_LIMITED", message: "Slow down." } }, { status: 429 });
  }

  const url = new URL(req.url);
  // v31 — the post-auth browser redirect targets the PUBLIC origin: behind
  // the preview gateway the request-derived origin is the FC tunnel host,
  // whose session-affinity gate would 400 the owner's browser at the very
  // last step of a successful OAuth round-trip.
  const origin = await publicOrigin(req);
  const back = (state: string, reason?: string) => {
    const u = new URL(`/?kick=${state}`, origin);
    if (reason) u.searchParams.set("reason", reason.slice(0, 80));
    return NextResponse.redirect(u, { status: 302 });
  };

  // Kick reports authorize-screen denials via ?error=…
  const kickError = url.searchParams.get("error");
  if (kickError) return back("error", kickError);

  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !state) return back("error", "missing_code");

  const auth = spendKickAuth(state);
  if (!auth) return back("error", "state_expired");

  const app = await loadKickApp();
  if (!app) return back("error", "app_missing");

  try {
    const oauth = await exchangeKickCode({ code, verifier: auth.verifier, redirectUri: auth.redirectUri, app });
    // Persist the rotated pair BEFORE the /users call — kickApiFetch reads
    // the token from the vault (unsaved = "not connected" = null account).
    await saveKickOAuth(oauth);
    const user = await getKickUser();
    if (user) {
      await saveKickOAuth({ ...oauth, account: user });
    }
    return back("connected");
  } catch (e) {
    // Never leak internals to the URL bar — a short code is enough for the
    // card to explain the failure class.
    const reason = e instanceof Error ? e.message : "exchange_failed";
    return back("error", reason);
  }
}
