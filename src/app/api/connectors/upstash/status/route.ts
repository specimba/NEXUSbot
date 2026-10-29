import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { decryptSecret } from "@/lib/crypto";
import {
  UPSTASH_LABEL,
  UPSTASH_SERVICE,
  UpstashConnectorError,
  parseUpstashSecret,
  upstashPing,
} from "@/lib/connectors/upstash";

/**
 * T-204 Upstash connector status. Auth: panel session.
 * Health is PROBED LIVE against {url}/ping on every request — never cached,
 * never faked. The stored token/url are never returned (P7); error messages are
 * pre-sanitized by the connector lib (codes only, no host/credential).
 */
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  const row = await db.credential.findUnique({
    where: { service_label: { service: UPSTASH_SERVICE, label: UPSTASH_LABEL } },
  });

  if (!row) {
    return NextResponse.json({ ok: true, configured: false });
  }

  let raw: string;
  try {
    raw = decryptSecret(row.cipher);
  } catch {
    return NextResponse.json({
      ok: true,
      configured: true,
      healthy: false,
      error: {
        code: "VAULT_UNREADABLE",
        message: "Stored credential could not be decrypted (vault key rotated out?) — re-save it.",
      },
    });
  }

  const cfg = parseUpstashSecret(raw);
  if (!cfg) {
    return NextResponse.json({
      ok: true,
      configured: true,
      healthy: false,
      error: {
        code: "BAD_CONFIG",
        message: "Stored credential is not valid {url, token} JSON — re-save it.",
      },
    });
  }

  try {
    const { latencyMs } = await upstashPing(cfg);
    return NextResponse.json({
      ok: true,
      configured: true,
      healthy: true,
      latencyMs,
      probedAt: new Date().toISOString(),
    });
  } catch (e) {
    const typed = e instanceof UpstashConnectorError ? e : null;
    return NextResponse.json({
      ok: true,
      configured: true,
      healthy: false,
      error: {
        code: typed?.kind ?? "UNKNOWN",
        message: typed?.message ?? "Live probe failed for an unexpected reason.",
      },
    });
  }
}
