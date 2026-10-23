import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import {
  AUTHORIZE_URL,
  GITHUB_SCOPES,
  buildRedirectUri,
  createOAuthState,
  resolveGitHubAppConfig,
} from "@/lib/connectors/github";

/**
 * GET /api/github/authorize (session required)
 * A8: the OAuth click is the FIRST path. Issues a single-use state (10-min TTL,
 * DB-backed Setting KV — survives dev-server reloads) and 302-redirects the
 * browser to GitHub's authorize screen. Honest 501 when the App credentials are
 * absent from both the vault and env.
 *
 * Scope is the MINIMUM needed: read:user (identity probe) + public_repo (the
 * sanitized durability backup push). `repo` is deliberately NOT requested.
 */
export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  if (!rateLimit(`github-authorize:${clientKey(req)}`, 10, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many requests — retry shortly." } },
      { status: 429 },
    );
  }

  const app = await resolveGitHubAppConfig();
  if (!app.configured || !app.clientId) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "NOT_CONFIGURED",
          message:
            "GitHub OAuth App is not configured. Register an OAuth App with callback URL " +
            "<origin>/api/github/callback, then paste the Client ID and Client Secret in the panel (they are stored encrypted in the vault).",
        },
      },
      { status: 501 },
    );
  }

  const redirectUri = buildRedirectUri(req);
  const state = await createOAuthState(redirectUri);

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", GITHUB_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "true");

  return NextResponse.redirect(url.toString(), 302);
}
