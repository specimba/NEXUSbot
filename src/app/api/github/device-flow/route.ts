import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  deleteDeviceFlowSession,
  getDeviceFlowSession,
  getTerminalFlow,
  githubAppConfig,
  looksLikeGitHubPat,
  pollDeviceFlow,
  putDeviceFlowSession,
  rememberTerminalFlow,
  startDeviceFlow,
} from "@/lib/connectors/github";

/**
 * GitHub DEVICE FLOW — the documented FALLBACK path only (A8: OAuth click is
 * always the first option). Used when the operator cannot complete a browser
 * redirect round-trip.
 *
 * POST → starts a flow: server fetches github.com/login/device/code and keeps
 *        the device_code SERVER-SIDE; the browser only receives user_code,
 *        verification_uri, interval, expires_in.
 * GET  ?flow=<id> → performs ONE polling round against the token endpoint.
 *        On success the user token is written to the encrypted vault.
 *
 * A8 enforcement: any PAT-shaped value in a body is refused with 403
 * PAT_REFUSED — never parsed, never stored, never echoed.
 */
export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body && looksLikeGitHubPat(body.pat ?? body.token)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "PAT_REFUSED",
          message: "PAT refused by A8 — use OAuth (Connect button) or the device flow.",
        },
      },
      { status: 403 },
    );
  }

  if (!githubAppConfig().configured) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "NOT_CONFIGURED",
          message:
            "GitHub OAuth App is not configured (device flow needs GITHUB_CLIENT_ID in .env).",
        },
      },
      { status: 501 },
    );
  }

  const start = await startDeviceFlow();
  if (!start.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "DEVICE_FLOW_FAILED",
          message: `Device flow could not start (${start.error}).`,
        },
      },
      { status: 502 },
    );
  }

  const flow = putDeviceFlowSession(start);
  return NextResponse.json({ ok: true, flow });
}

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  if (!githubAppConfig().configured) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "NOT_CONFIGURED", message: "GitHub OAuth App is not configured." },
      },
      { status: 501 },
    );
  }

  const flowId = new URL(req.url).searchParams.get("flow") ?? "";
  const session = getDeviceFlowSession(flowId);
  if (!session) {
    // Round-9 tombstone replay: a terminal flow must answer with its terminal
    // status, never a 404 — the panel invalidation can legitimately refetch
    // this exact query right after the terminal response (MEASURED race).
    const replayed = getTerminalFlow(flowId);
    if (replayed) {
      return NextResponse.json({ ok: true, status: replayed, replayed: true });
    }
    return NextResponse.json(
      {
        ok: false,
        error: { code: "FLOW_NOT_FOUND", message: "Unknown or expired device flow — start a new one." },
      },
      { status: 404 },
    );
  }

  const result = await pollDeviceFlow(session.deviceCode);
  if (result.status === "connected" || result.status === "expired" || result.status === "denied") {
    rememberTerminalFlow(flowId, result.status);
    deleteDeviceFlowSession(flowId);
  }

  return NextResponse.json({ ok: true, status: result.status });
}
