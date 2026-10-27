import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { getGroqSlotStatus, resolveVyceKeyFallback, type GroqSlotStatus } from "@/lib/ai/client";
import { readVyceStatusCache, writeVyceStatusCache } from "@/lib/vyce-status-cache";
import {
  computeTierAvailability,
  emptyTierMap,
  loadVyceKey,
  probeVyceRouted,
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
 * Fingerprint-aware (owner's live 401 loop): a vault value that is 64-hex
 * (SHA-256 fingerprint) can never authenticate — it is SKIPPED, the
 * edge-secret fallback is probed instead, and `vaultIgnored` explains why
 * in the panel. The card tells the owner to paste the RAW key.
 *
 * Task 13-b ADDITIVE field: the top-level `groq` sibling carries the Groq
 * provider slot status (getGroqSlotStatus) — the `status` object itself is
 * byte-identical to the pre-13-b contract, so existing consumers are unaffected.
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

  // v31.4 — PROBE CACHE (owner: "page giving OOM error freeze constantly").
  // dev.log measured this route at 10-18s PER POLL (live 10-model probe)
  // while the Connectors card polls every ~30s — the panel hung on every
  // visit. The verdict is cached for 90s; key save/delete (see /api/vyce/key)
  // invalidates instantly.
  const hit = readVyceStatusCache();
  if (hit) return NextResponse.json(hit);

  const body = await computeVyceStatus();
  writeVyceStatusCache(body);
  return NextResponse.json(body);
}

async function computeVyceStatus() {
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
      route: null,
      error: { code: "VAULT_UNREADABLE", message: "Stored Vyce key could not be decrypted — re-save it." },
      fallback: null,
    };
    return { ok: true, status: payload, groq };
  }

  // --- Vault key present → probe with it.
  if (vault.ok) {
    const probe = await probeVyceRouted(vault.key, baseUrl);

    // Fingerprint-shaped vault value: it can never authenticate — do NOT stop
    // at the 401. Probe the Supabase edge-secret fallback too and report the
    // full truth (vault ignored + fallback verdict) so the owner sees the way
    // out (paste the raw key) instead of a dead end.
    if (vault.fingerprint) {
      const ignoredMsg =
        "The stored vault value is a 64-hex SHA-256 fingerprint, not a raw key — it was skipped (it can never authenticate). Paste the raw Vyce key below to replace it.";
      let fb: VyceStatusPayload = {
        configured: true,
        connected: false,
        keySource: "vault",
        modelCount: null,
        tiers: emptyTierMap(),
        maskedKey: vault.masked,
        probeTarget,
        probedAt,
        route: null,
        error: { code: "STORED_KEY_IS_FINGERPRINT", message: ignoredMsg },
        fallback: { available: false, reason: null },
        vaultIgnored: ignoredMsg,
      };
      try {
        const f = await resolveVyceKeyFallback();
        if (f.ok) {
          const fp = await probeVyceRouted(f.key, f.baseUrl ?? baseUrl);
          fb = {
            configured: true,
            connected: fp.ok,
            keySource: "supabase-edge-secret",
            modelCount: fp.ok ? fp.models.length : null,
            tiers: fp.ok ? computeTierAvailability(fp.models) : emptyTierMap(),
            maskedKey: vault.masked,
            probeTarget,
            probedAt,
            route: fp.route,
            error: fp.ok ? null : { code: fp.code, message: fp.message },
            fallback: { available: true, reason: null },
            vaultIgnored: ignoredMsg,
          };
        } else {
          fb.fallback = { available: false, reason: f.reason };
        }
      } catch {
        fb.fallback = { available: false, reason: "fallback lookup failed" };
      }
      return { ok: true, status: fb, groq };
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
      route: probe.route,
      error: probe.ok
        ? null
        : { code: probe.code, message: probe.message },
      fallback: null,
    };
    return { ok: true, status: payload, groq };
  }

  // --- No vault key → report the Supabase edge-secret fallback state honestly.
  let fallback: VyceStatusPayload["fallback"] = { available: false, reason: null };
  try {
    const fb = await resolveVyceKeyFallback();
    if (fb.ok) {
      const probe = await probeVyceRouted(fb.key, fb.baseUrl ?? baseUrl);
      const payload: VyceStatusPayload = {
        configured: false, // no vault key — fallback is a usable but secondary source
        connected: probe.ok,
        keySource: "supabase-edge-secret",
        modelCount: probe.ok ? probe.models.length : null,
        tiers: probe.ok ? computeTierAvailability(probe.models) : emptyTierMap(),
        maskedKey: null, // fallback key material is never even masked-displayed
        probeTarget,
        probedAt,
        route: probe.route,
        error: probe.ok ? null : { code: probe.code, message: probe.message },
        fallback: { available: true, reason: null },
      };
      return { ok: true, status: payload, groq };
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
    route: null,
    error: null,
    fallback,
  };
  return { ok: true, status: payload, groq };
}
