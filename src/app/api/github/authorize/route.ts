import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  AUTHORIZE_URL,
  GITHUB_SCOPES,
  buildRedirectUri,
  createOAuthState,
  githubAppConfig,
} from "@/lib/connectors/github";

/**
 * GET /api/github/authorize (session required)
 * A8: the OAuth click is the FIRST path. Issues a single-use state (10-min
 * TTL, in-memory) and 302-redirects the browser to GitHub's authorize screen.
 * Honest 501 when the OAuth App env creds are absent.
 */
export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const app = githubAppConfig();
  if (!app.configured || !app.clientId) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "NOT_CONFIGURED",
          message:
            "GitHub OAuth App is not configured. Register an OAuth App with callback URL " +
            "<origin>/api/github/callback, then set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in .env.",
        },
      },
      { status: 501 },
    );
  }

  const redirectUri = buildRedirectUri(req);
  const state = createOAuthState(redirectUri);

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", GITHUB_SCOPES.join(" "));
  url.searchParams.set("state", state);

  return NextResponse.redirect(url.toString(), 302);
}
