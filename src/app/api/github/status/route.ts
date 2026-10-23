import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import {
  GITHUB_SCOPES,
  TOKEN_MIRROR_PATH,
  buildRedirectUri,
  fetchGitHubUser,
  getGitHubToken,
  resolveGitHubAppConfig,
} from "@/lib/connectors/github";

/**
 * GET /api/github/status (session required)
 * Honest state machine:
 *   appConfigured        — OAuth App Client ID + Secret resolvable (VAULT first, env fallback)
 *   credentialSource     — "vault" | "env" | "none" (where the App creds live)
 *   webFlowConfigured    — client id + secret present (the OAuth click can complete)
 *   deviceFlowConfigured — client id present (device flow can start)
 *   connected            — user token in the vault; login is a MEASURED live probe
 *                          (GET api.github.com/user); a stale token reports
 *                          probe.httpStatus 401, never a fake OK.
 * No secret value ever leaves this route (P7).
 */
export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  if (!rateLimit(`github-status:${clientKey(req)}`, 60, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many requests — retry shortly." } },
      { status: 429 },
    );
  }

  const app = await resolveGitHubAppConfig();
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
    credentialSource: app.source,
    webFlowConfigured: app.configured,
    deviceFlowConfigured: Boolean(app.clientId),
    connected,
    login,
    probe,
    scopes: GITHUB_SCOPES,
    callbackUrl: buildRedirectUri(req),
    tokenMirror: TOKEN_MIRROR_PATH,
    patPolicy: "refused", // A8 — PATs are permanently refused; OAuth only
  });
}
