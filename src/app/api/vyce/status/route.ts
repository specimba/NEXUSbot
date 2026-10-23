import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { resolveVyceKeyFallback } from "@/lib/ai/client";
import {
  computeTierAvailability,
  emptyTierMap,
  loadVyceKey,
  probeVyce,
  resolveVyceBaseUrl,
  vyceProbeTarget,
  type VyceStatusPayload,
} from "@/lib/connectors/vyce";

/**
 * GET /api/vyce/status (session-guarded) — honest Vyce connector state.
 *
 * Probes GET {base}/v1/models live with the stored key. Key source order:
 * vault → Supabase Edge-Function secret fallback (owner stored VYCE_API_KEY
 * there). A reachable host with a rejected key is NEVER reported connected.
 *
 * P7: only a masked key preview (••••tail) and host names ever leave this
 * route — key material is decrypted transiently server-side and dropped.
 */
export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`vyce-status:${clientKey(req)}`, 30, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many status probes — slow down." } },
      { status: 429 },
    );
  }

  const baseUrl = await resolveVyceBaseUrl();
  const probeTarget = vyceProbeTarget(baseUrl);
  const probedAt = new Date().toISOString();

  const vault = await loadVyceKey();

  // --- Vault unreadable → honest VAULT_UNREADABLE, never fake-success.
  if (!vault.ok && vault.reason === "unreadable") {
    const payload: VyceStatusPayload = {
      configured: true,
      connected: false,
      keySource: null,
      modelCount: null,
      tiers: emptyTierMap(),
      maskedKey: null,
      probeTarget,
      probedAt: null,
      error: { code: "VAULT_UNREADABLE", message: "Stored Vyce key could not be decrypted — re-save it." },
      fallback: null,
    };
    return NextResponse.json({ ok: true, status: payload });
  }

  // --- Vault key present → probe with it.
  if (vault.ok) {
    const probe = await probeVyce(vault.key, baseUrl);
    const payload: VyceStatusPayload = {
      configured: true,
      connected: probe.ok,
      keySource: "vault",
      modelCount: probe.ok ? probe.models.length : null,
      tiers: probe.ok ? computeTierAvailability(probe.models) : emptyTierMap(),
      maskedKey: vault.masked,
      probeTarget,
      probedAt,
      error: probe.ok
        ? null
        : { code: probe.code, message: probe.message },
      fallback: null,
    };
    return NextResponse.json({ ok: true, status: payload });
  }

  // --- No vault key → report the Supabase edge-secret fallback state honestly.
  let fallback: VyceStatusPayload["fallback"] = { available: false, reason: null };
  try {
    const fb = await resolveVyceKeyFallback();
    if (fb.ok) {
      const probe = await probeVyce(fb.key, fb.baseUrl ?? baseUrl);
      const payload: VyceStatusPayload = {
        configured: false, // no vault key — fallback is a usable but secondary source
        connected: probe.ok,
        keySource: "supabase-edge-secret",
        modelCount: probe.ok ? probe.models.length : null,
        tiers: probe.ok ? computeTierAvailability(probe.models) : emptyTierMap(),
        maskedKey: null, // fallback key material is never even masked-displayed
        probeTarget,
        probedAt,
        error: probe.ok ? null : { code: probe.code, message: probe.message },
        fallback: { available: true, reason: null },
      };
      return NextResponse.json({ ok: true, status: payload });
    }
    fallback = { available: false, reason: fb.reason };
  } catch {
    fallback = { available: false, reason: "fallback lookup failed" };
  }

  const payload: VyceStatusPayload = {
    configured: false,
    connected: false,
    keySource: null,
    modelCount: null,
    tiers: emptyTierMap(),
    maskedKey: null,
    probeTarget,
    probedAt: null,
    error: null,
    fallback,
  };
  return NextResponse.json({ ok: true, status: payload });
}
