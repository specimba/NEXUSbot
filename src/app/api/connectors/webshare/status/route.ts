import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { decryptSecret } from "@/lib/crypto";
import { listProxies } from "@/lib/connectors/webshare";

/**
 * T-206 — Webshare connector status (probe-first; 12-a contract update).
 *
 * Response is deliberately minimal and honest:
 *   { configured:false, routing:"off" }                          — no token in vault
 *   { configured:true, apiOk:false, error:{code,message} }       — token stored but probe failed
 *   { configured:true, apiOk:true, pool:{count,validCount,sample}, checkedAt } — live probe
 *
 * NEVER returns raw proxy IPs, usernames, passwords or credentials (P7 + task
 * contract): pool sample carries only {country?, valid?} booleans/ISO-ish codes.
 *
 * `routing` semantics since 12-a (the general egress layer exists now):
 *   "off"            — no token in vault, egress pool unusable
 *   "direct-default" — egress layer live; every upstream defaults to DIRECT;
 *                      proxy routing is opt-in per upstream via the Settings KV
 *                      `egress.routing` (e.g. {"groq":"proxy"}); verify with
 *                      POST /api/egress/probe (see egressProbe field).
 */

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  // Outbound API probes are rate-limited (Webshare proxy-list endpoints: 60/min).
  if (!rateLimit(`webshare-status:${clientKey(req)}`, 30, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many status probes — slow down." } },
      { status: 429 },
    );
  }

  const row = await db.credential.findUnique({
    where: { service_label: { service: "webshare", label: "api" } },
  });

  if (!row) {
    return NextResponse.json({ ok: true, configured: false, routing: "off" });
  }

  let apiToken: string;
  try {
    // Decrypted transiently for the probe; plaintext never leaves the process (P7).
    apiToken = decryptSecret(row.cipher);
  } catch {
    return NextResponse.json({
      ok: true,
      configured: true,
      routing: "off",
      apiOk: false,
      checkedAt: new Date().toISOString(),
      error: {
        code: "VAULT_UNREADABLE",
        message: "Stored token cannot be decrypted (vault key rotated out?) — re-save the token.",
      },
    });
  }

  // Probe one page large enough to cover the whole 30-IP pool in a single call
  // ([MEASURED] page_size=100 returns all 30 rows; server default is 25).
  const probe = await listProxies(apiToken, 100);

  if (!probe.ok) {
    return NextResponse.json({
      ok: true,
      configured: true,
      routing: "off",
      apiOk: false,
      checkedAt: new Date().toISOString(),
      error: { code: probe.code, message: probe.message },
    });
  }

  const validCount = probe.results.filter((p) => p.valid === true).length;

  return NextResponse.json({
    ok: true,
    configured: true,
    routing: "direct-default",
    egressProbe: "/api/egress/probe",
    apiOk: true,
    checkedAt: new Date().toISOString(),
    pool: {
      // `count` is Webshare's total across all pages (null if absent — honest).
      count: probe.count,
      validCount,
      sampled: probe.results.length,
      // Owner-data strip: country + validity only. No addresses, no usernames, ever.
      sample: probe.results.slice(0, 5).map((p) => ({
        country: p.country ?? null,
        valid: p.valid ?? null,
      })),
    },
  });
}
