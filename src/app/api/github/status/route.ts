import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  GITHUB_SCOPES,
  buildRedirectUri,
  fetchGitHubUser,
  getGitHubToken,
  githubAppConfig,
} from "@/lib/connectors/github";

/**
 * GET /api/github/status (session required)
 * Honest state machine: appConfigured (env creds present), connected (vault
 * token stored), login (MEASURED live probe GET api.github.com/user when a
 * token exists — a stale token reports probe.httpStatus 401, never a fake OK).
 */
export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const app = githubAppConfig();
  const token = await getGitHubToken();

  let connected = token !== null;
  let login: string | null = null;
  let probe: { ok: boolean; httpStatus: number } | null = null;

  if (token) {
    const user = await fetchGitHubUser(token);
    probe = user.ok
      ? { ok: true, httpStatus: user.httpStatus }
      : { ok: false, httpStatus: user.httpStatus };
    if (user.ok) login = user.login;
  }

  return NextResponse.json({
    ok: true,
    appConfigured: app.configured,
    connected,
    login,
    probe,
    scopes: GITHUB_SCOPES,
    callbackUrl: buildRedirectUri(req),
    patPolicy: "refused", // A8 — PATs are permanently refused; OAuth only
  });
}
