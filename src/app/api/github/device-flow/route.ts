import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import {
  deleteDeviceFlowSession,
  getDeviceFlowSession,
  getTerminalFlow,
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
 *        On success the user token is written to the encrypted vault AND
 *        mirrored to ops/vault/github.token (0600) for snapshot-backup.sh.
 *
 * A8 enforcement: any PAT-shaped value in a body is refused with 403
 * PAT_REFUSED — never parsed, never stored, never echoed.
 *
 * Error honesty: a Client ID GitHub refuses (unauthorized_client etc.) is
 * classified as APP_CREDENTIALS_REJECTED — the operator is told to fix the
 * stored credentials, not shown a generic failure or a hang.
 */

/** GitHub error codes that mean "the stored App credentials are wrong". */
const CRED_REJECTION_CODES = new Set([
  "unauthorized_client",
  "incorrect_client_credentials",
  "bad_verification_code",
  "http_400",
  "http_401",
  "http_404", // MEASURED 2026-10-23: unknown client_id on /login/device/code → 404 {"error":"Not Found"}
  "Not Found",
]);

function classifyStartError(error: string): { code: string; message: string } {
  if (error === "http_404" || error === "Not Found") {
    return {
      code: "APP_CREDENTIALS_REJECTED",
      message:
        "GitHub does not recognize the stored Client ID (404 Not Found) — the OAuth App was deleted or the ID is wrong. Fix it in the GitHub card, then retry.",
    };
  }
  if (CRED_REJECTION_CODES.has(error)) {
    return {
      code: "APP_CREDENTIALS_REJECTED",
      message: `GitHub rejected the stored App credentials (github said: ${error}). Fix the Client ID / Client Secret in the GitHub card, then retry.`,
    };
  }
  if (error === "network") {
    return {
      code: "DEVICE_FLOW_FAILED",
      message: "Could not reach github.com to start the device flow (network error).",
    };
  }
  return {
    code: "DEVICE_FLOW_FAILED",
    message: `Device flow could not start (github said: ${error}).`,
  };
}

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  if (!rateLimit(`github-device-post:${clientKey(req)}`, 10, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many requests — retry in a minute." } },
      { status: 429 },
    );
  }

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

  const start = await startDeviceFlow();
  if (!start.ok) {
    const { code, message } = classifyStartError(start.error);
    return NextResponse.json({ ok: false, error: { code, message } }, { status: code === "APP_CREDENTIALS_REJECTED" ? 400 : 502 });
  }

  const flow = putDeviceFlowSession(start);
  return NextResponse.json({ ok: true, flow });
}

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  if (!rateLimit(`github-device-poll:${clientKey(req)}`, 120, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Polling too fast — retry shortly." } },
      { status: 429 },
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

  if (result.status === "error") {
    const { code, message } = classifyStartError(result.error);
    return NextResponse.json({ ok: true, status: "error", error: { code, message } });
  }

  return NextResponse.json({ ok: true, status: result.status });
}
