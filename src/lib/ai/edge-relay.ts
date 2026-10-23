import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getMgmtPat, mgmtUpsertSecrets } from "@/lib/connectors/supabase";
import { registerSecretForRedaction } from "@/lib/ai/client";

/**
 * NEXUS OS — Supabase Edge-Function relay plumbing (task 17-b).
 *
 * ROOT CAUSE [MEASURED, task 17 context]: the Supabase Management API
 * GET /v1/projects/{ref}/secrets returns `value` = SHA256 DIGEST (64-hex), never
 * plaintext. The old brain fallback therefore sent sha256(VYCE_API_KEY) to
 * Vyce → eternal 401 "invalid_api_key" that NO owner-side rotation could fix.
 * The plaintext exists only inside an Edge Function runtime.
 *
 * THE FIX: the `nexus-relay` Deno Edge Function (deployed on the harness
 * project by task 17-a) holds the real EF-secret plaintext in its runtime and
 * PROXIES authenticated OpenAI-style calls to vyceai.com / api.groq.com. This
 * module is the SINGLE place the panel-side relay plumbing lives:
 *
 *   GET  {relay}/health                       (no auth) → {"ok":true,"upstream":{...}}
 *   GET  {relay}/vyce/v1/models               → vyceai.com/v1/models
 *   POST {relay}/vyce/v1/chat/completions     → vyceai.com/v1/chat/completions
 *   POST {relay}/vyce/v1/images/generations
 *   GET  {relay}/groq/openai/v1/models        → api.groq.com/openai/v1/models
 *   POST {relay}/groq/openai/v1/chat/completions
 *
 * All proxy routes require `Authorization: Bearer <NEXUS_PANEL_RELAY_SECRET>`.
 * The relay secret lives in OUR vault (service "supabase", label
 * "relay-secret"); when absent it is AUTO-PROVISIONED: generated here, written
 * to the harness project's EF secrets via the Mgmt API, and stored encrypted in
 * the vault (self-healing: an undecryptable vault row is treated as missing and
 * overwritten).
 *
 * Streaming: the relay passes SSE through unbuffered, so the brain's
 * direct-fetch streaming path (streamComplete) works unchanged against
 * {relay}/vyce/v1/chat/completions.
 *
 * 401 semantics (honesty contract): a 401 FROM THE RELAY means relay-auth
 * failure; a 401 from the upstream passes through the relay verbatim — an
 * upstream key rejection stays an honest upstream key rejection.
 *
 * ============================================================================
 * P7 — the relay secret IS key material: it is generated/decrypted transiently,
 * registered for redaction, used ONLY in the Authorization header, and never
 * logged, echoed, returned in a response body, or embedded in an Error.
 * ============================================================================
 */

/** The harness project — hosts the nexus-relay Edge Function. */
export const NEXUS_RELAY_REF = "vwottesqbdgcsmvvvzok";

/** Deno Edge Function name deployed by task 17-a. */
export const NEXUS_RELAY_FUNCTION = "nexus-relay";

/** Full relay root URL (Supabase Functions v1 path). */
export const NEXUS_RELAY_URL = `https://${NEXUS_RELAY_REF}.supabase.co/functions/v1/${NEXUS_RELAY_FUNCTION}`;

/** Vault coordinates of the relay secret (service "supabase", label "relay-secret"). */
export const RELAY_SECRET_SERVICE = "supabase";
export const RELAY_SECRET_LABEL = "relay-secret";

/** Edge Function secret key name the relay reads at runtime. */
export const RELAY_SECRET_ENV_KEY = "NEXUS_PANEL_RELAY_SECRET";

/** Relay base URLs the brain client points its OpenAI-compatible calls at. */
export function relayVyceBaseUrl(): string {
  return `${NEXUS_RELAY_URL}/vyce/v1`;
}

export function relayGroqBaseUrl(): string {
  return `${NEXUS_RELAY_URL}/groq/openai/v1`;
}

export type RelayCredentials =
  | { ok: true; relaySecret: string; relayUrl: string; projectRef: string }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// 60s TTL cache — mirrors the fallback-cache pattern in src/lib/ai/client.ts
// (negative results are cached too, so a missing PAT/secret does not hammer
// the vault or the Mgmt API on every status poll).
// ---------------------------------------------------------------------------

let relayCredsCache: { at: number; result: RelayCredentials } | null = null;
const RELAY_CREDS_TTL = 60_000;

// Stampede-proof provisioning mutex: concurrent resolutions share ONE
// provisioning attempt instead of racing duplicate Mgmt writes.
let provisionInFlight: Promise<RelayCredentials> | null = null;

/**
 * Resolve the relay credentials: vault relay-secret (decrypted transiently) →
 * auto-provision (generate + Mgmt write + vault store) → honest reason.
 * Never throws; failures are data.
 */
export async function getRelayCredentials(): Promise<RelayCredentials> {
  const now = Date.now();
  if (relayCredsCache && now - relayCredsCache.at < RELAY_CREDS_TTL) return relayCredsCache.result;

  const result = await (async (): Promise<RelayCredentials> => {
    const pat = await getMgmtPat();
    if (!pat) {
      return { ok: false, reason: "supabase PAT not stored — connect the Supabase connector first" };
    }
    registerSecretForRedaction(pat); // P7: the PAT is key material too

    // Vault first: a stored relay secret works even while the Mgmt API is down.
    const row = await db.credential
      .findUnique({ where: { service_label: { service: RELAY_SECRET_SERVICE, label: RELAY_SECRET_LABEL } } })
      .catch(() => null);
    if (row) {
      try {
        const relaySecret = decryptSecret(row.cipher);
        if (relaySecret.length >= 8) {
          registerSecretForRedaction(relaySecret);
          return { ok: true, relaySecret, relayUrl: NEXUS_RELAY_URL, projectRef: NEXUS_RELAY_REF };
        }
      } catch {
        // Undecryptable vault row (rotation/tamper) → treat as missing and
        // re-provision below; the upsert overwrites it. Self-heal, no fake state.
      }
    }

    // Missing/undecryptable → provision under the in-module mutex.
    if (provisionInFlight) return provisionInFlight;
    provisionInFlight = (async (): Promise<RelayCredentials> => provisionRelaySecret(pat))();
    try {
      return await provisionInFlight;
    } finally {
      provisionInFlight = null;
    }
  })();

  relayCredsCache = { at: now, result };
  return result;
}

/**
 * Generate + write the relay secret to the harness project's EF secrets, then
 * store it encrypted in the vault (storeVyceKey's exact upsert pattern).
 * The plaintext is held in local scope only and registered for redaction.
 */
async function provisionRelaySecret(pat: string): Promise<RelayCredentials> {
  const relaySecret = randomBytes(32).toString("hex");

  // 1) Edge-Function side first — without it the vault row would be a dead key.
  let wrote = false;
  try {
    const res = await mgmtUpsertSecrets(pat, NEXUS_RELAY_REF, [
      { key: RELAY_SECRET_ENV_KEY, value: relaySecret },
    ]);
    wrote = res.ok;
  } catch {
    wrote = false; // client-side rate limit / cooldown — honest failure below
  }
  if (!wrote) {
    return {
      ok: false,
      reason: "relay secret could not be provisioned on the harness project (Mgmt write failed)",
    };
  }

  // 2) Vault side — same shape as storeVyceKey (encryptSecret + credential upsert).
  try {
    const { keyId, cipher } = encryptSecret(relaySecret);
    await db.credential.upsert({
      where: { service_label: { service: RELAY_SECRET_SERVICE, label: RELAY_SECRET_LABEL } },
      create: { service: RELAY_SECRET_SERVICE, label: RELAY_SECRET_LABEL, keyId, cipher },
      update: { keyId, cipher },
    });
  } catch {
    return {
      ok: false,
      reason: "relay secret was written to the harness project but could not be stored in the vault",
    };
  }

  registerSecretForRedaction(relaySecret);
  return { ok: true, relaySecret, relayUrl: NEXUS_RELAY_URL, projectRef: NEXUS_RELAY_REF };
}
