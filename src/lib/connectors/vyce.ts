import { db } from "@/lib/db";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import { loadEgressPool, pickProxies, proxiedFetch } from "@/lib/egress";

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
 *
 * R18-a (Vyce truth): probeVyce is timeout- and egress-aware and classifies
 * Vyce-side outages honestly. Measured context [R18-0]: vyceai.com's origin
 * was DOWN (Cloudflare HTTP 522 direct at ~20s; the nexus-relay answered its
 * honest 502 UPSTREAM_UNREACHABLE at 15.1s) while the old 8s probe just said
 * "did not respond within 8s" — under-reporting a Vyce-side outage as a vague
 * transport error. New failure codes ORIGIN_DOWN + UPSTREAM_KEY_MISSING, an
 * optional route "proxy" (Webshare pool doctrine), a no-key origin-health
 * probe (probeVyceOriginHealth) and a failure sharpener
 * (sharpenVyceProbeWithOriginHealth) make the status surface tell that exact
 * story. P7 is unchanged: static strings + status + host only.
 */

export const VYCE_SERVICE = "vyce";
export const VYCE_KEY_LABEL = "api";
export const VYCE_BASEURL_LABEL = "base-url";

export const DEFAULT_VYCE_BASE_URL = "https://vyceai.com/v1";
export const VYCE_TIMEOUT_MS = 8_000;

/** R18-a: proxied probe budget per pool attempt (12s — a real chance for a
 *  proxied answer without stalling a status poll for minutes). */
export const VYCE_PROBE_TIMEOUT_PROXY_MS = 12_000;
/** R18-a: relay-branch probe budget — the nexus-relay waits up to 15s on its
 *  upstream before answering its honest 502 [MEASURED R18-0: 502 at 15.1s] —
 *  the panel must let that answer arrive instead of racing it with an 8s
 *  client timeout (the pre-R18-a under-reporting bug). */
export const VYCE_RELAY_PROBE_TIMEOUT_MS = 18_000;
/** R18-a: pool attempt count for a proxied probe — some pool nodes are dead
 *  [MEASURED R18-0: PROXY_CONNECT_REFUSED among the 30], so try up to 3. */
const VYCE_PROXY_ATTEMPTS = 3;

/** Role → model registry (R11 proposal; runtime /models list is the truth). */
export const VYCE_ROLE_MODELS = {
  router: "deepseek-v4-flash-lr",
  worker: "deepseek-v4-flash",
  frontier: "claude-sonnet-4-6",
  free: "glm-5.3-flash",
  batch: "gpt-6-luna",
  image: "grok-imagine-2",
} as const;

export type VyceRole = keyof typeof VYCE_ROLE_MODELS;
export const VYCE_ROLES = Object.keys(VYCE_ROLE_MODELS) as VyceRole[];

/** "available" | "missing" per role once connected; null while unknown. */
export type VyceTierState = "available" | "missing" | null;
export type VyceTierMap = Record<VyceRole, VyceTierState>;

export function emptyTierMap(): VyceTierMap {
  return { router: null, worker: null, frontier: null, free: null, batch: null, image: null };
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

/**
 * Paste hygiene shared with the brain client (task 16-a): trims, strips exactly
 * ONE matching wrapping quote pair (' " `) if present, then trims again. Used
 * on vault stores AND on Edge-Function secret reads so a quoted/wrapped paste
 * never reaches the Authorization header.
 */
export function sanitizeSecretText(value: string): string {
  let out = value.trim();
  if (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if (first === last && (first === '"' || first === "'" || first === "`")) {
      out = out.slice(1, -1).trim();
    }
  }
  return out;
}

export type VyceKeyLoad =
  | { ok: true; key: string; masked: string; keyId: string; updatedAt: string }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "unreadable" };

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
  const { keyId, cipher } = encryptSecret(sanitizeSecretText(key)); // no trailing newline/space ever stored
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
// Typed REST probe — GET {base}/models with Bearer key
// (R18-a: timeout-aware, egress-aware, honest ORIGIN_DOWN classification)
// ---------------------------------------------------------------------------

export type VyceFailureCode =
  | "NETWORK_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "BAD_RESPONSE"
  // R18-a: Cloudflare 521/522/523/524 — vyceai.com's own origin server is not
  // answering. A Vyce-side outage: never a key problem, never our egress.
  | "ORIGIN_DOWN"
  // R18-a: the nexus-relay answered 502 NO_UPSTREAM_KEY — the harness project
  // has no VYCE_API_KEY in its Edge-Function secrets (relay-side config gap).
  | "UPSTREAM_KEY_MISSING";

export type VyceProbe =
  | { ok: true; httpStatus: number; models: string[] }
  | { ok: false; code: VyceFailureCode; httpStatus: number | null; message: string };

/** The failure arm of VyceProbe (R18-a — consumed by the origin sharpener). */
export type VyceProbeFailure = Extract<VyceProbe, { ok: false }>;

/** R18-a probe options. Without opts the behavior is identical to the pre-R18-a
 *  probe: VYCE_TIMEOUT_MS (8s), plain direct fetch — existing call sites are
 *  unaffected. */
export type VyceProbeOpts = { timeoutMs?: number; route?: "direct" | "proxy" };

/** Origin aliveness verdict (R18-a) — additive status payload field. */
export type VyceOriginVerdict = "up" | "down" | "unknown";

/**
 * Extracts the nexus-relay's static JSON error code from a 5xx body — supports
 * both {"error":{"code":…}} (17-a shape) and {"code":…}. Only the short code
 * string is ever returned; body content never reaches a message (P7 — the
 * relay emits static strings only, discipline is belt-and-braces anyway).
 */
function relayErrorCode(bodyText: string): string | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    let candidate: unknown = o.code;
    if (typeof candidate !== "string" && o.error && typeof o.error === "object") {
      candidate = (o.error as Record<string, unknown>).code;
    }
    return typeof candidate === "string" && candidate.length > 0 && candidate.length <= 64 ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * GET /models — the cheapest authenticated read. Response bodies on failure are
 * truncated and scrubbed of the live key before inclusion in any message (P7).
 *
 * R18-a honesty rules:
 * - Cloudflare 521/522/523/524 → ORIGIN_DOWN (vyceai.com's origin is not
 *   answering — also when passed through the relay verbatim).
 * - 5xx from the nexus-relay (host *.supabase.co) with JSON body code
 *   "UPSTREAM_UNREACHABLE" → ORIGIN_DOWN (the relay could not reach vyceai.com
 *   within its 15s window either); code "NO_UPSTREAM_KEY" → UPSTREAM_KEY_MISSING
 *   (names the EF env var VYCE_API_KEY — static message, no values).
 * - route "proxy" follows the established pool doctrine (loadEgressPool →
 *   pickProxies(3) → proxiedFetch loop): transport/pool failures map to
 *   NETWORK_ERROR, NEVER UNAUTHORIZED — only an upstream-ANSWERED 401 is a key
 *   rejection. Pool-unavailable → NETWORK_ERROR (static message style).
 */
export async function probeVyce(apiKey: string, baseUrl: string, opts?: VyceProbeOpts): Promise<VyceProbe> {
  const timeoutMs = opts?.timeoutMs ?? VYCE_TIMEOUT_MS;
  const url = `${normalizeVyceBaseUrl(baseUrl)}/models`;
  const host = vyceProbeTarget(baseUrl);

  let answered: { status: number; bodyText: string } | null = null;

  if (opts?.route === "proxy") {
    // Established egress doctrine (17-b probeCustomProvider): pool → top picks →
    // per-proxy attempt; only an upstream HTTP answer counts as a probe result.
    const pool = await loadEgressPool();
    if (!pool.ok) {
      return {
        ok: false,
        code: "NETWORK_ERROR",
        httpStatus: null,
        message: `egress proxy pool unavailable for the ${host} probe (${pool.code}) — configure the Webshare connector or set egress.routing vyce back to direct`,
      };
    }
    const candidates = pickProxies(pool.pool, VYCE_PROXY_ATTEMPTS);
    let lastCode: string | null = null;
    for (const proxy of candidates) {
      const r = await proxiedFetch(
        url,
        { method: "GET", headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
        { proxy, timeoutMs },
      );
      if ("code" in r) {
        lastCode = r.code; // proxy/transport failure — try the next pool node
        continue;
      }
      answered = { status: r.status, bodyText: r.bodyText };
      break;
    }
    if (!answered) {
      return {
        ok: false,
        code: "NETWORK_ERROR",
        httpStatus: null,
        message: `${host} probe could not be completed through the egress proxy pool (${lastCode ?? "PROXY_FAILED"}) — proxy/transport failure, never a key error`,
      };
    }
  } else {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
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
          ? `Vyce did not respond within ${timeoutMs / 1000}s (probe target ${host})`
          : `network error reaching Vyce (${causeCode})`,
      };
    }
    answered = { status: res.status, bodyText: await res.text().catch(() => "") };
  }

  const scrub = (text: string): string => (text.includes(apiKey) ? "[filtered]" : text.slice(0, 200));
  const { status, bodyText } = answered;

  if (status === 401) {
    return { ok: false, code: "UNAUTHORIZED", httpStatus: 401, message: "Vyce rejected the key (HTTP 401 invalid_api_key)" };
  }
  if (status === 403) {
    return { ok: false, code: "FORBIDDEN", httpStatus: 403, message: "Vyce refused access (HTTP 403) — key lacks access or a WAF is in the way" };
  }
  if (status === 429) {
    return { ok: false, code: "RATE_LIMITED", httpStatus: 429, message: "Vyce rate-limited the probe (HTTP 429)" };
  }

  // Cloudflare's "origin not answering" family (R18-a). Through the nexus-relay
  // these are verbatim upstream pass-throughs (17-a contract: the relay itself
  // only ever answers 401/404/502), so a 52x from the relay host means Vyce's
  // origin is down just as directly as one from vyceai.com itself.
  if (status === 521 || status === 522 || status === 523 || status === 524) {
    const isVyceTarget = host === "vyceai.com" || host.endsWith(".supabase.co");
    return {
      ok: false,
      code: "ORIGIN_DOWN",
      httpStatus: status,
      message: isVyceTarget
        ? `vyceai.com's origin server is not answering (Cloudflare HTTP ${status}) — not a key problem, not our egress; the key cannot be verified until Vyce's origin returns`
        : `${host}'s origin server is not answering (Cloudflare HTTP ${status}) — the probe target's own origin is down; not a key problem, not our egress`,
    };
  }

  // Relay-side 5xx classification (R18-a): the nexus-relay answers its OWN 502s
  // with static JSON codes (17-a contract). Bodies contain static strings only;
  // the scrub/truncate discipline still applies (P7 belt-and-braces).
  if (host.endsWith(".supabase.co") && status >= 500) {
    const relayCode = relayErrorCode(bodyText);
    if (relayCode === "UPSTREAM_UNREACHABLE") {
      return {
        ok: false,
        code: "ORIGIN_DOWN",
        httpStatus: status,
        message: `the Supabase nexus-relay could not reach vyceai.com either (HTTP ${status} UPSTREAM_UNREACHABLE after its 15s upstream window) — Vyce's origin is down on their side; not a key problem, not our egress; the key cannot be verified until Vyce's origin returns`,
      };
    }
    if (relayCode === "NO_UPSTREAM_KEY") {
      return {
        ok: false,
        code: "UPSTREAM_KEY_MISSING",
        httpStatus: status,
        message: `the nexus-relay edge function has no VYCE_API_KEY in its Supabase Edge-Function secrets (HTTP ${status} NO_UPSTREAM_KEY) — set VYCE_API_KEY in the Supabase dashboard (harness project) or paste a Vyce key in the panel to use the direct vault path`,
      };
    }
  }

  if (status < 200 || status >= 300) {
    // HTML bodies (maintenance/error pages) never render as raw markup in the
    // reachability line — surface the page <title> instead [MEASURED: vyce.ai
    // serves a 503 "vyce.ai — Maintenance" page during outages].
    let htmlTitle: string | null = null;
    if (/^\s*<(?:!doctype|html)/i.test(bodyText)) {
      const m = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(bodyText);
      if (m) htmlTitle = m[1].trim();
    }
    return {
      ok: false,
      code: "BAD_RESPONSE",
      httpStatus: status,
      message: htmlTitle
        ? `Vyce answered HTTP ${status} — "${htmlTitle}" (HTML page, not an API response — likely maintenance or a proxy page on Vyce's side)`
        : `Vyce answered HTTP ${status}${bodyText ? `: ${scrub(bodyText)}` : ""}`,
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return { ok: false, code: "BAD_RESPONSE", httpStatus: status, message: "Vyce returned a non-JSON body for /models" };
  }

  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { data?: unknown }).data)
      ? ((data as { data: unknown[] }).data as unknown[])
      : null;
  if (!list) {
    return { ok: false, code: "BAD_RESPONSE", httpStatus: status, message: "Vyce /models payload shape unrecognized" };
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
// Origin-health probe (R18-a) — NO-KEY GET {base}/models
// ---------------------------------------------------------------------------

/** Direct window for the origin-health probe: Cloudflare's honest 522 for a
 *  down origin lands at ~20s from this sandbox [MEASURED R18-0] — an 8s window
 *  times out BEFORE the answer arrives and would force a dishonest verdict. */
export const VYCE_ORIGIN_HEALTH_TIMEOUT_MS = 25_000;
/** Pool-attempt window inside a proxied origin-health probe — deliberately
 *  shorter than the direct window: the direct fallback attempt provides the
 *  long-window evidence (a proxy attempt that only times out proves nothing). */
const VYCE_ORIGIN_HEALTH_PROXY_ATTEMPT_TIMEOUT_MS = 10_000;
const VYCE_ORIGIN_HEALTH_PROXY_ATTEMPTS = 2;

export type VyceOriginHealth = {
  verdict: VyceOriginVerdict;
  httpStatus: number | null;
  detail: string;
};

/**
 * Falsifiable origin-aliveness check (R18-a): a NO-KEY GET {base}/models.
 * vyceai.com answers the standard OpenAI 401 envelope when healthy
 * [MEASURED R11], so 401/403 — or any HTTP answer outside the CF 52x family —
 * proves the origin is ALIVE and a transport/5xx key-probe failure was NOT an
 * origin outage. NO Authorization header is ever sent on this probe, so it
 * cannot leak key material by construction.
 *
 * Verdict honesty rules:
 * - 521/522/523/524 → "down" (Cloudflare itself reports the origin missing).
 * - any other HTTP answer → "up" (the front door answered at the HTTP layer).
 * - no HTTP answer at all → "unknown" — in proxy mode that means every pool
 *   attempt failed at transport AND the direct fallback got nothing either;
 *   a transport failure is never over-claimed as an outage.
 */
export async function probeVyceOriginHealth(baseUrl: string, opts?: VyceProbeOpts): Promise<VyceOriginHealth> {
  const timeoutMs = opts?.timeoutMs ?? VYCE_ORIGIN_HEALTH_TIMEOUT_MS;
  const url = `${normalizeVyceBaseUrl(baseUrl)}/models`;
  const host = vyceProbeTarget(baseUrl);

  const classify = (status: number): VyceOriginHealth => {
    if (status === 521 || status === 522 || status === 523 || status === 524) {
      return {
        verdict: "down",
        httpStatus: status,
        detail: `vyceai.com's origin server is not answering — Cloudflare HTTP ${status} on a no-key GET /models (Vyce-side outage; no key was sent)`,
      };
    }
    if (status === 401 || status === 403) {
      return {
        verdict: "up",
        httpStatus: status,
        detail: `origin alive — ${host} answered HTTP ${status} on the no-key probe (front door healthy; no key material was sent)`,
      };
    }
    return {
      verdict: "up",
      httpStatus: status,
      detail: `origin alive — ${host} answered HTTP ${status} on the no-key probe (front door reachable; no key was sent)`,
    };
  };

  const directAttempt = async (): Promise<VyceOriginHealth | null> => {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" }, // NO Authorization — ever
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      return classify(res.status);
    } catch {
      return null; // timeout/transport — no HTTP answer, no verdict
    }
  };

  if (opts?.route === "proxy") {
    const pool = await loadEgressPool();
    if (pool.ok) {
      for (const proxy of pickProxies(pool.pool, VYCE_ORIGIN_HEALTH_PROXY_ATTEMPTS)) {
        const r = await proxiedFetch(
          url,
          { method: "GET", headers: { Accept: "application/json" } }, // NO Authorization — ever
          { proxy, timeoutMs: VYCE_ORIGIN_HEALTH_PROXY_ATTEMPT_TIMEOUT_MS },
        );
        if ("code" in r) continue; // proxy/transport failure — next node
        return classify(r.status);
      }
    }
    const direct = await directAttempt();
    if (direct) return direct;
    return {
      verdict: "unknown",
      httpStatus: null,
      detail: `could not classify the origin honestly — every egress-proxy attempt failed at transport and the direct no-key probe got no HTTP answer within ${Math.round(timeoutMs / 1000)}s (never over-claiming an outage)`,
    };
  }

  const direct = await directAttempt();
  return (
    direct ?? {
      verdict: "unknown",
      httpStatus: null,
      detail: `could not classify the origin honestly — the direct no-key probe got no HTTP answer within ${Math.round(timeoutMs / 1000)}s (a transport failure is not proof of an outage)`,
    }
  );
}

// ---------------------------------------------------------------------------
// Failure sharpener (R18-a) — a vague transport failure becomes an honest,
// falsifiable verdict via the no-key origin-health probe
// ---------------------------------------------------------------------------

const ORIGIN_SHARPENABLE_CODES: ReadonlySet<string> = new Set([
  "NETWORK_ERROR",
  "ORIGIN_DOWN",
  "UPSTREAM_KEY_MISSING",
]);

/**
 * Sharpens a FAILED key probe against vyceai.com with probeVyceOriginHealth
 * (run through the OPPOSITE egress route of the failed key probe — independent
 * evidence path):
 * - origin "up" → keep the measured transport error but note the origin is
 *   alive (the failure is on the probing/egress side — never called an outage).
 * - origin "down" → report ORIGIN_DOWN carrying the no-key measurement
 *   (independent evidence: no key was involved at all).
 * - origin "unknown" → keep the original error; verdict reported as-is.
 * Only sharpens when the probed host IS vyceai.com — a custom gateway base is
 * left untouched. Returns origin null when no sharpening applied.
 */
export async function sharpenVyceProbeWithOriginHealth(
  probe: VyceProbeFailure,
  baseUrl: string,
  probedRoute: "direct" | "proxy",
): Promise<{ probe: VyceProbeFailure; origin: VyceOriginVerdict | null }> {
  const host = vyceProbeTarget(baseUrl);
  if (host !== "vyceai.com" || !ORIGIN_SHARPENABLE_CODES.has(probe.code)) {
    return { probe, origin: null };
  }
  const health = await probeVyceOriginHealth(baseUrl, {
    timeoutMs: VYCE_ORIGIN_HEALTH_TIMEOUT_MS,
    route: probedRoute === "proxy" ? "direct" : "proxy",
  });
  if (health.verdict === "up") {
    return {
      probe: {
        ...probe,
        message: `${probe.message} · origin re-check just now: vyceai.com answered HTTP ${health.httpStatus} on a no-key probe — the origin is ALIVE, so this failure is on the probing/egress side, not a Vyce outage`,
      },
      origin: "up",
    };
  }
  if (health.verdict === "down") {
    return {
      probe: { ...probe, code: "ORIGIN_DOWN", message: health.detail },
      origin: "down",
    };
  }
  return { probe, origin: "unknown" };
}

// ---------------------------------------------------------------------------
// Probe cadence (R19-a) — shared schedule for status-surface probing
//
// Owner complaint: GET /api/vyce/status live-probed the relay (18s budget) on
// EVERY panel poll (~30s), each burning a 15s Vyce-origin attempt while Vyce
// sat in maintenance — exhaustion-style probing. Cadence rules:
//   SUCCESSFUL probe → cached 60s (a healthy verdict needs no re-measuring).
//   FAILED probe     → backoff 2min → 5min → 10min (cap). While in backoff the
//                      status surface serves the CACHED verdict with its
//                      ORIGINAL probedAt plus additive probeCache metadata, so
//                      the UI stays honest that this is a cached verdict, not a
//                      fresh probe. Half-open: once the backoff expires the
//                      next probe is live again (its outcome resets or advances
//                      the step).
// Used by src/app/api/vyce/status/route.ts (Vyce card) and getGroqSlotStatus in
// src/lib/ai/client.ts (Groq slot) — the CHAT paths use the circuit breaker in
// src/lib/ai/circuit.ts instead; the two mechanisms are deliberately separate
// (probe cadence protects status polls, the breaker protects chat calls).
// ---------------------------------------------------------------------------

/** A successful probe is served from cache for 60s. */
export const PROBE_SUCCESS_TTL_MS = 60_000;

/** Failed-probe backoff: 2min → 5min → 10min (cap). */
export const PROBE_FAILURE_BACKOFF_MS: readonly number[] = [120_000, 300_000, 600_000];

/** Backoff for a failure `step` (1-based; steps beyond the schedule cap out). */
export function probeBackoffMs(step: number): number {
  const s = Number.isFinite(step) ? Math.max(1, Math.floor(step)) : 1;
  return PROBE_FAILURE_BACKOFF_MS[Math.min(s - 1, PROBE_FAILURE_BACKOFF_MS.length - 1)];
}

/** Additive cache metadata carried by status payloads serving a cached verdict. */
export type ProbeCacheMeta = { cached: true; retryInMs: number; note: string };

/**
 * Honest note for a cached probe verdict — never claims freshness, never
 * over-claims the failure mode (ORIGIN_DOWN gets the down-origin wording;
 * other failures name their code).
 */
export function probeCacheNote(ok: boolean, errorCode: string | null, probedAtIso: string): string {
  if (ok) {
    return `measured up at ${probedAtIso} — serving the cached verdict (${PROBE_SUCCESS_TTL_MS / 1000}s TTL)`;
  }
  if (errorCode === "ORIGIN_DOWN") {
    return `origin measured down at ${probedAtIso} — live probing paused to avoid exhaustion`;
  }
  return `last probe failed (${errorCode ?? "unknown"}) at ${probedAtIso} — live probing paused to avoid exhaustion`;
}

// ---------------------------------------------------------------------------
// Status payload shared with the panel card
// ---------------------------------------------------------------------------

export type VyceStatusPayload = {
  configured: boolean; // vault key present
  connected: boolean; // live probe accepted the key
  keySource: "vault" | "supabase-edge-relay" | null;
  modelCount: number | null;
  tiers: VyceTierMap;
  maskedKey: string | null;
  probeTarget: string;
  probedAt: string | null;
  error: { code: string; message: string } | null;
  /** Supabase Edge-Function secret fallback state (owner stored VYCE_API_KEY there). */
  fallback: { available: boolean; reason: string | null; projectRef: string | null } | null;
  /** R18-a additive: measured vyceai.com origin aliveness — "down" comes from
   *  the relay's honest 502 UPSTREAM_UNREACHABLE or the no-key origin-health
   *  probe; "up"/"unknown" from the sharpener after a failed vault probe.
   *  null = not measured (success paths, UNAUTHORIZED, fallback-missing…). */
  origin: VyceOriginVerdict | null;
};
