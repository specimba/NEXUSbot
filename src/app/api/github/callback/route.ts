import { NextResponse } from "next/server";
import {
  consumeOAuthState,
  exchangeCodeForToken,
  githubAppConfig,
  logGitHubEvent,
  requestOrigin,
  storeGitHubToken,
} from "@/lib/connectors/github";

/**
 * GET /api/github/callback — GitHub redirects back here.
 *
 * SECURITY MODEL: this route intentionally does NOT require a panel session
 * (the browser arrives from github.com). Instead it validates the single-use,
 * 10-minute-TTL OAuth state issued by /api/github/authorize. A state that is
 * missing, unknown, expired, or replayed is refused.
 *
 * Outcomes redirect to "/" with a short flag: github=connected|denied|state_error|error.
 * P7: the code and the token are NEVER logged; error reasons are short codes.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const origin = requestOrigin(req);

  const back = (flag: string, reason?: string) => {
    const u = new URL("/", origin);
    u.searchParams.set("github", flag);
    if (reason) u.searchParams.set("reason", reason.slice(0, 64));
    return NextResponse.redirect(u.toString(), 302);
  };

  // 1. State is validated FIRST — a forged or stale callback (even one that
  //    claims `error=access_denied`) never reaches app logic.
  const state = q.get("state");
  if (!state) return back("state_error");
  const entry = consumeOAuthState(state);
  if (!entry) return back("state_error");

  // 2. A state can only exist if authorize ran; env unset mid-flow is the
  //    only path here — still reported honestly.
  if (!githubAppConfig().configured) return back("error", "not_configured");

  const oauthError = q.get("error");
  if (oauthError) return back("denied", oauthError);

  const code = q.get("code");
  if (!code) return back("state_error");

  const exchange = await exchangeCodeForToken({ code, redirectUri: entry.redirectUri });
  if (!exchange.ok) return back("error", exchange.error);

  await storeGitHubToken(exchange.accessToken);
  await logGitHubEvent("github.connected", { via: "oauth" });

  return back("connected");
}
