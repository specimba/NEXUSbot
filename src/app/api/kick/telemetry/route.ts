import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { fetchKickTelemetry, type KickTelemetryCode } from "@/lib/kick";

/** Error-code → HTTP mapping for the honest-error contract. */
const HTTP_BY_CODE: Record<KickTelemetryCode, number> = {
  INVALID_CHANNEL: 400,
  UPSTREAM_403: 502,
  UPSTREAM_5XX: 502,
  TIMEOUT: 504,
  PARSE: 502,
  NETWORK: 502,
};

/**
 * GET /api/kick/telemetry?channel=specimba (session required)
 *
 * MEASURED kick.com channel telemetry for the Stream tab strip. Never
 * fabricates data: when kick.com can't be reached (Cloudflare 403 / timeout /
 * bad shape) the route answers with a typed error at the mapped HTTP status.
 * Responses carry no secret material; the upstream cache (30s, per-process)
 * is reported as {hit, ageSec} so the UI can show how fresh the sample is.
 */
export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const channel = new URL(req.url).searchParams.get("channel")?.trim() || "specimba";

  const result = await fetchKickTelemetry(channel);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: { code: result.code, message: result.message } },
      { status: HTTP_BY_CODE[result.code] },
    );
  }

  return NextResponse.json({
    ok: true,
    channel: channel.toLowerCase(),
    live: result.telemetry,
    cache: result.cache,
  });
}
