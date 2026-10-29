/**
 * NEXUS OS — Webshare proxy-pool connector client (T-206, wave-2; fixed in 12-a).
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
 * [MEASURED 2026-10-23 (task 12-a), real token from vault — ROOT CAUSE of the 400]:
 * - `mode` is now a REQUIRED query parameter on /proxy/list/. Omitting it →
 *   HTTP 400 {"mode":[{"message":"This field is required.","code":"required"}]} —
 *   exactly the validation shape documented in the owner apidocs. This is what the
 *   panel surfaced as "API_ERROR: Webshare API returned HTTP 400".
 * - `?mode=direct&page=1&page_size=100` → 200 with {count:30, results:30} — the full
 *   30-proxy pool fits in ONE page at page_size=100 (25 is the server default when
 *   page_size is omitted; 1000 was also accepted). Proxy rows carry:
 *   id, username, password, proxy_address, port, valid, last_verification,
 *   country_code, city_name, asn_name, asn_number, high_country_confidence, created_at.
 * - `mode=backbone` also returns 200 (different row set/order) — we ship `direct`,
 *   matching the owner's 30 direct authenticated proxies.
 *
 * [INFERRED from owner-supplied apidocs, consistent with measurement]:
 * - Envelope {count, next, previous, results:[…]} with full-URL `next` for pagination.
 * - 400 validation bodies map each invalid field to a list of {message, code} objects.
 *
 * P7 discipline: this module never logs — no token, no response bodies, no proxy
 * credentials. `WebshareProxy` rows are the UI-safe projection (no password).
 * `WebshareProxyCredential` / `extractProxyCredentials` carry the proxy password and
 * are SERVER-ONLY by contract: they must never be serialized to a client response,
 * a worklog, or any persisted store. The pool rows are OWNER DATA.
 */

export const WEBSHARE_API_BASE = "https://proxy.webshare.io/api/v2";

/**
 * [MEASURED] `mode` is required on /proxy/list/ — omitting it is an instant 400
 * ({"mode":[{"message":"This field is required.","code":"required"}]}).
 * The owner's 30 paid proxies are direct authenticated proxies → "direct".
 */
export const WEBSHARE_PROXY_LIST_MODE = "direct";

/** Proxy-list endpoints are rate-limited at 60 req/min per Webshare apidocs [INFERRED from owner file]. */
export const WEBSHARE_PROBE_TIMEOUT_MS = 10_000;

/** Pagination cap for listAllProxies: 10 pages × 100 = 1000 proxies, far above the 30-pool. */
export const WEBSHARE_MAX_POOL_PAGES = 10;

export type WebshareErrorCode =
  | "NETWORK_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "API_ERROR"
  | "BAD_RESPONSE";

/** Minimal, UI-safe projection of one pool entry (owner data — never log). No password. */
export type WebshareProxy = {
  id: string;
  proxyAddress?: string;
  port?: number;
  username?: string;
  country?: string;
  valid?: boolean;
};

/**
 * SERVER-ONLY pool row (adds the proxy password). Never return this from an API
 * route, never log it, never persist it — egress.ts uses it to build in-memory
 * proxy URLs only.
 */
export type WebshareProxyCredential = WebshareProxy & {
  password?: string;
};

export type WebsharePoolPage = {
  ok: true;
  count: number | null;
  results: WebshareProxy[];
};

export type WebsharePoolCredentialPage = {
  ok: true;
  count: number | null;
  results: WebshareProxyCredential[];
  /** Rows skipped because a connection credential (address/port/user/pass) was missing. */
  unusable: number;
};

export type WebsharePoolFailure = {
  ok: false;
  httpStatus: number | null;
  code: WebshareErrorCode;
  message: string;
};

export type WebsharePoolResult = WebsharePoolPage | WebsharePoolFailure;
export type WebsharePoolCredentialResult =
  | WebsharePoolCredentialPage
  | WebsharePoolFailure;

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

function mapProxyCredential(raw: unknown): WebshareProxyCredential | null {
  const base = mapProxy(raw);
  if (!base) return null;
  const r = raw as Record<string, unknown>;
  return {
    ...base,
    password: typeof r.password === "string" ? r.password : undefined,
  };
}

function failure(httpStatus: number | null, code: WebshareErrorCode, message: string): WebsharePoolFailure {
  // Static messages only — never forward upstream body text or the token (P7).
  return { ok: false, httpStatus, code, message };
}

function buildListUrl(page: number, pageSize: number): string {
  const qs = new URLSearchParams({
    mode: WEBSHARE_PROXY_LIST_MODE,
    page: String(page),
    page_size: String(pageSize),
  });
  return `${WEBSHARE_API_BASE}/proxy/list/?${qs.toString()}`;
}

async function fetchListPage<T>(
  apiToken: string,
  page: number,
  pageSize: number,
  mapRow: (raw: unknown) => T | null,
): Promise<{ ok: true; count: number | null; next: string | null; results: T[] } | WebsharePoolFailure> {
  let res: Response;
  try {
    res = await fetch(buildListUrl(page, pageSize), {
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
    // Includes 400: request-shape rejected upstream (e.g. a required query param).
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

  const results = body.results.map(mapRow).filter((p): p is T => p !== null);

  return {
    ok: true,
    count: typeof body.count === "number" ? body.count : null,
    next: typeof body.next === "string" && body.next.length > 0 ? body.next : null,
    results,
  };
}

/**
 * List one page of the owner's proxies (page 1 by default) — UI-safe rows only
 * (no password field). `pageSize` default 25 (the server default per apidocs).
 * Never throws — failures come back as typed, honest results.
 */
export async function listProxies(apiToken: string, pageSize = 25, page = 1): Promise<WebsharePoolResult> {
  const res = await fetchListPage(apiToken, page, pageSize, mapProxy);
  if (!res.ok) return res;
  return { ok: true, count: res.count, results: res.results };
}

/**
 * SERVER-ONLY: page through the FULL pool (password included on each row) for
 * egress use. page_size=100 — [MEASURED] the whole 30-proxy pool arrives in one
 * page. Follows the `next` envelope up to WEBSHARE_MAX_POOL_PAGES. Aborts
 * honestly on the first failed page — no partial-pool success.
 * The returned rows contain the proxy password: never serialize, log or store.
 */
export async function listAllProxies(apiToken: string): Promise<WebsharePoolCredentialResult> {
  const pageSize = 100;
  const all: WebshareProxyCredential[] = [];
  let unusable = 0;
  let count: number | null = null;
  let next: string | null = null;

  for (let page = 1; page <= WEBSHARE_MAX_POOL_PAGES; page++) {
    const res = await fetchListPage(apiToken, page, pageSize, mapProxyCredential);
    if (!res.ok) return res;

    count = res.count;
    next = res.next;
    for (const row of res.results) {
      // A row is only usable for egress when ALL connection fields exist.
      if (
        typeof row.proxyAddress === "string" &&
        typeof row.port === "number" &&
        typeof row.username === "string" &&
        typeof row.password === "string" &&
        row.proxyAddress.length > 0 &&
        row.username.length > 0
      ) {
        all.push(row);
      } else {
        unusable += 1;
      }
    }

    if (next === null) break; // envelope exhausted
  }

  return { ok: true, count, results: all, unusable };
}

/**
 * SERVER-ONLY extractor (task 12-a): turn pool rows into bare connection
 * credentials for the egress layer. Output contains proxy secrets — build
 * in-memory proxy URLs from it and drop it; never serialize to a client
 * response, never log, never persist.
 */
export function extractProxyCredentials(
  rows: WebshareProxyCredential[],
): { id: string; host: string; port: number; username: string; password: string; country: string | null; valid: boolean | null }[] {
  const out: { id: string; host: string; port: number; username: string; password: string; country: string | null; valid: boolean | null }[] = [];
  for (const r of rows) {
    if (
      typeof r.proxyAddress !== "string" ||
      typeof r.port !== "number" ||
      typeof r.username !== "string" ||
      typeof r.password !== "string" ||
      r.proxyAddress.length === 0 ||
      r.username.length === 0
    ) {
      continue;
    }
    out.push({
      id: r.id,
      host: r.proxyAddress,
      port: r.port,
      username: r.username,
      password: r.password,
      country: r.country ?? null,
      valid: r.valid ?? null,
    });
  }
  return out;
}
