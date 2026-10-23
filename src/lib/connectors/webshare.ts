/**
 * NEXUS OS — Webshare proxy-pool connector client (T-206, wave-2).
 *
 * Talks to Webshare API v2 (https://proxy.webshare.io/api/v2). Probe-first facts:
 *
 * [MEASURED 2026-10-22, from this sandbox, unauthenticated probes with fake tokens]:
 * - GET /api/v2/proxy/list/ without credentials → HTTP 401 {"detail":"Authentication
 *   credentials were not provided."} — endpoint exists, auth required, egress HTTPS OK.
 * - Header `Authorization: Token <token>` → scheme is RECOGNIZED (fake token yields
 *   401 {"detail":"Invalid token."}).
 * - Header `Authorization: Bearer <token>` → scheme is IGNORED (same "credentials were
 *   not provided" as sending nothing). The owner file (apidocs) specifies
 *   `Authorization: Token <TOKEN>`; we therefore send the Token scheme, NOT Bearer.
 *
 * [INFERRED, from owner-supplied apidocs — cannot be probed without a real token]:
 * - Proxy list envelope: {count, next, previous, results:[…]}.
 * - Proxy object fields used here: id, proxy_address, port, username, country_code,
 *   valid (boolean). Mapped defensively — unknown shapes degrade to honest
 *   BAD_RESPONSE, never a fabricated success.
 *
 * P7 discipline: this module never logs — no token, no response bodies, no proxy
 * credentials. Proxy rows from list responses are OWNER DATA: they may be returned to
 * the UI layer only; the status route deliberately strips everything except
 * count/valid/country. The proxy password field is never extracted at all.
 */

export const WEBSHARE_API_BASE = "https://proxy.webshare.io/api/v2";

/** Proxy-list endpoints are rate-limited at 60 req/min per Webshare apidocs [INFERRED from owner file]. */
export const WEBSHARE_PROBE_TIMEOUT_MS = 10_000;

export type WebshareErrorCode =
  | "NETWORK_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "API_ERROR"
  | "BAD_RESPONSE";

/** Minimal, UI-safe projection of one pool entry (owner data — never log). */
export type WebshareProxy = {
  id: string;
  proxyAddress?: string;
  port?: number;
  username?: string;
  country?: string;
  valid?: boolean;
};

export type WebsharePoolPage = {
  ok: true;
  count: number | null;
  results: WebshareProxy[];
};

export type WebsharePoolFailure = {
  ok: false;
  httpStatus: number | null;
  code: WebshareErrorCode;
  message: string;
};

export type WebsharePoolResult = WebsharePoolPage | WebsharePoolFailure;

type RawProxyEnvelope = {
  count?: unknown;
  next?: unknown;
  previous?: unknown;
  results?: unknown;
};

function mapProxy(raw: unknown): WebshareProxy | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  // id is the only hard requirement; everything else degrades to undefined.
  if (r.id === undefined || r.id === null) return null;
  return {
    id: String(r.id),
    proxyAddress: typeof r.proxy_address === "string" ? r.proxy_address : undefined,
    port: typeof r.port === "number" ? r.port : undefined,
    username: typeof r.username === "string" ? r.username : undefined,
    country: typeof r.country_code === "string" ? r.country_code : undefined,
    valid: typeof r.valid === "boolean" ? r.valid : undefined,
  };
}

function failure(httpStatus: number | null, code: WebshareErrorCode, message: string): WebsharePoolFailure {
  // Static messages only — never forward upstream body text or the token (P7).
  return { ok: false, httpStatus, code, message };
}

/**
 * List the owner's proxies (page 1). `pageSize` default 10 per task contract.
 * Never throws — failures come back as typed, honest results.
 */
export async function listProxies(apiToken: string, pageSize = 10): Promise<WebsharePoolResult> {
  const url = `${WEBSHARE_API_BASE}/proxy/list/?page=1&page_size=${encodeURIComponent(
    String(pageSize),
  )}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        // [MEASURED]: the Token scheme is recognized; Bearer is ignored by this API.
        Authorization: `Token ${apiToken}`,
        Accept: "application/json",
        "User-Agent": "NEXUS-OS/0.1 (+panel connector T-206)",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(WEBSHARE_PROBE_TIMEOUT_MS),
    });
  } catch {
    return failure(null, "NETWORK_ERROR", "Webshare API unreachable from sandbox (network/timeout).");
  }

  if (res.status === 401) {
    return failure(401, "UNAUTHORIZED", "Webshare rejected the token (invalid or revoked).");
  }
  if (res.status === 403) {
    return failure(403, "FORBIDDEN", "Webshare refused access (suspended account or forbidden scope).");
  }
  if (res.status === 429) {
    return failure(429, "RATE_LIMITED", "Webshare rate limit hit (proxy-list endpoints: 60/min) — retry in ~60s.");
  }
  if (!res.ok) {
    return failure(res.status, "API_ERROR", `Webshare API returned HTTP ${res.status}.`);
  }

  let body: RawProxyEnvelope;
  try {
    body = (await res.json()) as RawProxyEnvelope;
  } catch {
    return failure(res.status, "BAD_RESPONSE", "Webshare API replied 2xx but with an undecodable body.");
  }

  if (!Array.isArray(body.results)) {
    return failure(res.status, "BAD_RESPONSE", "Webshare API response has no results array — shape may have changed.");
  }

  const results = body.results
    .map(mapProxy)
    .filter((p): p is WebshareProxy => p !== null);

  return {
    ok: true,
    count: typeof body.count === "number" ? body.count : null,
    results,
  };
}
