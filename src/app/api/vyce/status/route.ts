import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { getGroqSlotStatus, resolveVyceKeyFallback, type GroqSlotStatus } from "@/lib/ai/client";
import { routeFor, readRoutingMap } from "@/lib/egress";
import {
  computeTierAvailability,
  emptyTierMap,
  loadVyceKey,
  probeVyce,
  resolveVyceBaseUrl,
  sharpenVyceProbeWithOriginHealth,
  vyceProbeTarget,
  VYCE_PROBE_TIMEOUT_PROXY_MS,
  VYCE_RELAY_PROBE_TIMEOUT_MS,
  VYCE_TIMEOUT_MS,
  type VyceOriginVerdict,
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
 * R18-a (Vyce truth) — timeout/egress/origin honesty:
 * - Vault branch probes through the SAME egress chats use (routeFor("vyce",
 *   readRoutingMap()); 12s per proxied pool attempt / 8s direct).
 * - Relay-fallback branch probes with an 18s budget: the nexus-relay waits up
 *   to 15s on its upstream before answering its honest 502 [MEASURED R18-0:
 *   502 UPSTREAM_UNREACHABLE at 15.1s] — the pre-R18-a 8s probe timed out
 *   BEFORE that answer and under-reported the outage as "did not respond".
 * - A failed vault probe (NETWORK_ERROR/ORIGIN_DOWN/UPSTREAM_KEY_MISSING
 *   against vyceai.com) is sharpened with the no-key origin-health probe:
 *   origin up → transport error kept + origin-alive note (egress problem);
 *   origin down → ORIGIN_DOWN (Vyce-side outage). Additive payload field
 *   `origin: "up" | "down" | "unknown" | null` carries the verdict.
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
      origin: null,
    };
    return NextResponse.json({ ok: true, status: payload, groq });
  }

  // --- Vault key present → probe with it through the SAME egress chats use
  // (R18-a): route = routeFor("vyce", routing map) — the live map has
  // vyce=proxy — with a 12s budget per proxied pool attempt / 8s direct. A
  // failed probe is then sharpened with the no-key origin-health probe so a
  // Vyce-side outage is reported as ORIGIN_DOWN, never a vague "unreachable".
  if (vault.ok) {
    const route = routeFor("vyce", await readRoutingMap());
    let probe = await probeVyce(vault.key, baseUrl, {
      timeoutMs: route === "proxy" ? VYCE_PROBE_TIMEOUT_PROXY_MS : VYCE_TIMEOUT_MS,
      route,
    });
    let origin: VyceOriginVerdict | null = null;
    if (!probe.ok) {
      const sharpened = await sharpenVyceProbeWithOriginHealth(probe, baseUrl, route);
      probe = sharpened.probe;
      origin = sharpened.origin;
    }
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
      origin,
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
      // R18-a: 18s budget — the relay answers its honest 502 at ~15.1s
      // [MEASURED R18-0]; an 8s probe times out BEFORE that answer arrives
      // and under-reports a Vyce-side outage as "did not respond".
      const probe = await probeVyce(fb.key, probedBase, { timeoutMs: VYCE_RELAY_PROBE_TIMEOUT_MS });
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
      // R18-a: a relay-side ORIGIN_DOWN (its 502 UPSTREAM_UNREACHABLE body or a
      // verbatim 52x pass-through) is a MEASURED vyceai.com origin verdict —
      // the relay tried vyceai.com for 15s so the owner doesn't have to guess.
      const origin: VyceOriginVerdict | null = probe.ok
        ? null
        : probe.code === "ORIGIN_DOWN"
          ? "down"
          : null;
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
        origin,
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
    origin: null,
  };
  return NextResponse.json({ ok: true, status: payload, groq });
}
