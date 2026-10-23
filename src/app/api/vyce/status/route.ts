import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { getGroqSlotStatus, resolveVyceKeyFallback, type GroqSlotStatus } from "@/lib/ai/client";
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
 * vault → Supabase edge-relay fallback — the nexus-relay Edge Function
 * (task 17-a, harness project vwottesqbdgcsmvvvzok) holds the EF-secret
 * plaintext in its runtime and proxies authenticated calls to vyceai.com.
 * The relay is the ONLY honest way to use EF-stored keys [MEASURED]: the
 * Management API GET /v1/projects/{ref}/secrets returns `value` = SHA256
 * DIGEST (64-hex), never plaintext — reading that digest and sending it as a
 * Bearer key produced the eternal, unfixable 401 "invalid_api_key". This route
 * therefore probes the RELAY URL with the panel relay secret; probeTarget is
 * always the host actually probed (the relay host <ref>.supabase.co).
 * A reachable host with a rejected key is NEVER reported connected.
 *
 * Task 13-b ADDITIVE field: the top-level `groq` sibling carries the Groq
 * provider slot status (getGroqSlotStatus) — the `status` object itself is
 * byte-identical to the pre-13-b contract, so existing consumers are unaffected.
 *
 * P7: only a masked key preview (••••tail) and host names ever leave this
 * route — key material (vault key AND relay secret) is decrypted transiently
 * server-side and dropped.
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

  // Additive Groq slot field — computed once, guarded so a Groq-side failure can
  // never disturb the Vyce payload contract (honest error inside the field).
  let groq: GroqSlotStatus | { error: { code: string; message: string } };
  try {
    groq = await getGroqSlotStatus();
  } catch {
    groq = {
      error: { code: "SLOT_UNAVAILABLE", message: "Groq slot status could not be computed right now." },
    };
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
    return NextResponse.json({ ok: true, status: payload, groq });
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
    return NextResponse.json({ ok: true, status: payload, groq });
  }

  // --- No vault key → report the Supabase edge-relay fallback state honestly.
  // The relay carries the real EF-secret plaintext; probing it is probing the
  // actual upstream auth path (task 16-a doctrine: probeTarget = probed host,
  // here the relay host <ref>.supabase.co).
  let fallback: VyceStatusPayload["fallback"] = { available: false, reason: null, projectRef: null };
  try {
    const fb = await resolveVyceKeyFallback();
    if (fb.ok) {
      // Task 16-a: probeTarget must be the host of the URL ACTUALLY probed —
      // via the relay that is <ref>.supabase.co (never claim vyceai.com while
      // probing the relay edge).
      const probedBase = fb.baseUrl ?? baseUrl;
      const probe = await probeVyce(fb.key, probedBase);
      // Task 16-a/17-b: name the rejected secret plainly when the EF key fails
      // (the 401 passed through the relay verbatim from Vyce — honest key
      // rejection, not a relay-auth failure).
      const error = probe.ok
        ? null
        : probe.code === "UNAUTHORIZED"
          ? {
              code: probe.code,
              message:
                "The VYCE_API_KEY stored in the Supabase Edge-Function secrets was rejected by Vyce (HTTP 401 invalid_api_key) — reached via the nexus-relay edge function; update the secret in the Supabase dashboard (harness project) or paste a fresh key in the panel.",
            }
          : { code: probe.code, message: probe.message };
      const payload: VyceStatusPayload = {
        configured: false, // no vault key — fallback is a usable but secondary source
        connected: probe.ok,
        keySource: "supabase-edge-relay",
        modelCount: probe.ok ? probe.models.length : null,
        tiers: probe.ok ? computeTierAvailability(probe.models) : emptyTierMap(),
        maskedKey: null, // fallback key material is never even masked-displayed
        probeTarget: vyceProbeTarget(probedBase),
        probedAt,
        error,
        fallback: { available: true, reason: null, projectRef: fb.projectRef ?? null },
      };
      return NextResponse.json({ ok: true, status: payload, groq });
    }
    fallback = { available: false, reason: fb.reason, projectRef: null };
  } catch {
    fallback = { available: false, reason: "fallback lookup failed", projectRef: null };
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
  return NextResponse.json({ ok: true, status: payload, groq });
}
