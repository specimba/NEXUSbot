import { db } from "@/lib/db";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import {
  loadEgressPool,
  pickProxies,
  proxiedFetch,
  readRoutingMap,
  routeFor,
} from "@/lib/egress";

/**
 * NEXUS OS — Vyce connector (T-207): the brain's LLM gateway.
 *
 * Vyce is an OpenAI-compatible proxy at https://vyceai.com/v1 (R11 research:
 * unauthenticated GET /v1/models and POST /v1/chat/completions both answer the
 * exact OpenAI 401 envelope {"error":{"code":"invalid_api_key",...}} [MEASURED]).
 *
 * Vault layout (service "vyce"):
 *   label "api"       → Bearer API key (required)
 *   label "base-url"  → optional base URL override; default https://vyceai.com/v1
 *
 * P7 discipline: the key is decrypted transiently in-process for use/masking
 * only — never logged, never echoed, never embedded into an Error message.
 * Error detail bodies are additionally scrubbed against the live key before
 * they can leave this module (belt-and-braces against hostile echo).
 */

export const VYCE_SERVICE = "vyce";
export const VYCE_KEY_LABEL = "api";
export const VYCE_BASEURL_LABEL = "base-url";

export const DEFAULT_VYCE_BASE_URL = "https://vyceai.com/v1";
/**
 * Probe-only timeout (v29.18): the CORTEX race passes its own lane budgets —
 * this constant is exclusively the Connectors probe window. 8s reported false
 * UNREACHABLE while the platform was alive-but-slow (measured 13.92s once);
 * 15s covers the slow-but-alive class without hanging the panel for long.
 * When the upstream truly black-holes (2026-10-26 incident: TCP+TLS 11ms then
 * 0 bytes), an honest 15s timeout is the correct verdict anyway.
 */
export const VYCE_TIMEOUT_MS = 15_000;

/**
 * Role → model registry. Runtime /models list is the truth; this map mirrors
 * the live Vyce key's accessible models [MEASURED 2026-10-30: 10 ids —
 * agnes-3.0-flash, beam-1.0, claude-sonnet-4-6, deepseek-v4-flash,
 * deepseek-v4-flash-lr, deepseek-v4.1, glm-5.3-flash, gpt-6-luna,
 * grok-imagine-2, nemotron-3.5-super-vl]. The dashboard's 17-model directory
 * is the marketplace — glm-5.3 / gpt-5.6-terra / sol / gpt-astra / grok-4.6 /
 * deepseek-v4-pro / claude-sonnet-4-6-pro are NOT on this key; "deep" therefore
 * shows missing until the owner enables glm-5.3 on the Vyce key (honest signal,
 * intentional upgrade path). gpt-6-luna stays "batch" — degraded on the
 * platform dashboard but present on the key; glm-5.3-flash is flagged
 * unstable (26.4s platform latency, 2026-10-30) and v37.1 DEMOTED it to
 * banter backup — beam-1.0 (380ms) is the banter lead again; the cortex race
 * ladder fails over to glm-5.3 / deepseek-v4.1 on stalls.
 */
export const VYCE_ROLE_MODELS = {
  router: "deepseek-v4-flash-lr",
  worker: "deepseek-v4-flash",
  frontier: "claude-sonnet-4-6",
  free: "glm-5.3-flash",
  fast: "beam-1.0",
  vision: "nemotron-3.5-super-vl",
  deep: "glm-5.3",
  batch: "gpt-6-luna",
  image: "grok-imagine-2",
} as const;

export type VyceRole = keyof typeof VYCE_ROLE_MODELS;
export const VYCE_ROLES = Object.keys(VYCE_ROLE_MODELS) as VyceRole[];

/** "available" | "missing" per role once connected; null while unknown. */
export type VyceTierState = "available" | "missing" | null;
export type VyceTierMap = Record<VyceRole, VyceTierState>;

export function emptyTierMap(): VyceTierMap {
  return {
    router: null,
    worker: null,
    frontier: null,
    free: null,
    fast: null,
    vision: null,
    deep: null,
    batch: null,
    image: null,
  };
}

/** Computes per-role availability from a live /models id list. */
export function computeTierAvailability(models: string[]): VyceTierMap {
  const ids = new Set(models);
  const map = emptyTierMap();
  for (const role of VYCE_ROLES) {
    map[role] = ids.has(VYCE_ROLE_MODELS[role]) ? "available" : "missing";
  }
  return map;
}

// ---------------------------------------------------------------------------
// Base URL handling (host is safe to display — it is config, not a secret)
// ---------------------------------------------------------------------------

export function isValidVyceBaseUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 512) return false;
  try {
    const u = new URL(trimmed);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function normalizeVyceBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** Public host of the probe target (safe for the panel). */
export function vyceProbeTarget(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

// ---------------------------------------------------------------------------
// Vault access (service "vyce", labels "api" + "base-url")
// ---------------------------------------------------------------------------

export type VyceKeyLoad =
  | { ok: true; key: string; masked: string; keyId: string; updatedAt: string; fingerprint: boolean }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "unreadable" };

/**
 * A SHA-256 hex fingerprint is exactly 64 hex chars. The owner's live issue:
 * a hash-shaped value got stored as "the key" (vault or Supabase secret) —
 * it can NEVER authenticate (Vyce answers 401 invalid_api_key). Every layer
 * that resolves a Vyce key must skip + flag fingerprint-shaped values.
 */
export function looksLikeVyceFingerprint(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value.trim());
}

export async function loadVyceKey(): Promise<VyceKeyLoad> {
  const row = await db.credential.findUnique({
    where: { service_label: { service: VYCE_SERVICE, label: VYCE_KEY_LABEL } },
  });
  if (!row) return { ok: false, reason: "missing" };
  try {
    const key = decryptSecret(row.cipher);
    return {
      ok: true,
      key,
      masked: maskSecret(key),
      keyId: row.keyId,
      updatedAt: row.updatedAt.toISOString(),
      fingerprint: looksLikeVyceFingerprint(key),
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

/** Optional base-url override from the vault; null when unset/unreadable. */
export async function loadVyceBaseUrlOverride(): Promise<string | null> {
  const row = await db.credential.findUnique({
    where: { service_label: { service: VYCE_SERVICE, label: VYCE_BASEURL_LABEL } },
  });
  if (!row) return null;
  try {
    const raw = decryptSecret(row.cipher);
    return isValidVyceBaseUrl(raw) ? normalizeVyceBaseUrl(raw) : null;
  } catch {
    return null;
  }
}

/** Effective base URL: vault override → default. (client.ts adds more fallbacks) */
export async function resolveVyceBaseUrl(): Promise<string> {
  const override = await loadVyceBaseUrlOverride();
  return override ?? DEFAULT_VYCE_BASE_URL;
}

export async function storeVyceKey(key: string): Promise<{ keyId: string }> {
  const { keyId, cipher } = encryptSecret(key);
  await db.credential.upsert({
    where: { service_label: { service: VYCE_SERVICE, label: VYCE_KEY_LABEL } },
    create: { service: VYCE_SERVICE, label: VYCE_KEY_LABEL, keyId, cipher },
    update: { keyId, cipher },
  });
  return { keyId };
}

export async function storeVyceBaseUrl(url: string): Promise<void> {
  const { keyId, cipher } = encryptSecret(normalizeVyceBaseUrl(url));
  await db.credential.upsert({
    where: { service_label: { service: VYCE_SERVICE, label: VYCE_BASEURL_LABEL } },
    create: { service: VYCE_SERVICE, label: VYCE_BASEURL_LABEL, keyId, cipher },
    update: { keyId, cipher },
  });
}

export async function clearVyceBaseUrlOverride(): Promise<void> {
  await db.credential.deleteMany({
    where: { service: VYCE_SERVICE, label: VYCE_BASEURL_LABEL },
  });
}

/** Removes the whole Vyce vault config (key + base-url override). Idempotent. */
export async function deleteVyceConfig(): Promise<number> {
  const res = await db.credential.deleteMany({ where: { service: VYCE_SERVICE } });
  return res.count;
}

export function maskVyceKey(key: string): string {
  return maskSecret(key);
}

/** Shape check only — the live probe decides liveness honestly. */
export function isPlausibleVyceKey(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 8 && value.trim().length <= 4096;
}

// ---------------------------------------------------------------------------
// Typed REST probe — GET {base}/models with Bearer key, 8s timeout
// ---------------------------------------------------------------------------

export type VyceFailureCode = "NETWORK_ERROR" | "UNAUTHORIZED" | "FORBIDDEN" | "RATE_LIMITED" | "BAD_RESPONSE";

export type VyceProbe =
  | { ok: true; httpStatus: number; models: string[] }
  | { ok: false; code: VyceFailureCode; httpStatus: number | null; message: string };

/**
 * GET /models — the cheapest authenticated read. Response bodies on failure are
 * truncated and scrubbed of the live key before inclusion in any message (P7).
 */
export async function probeVyce(apiKey: string, baseUrl: string): Promise<VyceProbe> {
  const url = `${normalizeVyceBaseUrl(baseUrl)}/models`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(VYCE_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const causeCode =
      err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string"
        ? (err as { code: string }).code
        : "unknown";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return {
      ok: false,
      code: "NETWORK_ERROR",
      httpStatus: null,
      message: timedOut
        ? `Vyce did not respond within ${VYCE_TIMEOUT_MS / 1000}s (probe target ${vyceProbeTarget(baseUrl)})`
        : `network error reaching Vyce (${causeCode})`,
    };
  }

  const text = await res.text().catch(() => "");
  return classifyVyceAnswer(res.status, text, apiKey, baseUrl, "direct");
}

/**
 * Shared HTTP-answer classification for both transports — identical verdicts
 * whether the answer arrived direct or through the egress proxy (honesty:
 * a 401 through a working proxy IS a key rejection; a proxy transport failure
 * is NEVER a key problem).
 */
function classifyVyceAnswer(
  status: number,
  text: string,
  apiKey: string,
  baseUrl: string,
  via: "direct" | "proxy",
): VyceProbe {
  const viaPart = via === "proxy" ? " (via the egress proxy)" : "";
  if (status === 401) {
    return { ok: false, code: "UNAUTHORIZED", httpStatus: 401, message: `Vyce rejected the key (HTTP 401 invalid_api_key)${viaPart}` };
  }
  if (status === 403) {
    return { ok: false, code: "FORBIDDEN", httpStatus: 403, message: `Vyce refused access (HTTP 403)${viaPart} — key lacks access or a WAF is in the way` };
  }
  if (status === 429) {
    return { ok: false, code: "RATE_LIMITED", httpStatus: 429, message: `Vyce rate-limited the probe (HTTP 429)${viaPart}` };
  }

  const scrub = (t: string): string => (t.includes(apiKey) ? "[filtered]" : t.slice(0, 200));

  if (status < 200 || status >= 300) {
    return {
      ok: false,
      code: "BAD_RESPONSE",
      httpStatus: status,
      message: `Vyce answered HTTP ${status}${viaPart}${text ? `: ${scrub(text)}` : ""}`,
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, code: "BAD_RESPONSE", httpStatus: status, message: `Vyce returned a non-JSON body for /models${viaPart}` };
  }

  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { data?: unknown }).data)
      ? ((data as { data: unknown[] }).data as unknown[])
      : null;
  if (!list) {
    return { ok: false, code: "BAD_RESPONSE", httpStatus: status, message: `Vyce /models payload shape unrecognized${viaPart}` };
  }

  const models = list
    .map((m) => {
      const o = (m ?? {}) as Record<string, unknown>;
      return typeof o.id === "string" ? o.id : null;
    })
    .filter((id): id is string => id !== null);

  return { ok: true, httpStatus: status, models };
}

// ---------------------------------------------------------------------------
// Egress-routed probe (2026-10-26 incident: the card said UNREACHABLE while the
// runtime — routed through the owner's proxy pool — was answering 200)
// ---------------------------------------------------------------------------

export type VyceRoutedProbe = VyceProbe & { route: "direct" | "proxy"; routeNote: string | null };

/**
 * Probe Vyce through the SAME transport the runtime brain calls use:
 * Settings KV "egress.routing" → routeFor("vyce", map). direct → the plain
 * probe; proxy → the Webshare pool with a SHARED wall-clock budget (up to 2
 * pool proxies), exactly like the brain's own proxied calls. The payload
 * reports which route answered so the panel can never again show a direct
 * verdict about a proxied runtime.
 */
export async function probeVyceRouted(apiKey: string, baseUrl: string): Promise<VyceRoutedProbe> {
  let route: "direct" | "proxy" = "direct";
  try {
    route = routeFor("vyce", await readRoutingMap());
  } catch {
    route = "direct"; // a routing read failure must never break the probe
  }

  if (route === "direct") {
    const r = await probeVyce(apiKey, baseUrl);
    return { ...r, route: "direct", routeNote: null };
  }

  const url = `${normalizeVyceBaseUrl(baseUrl)}/models`;
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };

  const pool = await loadEgressPool();
  if (!pool.ok) {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      httpStatus: null,
      route: "proxy",
      routeNote: pool.code,
      message: `The egress proxy pool is unavailable (${pool.code}) while Egress routing sends Vyce through the pool — fix the Webshare pool or set the Vyce route back to direct.`,
    };
  }

  // Shared budget across pool attempts (never a fresh full slice per proxy).
  const poolStarted = Date.now();
  let lastCode: string | null = null;
  for (const proxy of pickProxies(pool.pool, 2)) {
    const remaining = VYCE_TIMEOUT_MS - (Date.now() - poolStarted);
    if (remaining < 1_500 && lastCode) break;
    const r = await proxiedFetch(url, { headers }, { proxy, timeoutMs: Math.max(1_500, remaining) });
    if ("code" in r) {
      lastCode = r.code; // proxy/transport failure — try the next pool proxy
      continue;
    }
    // An HTTP answer through a working proxy — classify identically to direct.
    return { ...classifyVyceAnswer(r.status, r.bodyText, apiKey, baseUrl, "proxy"), route: "proxy", routeNote: null };
  }

  return {
    ok: false,
    code: "NETWORK_ERROR",
    httpStatus: null,
    route: "proxy",
    routeNote: lastCode ?? "PROXY_FAILED",
    message: `Vyce did not answer through the egress proxy (${lastCode ?? "PROXY_FAILED"}) within ${VYCE_TIMEOUT_MS / 1000}s — a transport failure, never a key problem.`,
  };
}

// ---------------------------------------------------------------------------
// Status payload shared with the panel card
// ---------------------------------------------------------------------------

export type VyceStatusPayload = {
  configured: boolean; // vault key present
  connected: boolean; // live probe accepted the key
  keySource: "vault" | "supabase-edge-secret" | null;
  modelCount: number | null;
  tiers: VyceTierMap;
  maskedKey: string | null;
  probeTarget: string;
  probedAt: string | null;
  /** Which transport the probe used — MUST match the runtime brain's route. */
  route: "direct" | "proxy" | null;
  error: { code: string; message: string } | null;
  /** Supabase Edge-Function secret fallback state (owner stored VYCE_API_KEY there). */
  fallback: { available: boolean; reason: string | null } | null;
  /**
   * Owner's live issue: the stored vault value is a SHA-256 fingerprint
   * (64 hex) — it can never authenticate, so it was SKIPPED and the fallback
   * was probed instead. This field carries the human explanation.
   */
  vaultIgnored?: string | null;
};
