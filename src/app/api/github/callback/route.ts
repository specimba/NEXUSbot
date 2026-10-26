import { NextResponse } from "next/server";
import {
  consumeOAuthState, // DB-backed Setting KV — match-guarded single-use (12-b)
  exchangeCodeForToken,
  logGitHubEvent,
  requestOrigin,
  resolveGitHubAppConfig,
  storeGitHubToken,
} from "@/lib/connectors/github";

/**
 * GET /api/github/callback — GitHub redirects back here.
 *
 * SECURITY MODEL: this route intentionally does NOT require a panel session
 * (the browser arrives from github.com). Instead it validates the single-use,
 * 10-minute-TTL OAuth state issued by /api/github/authorize. A state that is
 * missing, unknown, expired, or replayed is refused. GitHub error params
 * (error=access_denied …) are turned into an honest redirect-back summary.
 *
 * Outcomes redirect to "/" with a short flag: github=connected|denied|state_error|error
 * plus a short machine reason. P7: the code and the token are NEVER logged;
 * error reasons are short codes. Duplicate/used codes (GitHub single-use) are
 * surfaced as code_reused_or_invalid instead of a generic failure.
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
  const entry = await consumeOAuthState(state);
  if (!entry) return back("state_error");

  // 2. A state can only exist if authorize ran; credentials removed mid-flow is
  //    the only path here — still reported honestly.
  const app = await resolveGitHubAppConfig();
  if (!app.configured) return back("error", "not_configured");

  // 3. GitHub-reported user denial or upstream error (state was echoed back).
  const oauthError = q.get("error");
  if (oauthError) return back("denied", oauthError);

  const code = q.get("code");
  if (!code) return back("state_error");

  const exchange = await exchangeCodeForToken({ code, redirectUri: entry.redirectUri });
  if (!exchange.ok) {
    // Honest mapping of GitHub's OAuth error codes (values are short codes only).
    // MEASURED 2026-10-23: unknown client_id → 404 {"error":"Not Found"} on both
    // the authorize/token endpoints.
    const reason =
      exchange.error === "bad_verification_code"
        ? "code_reused_or_invalid" // single-use code replayed/expired — start again
        : exchange.error === "incorrect_client_credentials" ||
            exchange.error === "unauthorized_client" ||
            exchange.error === "Not Found" ||
            exchange.error === "http_404"
          ? "app_credentials_rejected" // Client ID/Secret wrong — fix in the panel
          : exchange.error === "redirect_uri_mismatch"
            ? "redirect_uri_mismatch" // OAuth App callback URL differs from the panel's
            : exchange.error;
    await logGitHubEvent("github.connect_failed", { reason, via: "oauth" });
    return back("error", reason);
  }

  await storeGitHubToken(exchange.accessToken); // vault + ops/vault mirror (atomic)
  await logGitHubEvent("github.connected", { via: "oauth" });

  return back("connected");
}
