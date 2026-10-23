import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  hyperbrowserProbeTarget,
  loadHyperbrowserKey,
  probeHyperbrowser,
  type HyperbrowserStatusPayload,
} from "@/lib/connectors/hyperbrowser";

/**
 * T-205 — Hyperbrowser connector status. Session-guarded (requireSession).
 *
 * Response shape: { ok, status: { configured, reachable, apiOk, error, … } }
 * - configured:false → no key in the vault (nothing probed).
 * - configured:true + vault-unreadable → honest error, nothing probed.
 * - configured:true → live probe of GET /api/sessions (8s timeout) with the
 *   vault key. Reachability and API health are reported separately — a
 *   reachable host with a rejected key is NOT "connected" (zero theatre).
 */

function respond(status: HyperbrowserStatusPayload) {
  return NextResponse.json({ ok: true, status });
}

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  const probeTarget = hyperbrowserProbeTarget();
  const loaded = await loadHyperbrowserKey();

  if (!loaded.ok && loaded.reason === "missing") {
    return respond({
      configured: false,
      reachable: null,
      apiOk: null,
      error: null,
      credential: null,
      probedAt: null,
      probeTarget,
      sessionsCount: null,
    });
  }

  if (!loaded.ok) {
    return respond({
      configured: true,
      reachable: null,
      apiOk: null,
      error:
        "Stored Hyperbrowser key is unreadable (vault key rotated out?) — re-save the key.",
      credential: null,
      probedAt: null,
      probeTarget,
      sessionsCount: null,
    });
  }

  const probe = await probeHyperbrowser(loaded.key);
  const probedAt = new Date().toISOString();
  const credential = { masked: loaded.masked, keyId: loaded.keyId, updatedAt: loaded.updatedAt };

  if (probe.ok) {
    return respond({
      configured: true,
      reachable: true,
      apiOk: true,
      error: null,
      credential,
      probedAt,
      probeTarget,
      sessionsCount: probe.sessionsCount,
    });
  }

  const reachable = probe.kind !== "timeout" && probe.kind !== "network";
  return respond({
    configured: true,
    reachable,
    apiOk: false,
    error:
      probe.kind === "auth"
        ? `${probe.error} — save a valid Hyperbrowser API key or disconnect.`
        : probe.error,
    credential,
    probedAt,
    probeTarget,
    sessionsCount: null,
  });
}
