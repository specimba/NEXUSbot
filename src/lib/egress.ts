/**
 * NEXUS OS — general egress-proxy layer (task 12-a).
 *
 * Purpose: route outbound HTTP to specific upstreams through the owner's paid
 * Webshare proxy pool (30 authenticated DIRECT proxies) instead of the sandbox
 * egress IP. Motivation [MEASURED]: some upstreams (api.groq.com) WAF-block the
 * sandbox egress IP with 403 while accepting the same request path from a pool
 * proxy (401 = key-level answer ⇒ WAF bypassed). Vyce and most others are
 * direct-OK. This module is the general capability — per-upstream decisions live
 * in the `egress.routing` Settings KV, default DIRECT.
 *
 * Transport strategy (resolved once per process, in this order):
 *   1. undici ProxyAgent as fetch dispatcher (only if the `undici` package is
 *      importable at runtime — it is NOT bundled in this project today).
 *   2. Bun-native fetch `proxy` option (only under the Bun runtime) [MEASURED].
 *   3. Hand-rolled HTTP CONNECT tunnel + raw HTTP/1.1 over node:net/node:tls —
 *      dependency-free, works under the Node runtime that runs next-server
 *      [MEASURED 2026-10-23: groq via pool proxy → 401 invalid_api_key while
 *      direct → 403 WAF].
 * If none can be used, callers get a typed PROXY_TRANSPORT_UNAVAILABLE failure —
 * never a fake success.
 *
 * P7 discipline: proxy URLs (http://user:pass@host:port) exist ONLY in process
 * memory for the lifetime of a request (pool cache ≤60 s). They are never logged,
 * never serialized into API responses, never written to disk. Pool rows contain
 * owner credentials — only counts/booleans/country codes may leave the process.
 * Classification rule: a WAF/unreachable upstream is never reported as KEY
 * REJECTED (401 means the upstream itself answered and rejected auth).
 */

import net from "node:net";
import tls from "node:tls";
import { db } from "@/lib/db";
import { decryptSecret, VaultIntegrityError } from "@/lib/crypto";
import {
  extractProxyCredentials,
  listAllProxies,
  type WebshareErrorCode,
} from "@/lib/connectors/webshare";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EgressTransportName = "undici" | "bun" | "tunnel";

/** One pool proxy, reduced to its in-memory connection URL. SERVER-ONLY. */
export type EgressProxy = {
  id: string;
  /** http://user:pass@host:port — in-memory only (P7): never log/serialize/store. */
  url: string;
  port: number;
  country: string | null;
  valid: boolean | null;
};

export type EgressMode = "direct" | "proxy";

export type EgressErrorCode =
  | "NOT_CONFIGURED"
  | "VAULT_UNREADABLE"
  | "PROXY_TRANSPORT_UNAVAILABLE"
  | "PROXY_CONNECT_REFUSED"
  | "PROXY_AUTH_REJECTED"
  | "PROXY_TIMEOUT"
  | "TUNNEL_TLS_FAILED"
  | "UPSTREAM_BAD_RESPONSE"
  | "UPSTREAM_TIMEOUT"
  | WebshareErrorCode;

export type EgressHttpResponse = {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  via: "direct" | EgressTransportName;
};

export type EgressHttpFailure = {
  code: EgressErrorCode;
  message: string;
  via: "direct" | EgressTransportName | null;
  /** Status the PROXY itself returned on CONNECT (when applicable), not the upstream. */
  proxyStatus?: number;
};

export type EgressClassification =
  | "OK"
  | "KEY_REJECTED"
  | "UNREACHABLE_WAF"
  | "UNREACHABLE_FROM_SANDBOX"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "NOT_FOUND"
  | "HTTP_OTHER"
  | "PROXY_FAILED"
  | "PROXY_POOL_FAILED";

export const EGRESS_ROUTING_KEY = "egress.routing";

/** Probe targets (task contract whitelist). `kind:"country"` parses Cloudflare trace loc= ONLY. */
export const EGRESS_PROBE_TARGETS = {
  groq: { url: "https://api.groq.com/openai/v1/models", kind: "status" as const },
  vyce: { url: "https://vyceai.com/v1/models", kind: "status" as const },
  "generic-echo": { url: "https://www.cloudflare.com/cdn-cgi/trace", kind: "country" as const },
} as const;

export type EgressProbeTarget = keyof typeof EGRESS_PROBE_TARGETS;

/** Body cap for tunnel reads — probes only ever need statuses / tiny bodies. */
const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Transport resolution
// ---------------------------------------------------------------------------

let transportPromise: Promise<EgressTransportName | null> | null = null;

async function detectTransport(): Promise<EgressTransportName | null> {
  // 1. undici package (Node runtimes that ship it as a dependency would use it).
  //    The specifier is built at runtime on purpose: TS must not resolve it
  //    (the package is optional and NOT installed in this project) and the
  //    bundler must not try to bundle it.
  try {
    const undiciSpecifier = ["un", "dici"].join("");
    const mod = (await import(undiciSpecifier)) as unknown as { ProxyAgent?: unknown };
    if (typeof mod.ProxyAgent === "function") return "undici";
  } catch {
    // not installed — expected on this project; fall through
  }
  // 2. Bun-native fetch with `proxy` option [MEASURED working against the pool].
  const bunGlobal = (globalThis as { Bun?: { fetch?: unknown } }).Bun;
  if (bunGlobal && typeof bunGlobal.fetch === "function") return "bun";
  // 3. node:net/node:tls CONNECT tunnel (always available under Node).
  if (typeof net.connect === "function" && typeof tls.connect === "function") return "tunnel";
  return null;
}

function resolveTransport(): Promise<EgressTransportName | null> {
  if (!transportPromise) transportPromise = detectTransport();
  return transportPromise;
}

// ---------------------------------------------------------------------------
// CONNECT tunnel + raw HTTP/1.1 (the transport that actually runs here)
// ---------------------------------------------------------------------------

function parseChunkedBody(raw: string): string {
  // Minimal chunked decoder: hex size lines + data; stops at 0-chunk. Best-effort.
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const lineEnd = raw.indexOf("\r\n", i);
    if (lineEnd === -1) break;
    const size = parseInt(raw.slice(i, lineEnd).split(";")[0].trim(), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    out += raw.slice(lineEnd + 2, lineEnd + 2 + size);
    i = lineEnd + 2 + size + 2; // skip data + CRLF
  }
  return out;
}

function connectThroughProxy(
  proxy: EgressProxy,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<net.Socket> {
  const parsed = new URL(proxy.url); // in-memory only; never logged (P7)
  const username = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);

  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: parsed.hostname, port: parsed.port || 80 });
    socket.setNoDelay(true);
    let buf = "";
    let settled = false;
    const auth = Buffer.from(`${username}:${password}`).toString("base64");

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
      socket.off("data", onData);
      fn();
    };
    const onError = (e: Error) => finish(() => { socket.destroy(); reject(e); });
    const onTimeout = () => finish(() => {
      socket.destroy();
      reject(Object.assign(new Error("proxy connect timed out"), { egressCode: "PROXY_TIMEOUT" as EgressErrorCode }));
    });
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      const statusLine = buf.slice(0, buf.indexOf("\r\n"));
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
      const code = m ? Number(m[1]) : 0;
      if (!m) {
        finish(() => {
          socket.destroy();
          reject(Object.assign(new Error("unparseable proxy CONNECT response"), { egressCode: "UPSTREAM_BAD_RESPONSE" as EgressErrorCode }));
        });
        return;
      }
      if (code === 407) {
        finish(() => {
          socket.destroy();
          reject(Object.assign(new Error("proxy rejected credentials (CONNECT 407)"), { egressCode: "PROXY_AUTH_REJECTED" as EgressErrorCode, proxyStatus: code }));
        });
        return;
      }
      if (code !== 200) {
        finish(() => {
          socket.destroy();
          reject(Object.assign(new Error(`proxy refused CONNECT (status ${code})`), { egressCode: "PROXY_CONNECT_REFUSED" as EgressErrorCode, proxyStatus: code }));
        });
        return;
      }
      finish(() => resolve(socket));
    };

    socket.on("error", onError);
    socket.on("timeout", onTimeout);
    socket.on("data", onData);
    socket.on("connect", () => {
      socket.setTimeout(timeoutMs);
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${targetHost}:${targetPort}\r\n` +
          `Proxy-Authorization: Basic ${auth}\r\n\r\n`,
      );
    });
  });
}

type RawResponse = { status: number; headers: Record<string, string>; bodyText: string };

function sendRawOverSocket(socket: net.Socket, target: URL, init: EgressFetchInit, timeoutMs: number): Promise<RawResponse> {
  const body = typeof init.body === "string" ? init.body : "";
  const headers: Record<string, string> = {
    Host: target.host,
    Accept: "*/*",
    "User-Agent": "NEXUS-OS/0.1 (+egress layer 12-a)",
    Connection: "close",
    ...(init.headers ?? {}),
  };
  if (body.length > 0 && !Object.keys(headers).some((h) => h.toLowerCase() === "content-length")) {
    headers["Content-Length"] = String(Buffer.byteLength(body, "utf8"));
  }

  const head =
    `${(init.method ?? "GET").toUpperCase()} ${target.pathname}${target.search} HTTP/1.1\r\n` +
    Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n") +
    "\r\n\r\n";

  return new Promise((resolve, reject) => {
    let raw = "";
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      socket.setTimeout(0);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
      fn();
    };
    const onError = (e: Error) => finish(() => {
      socket.destroy();
      reject(Object.assign(new Error("tunnel read failed"), { cause: e.message, egressCode: "UPSTREAM_BAD_RESPONSE" as EgressErrorCode }));
    });
    const onTimeout = () => finish(() => {
      socket.destroy();
      reject(Object.assign(new Error("upstream timed out over tunnel"), { egressCode: "UPSTREAM_TIMEOUT" as EgressErrorCode }));
    });
    const onData = (chunk: Buffer) => {
      raw += chunk.toString("latin1");
      if (raw.length > MAX_BODY_BYTES) finish(() => {
        socket.destroy();
        reject(Object.assign(new Error("upstream response exceeded body cap"), { egressCode: "UPSTREAM_BAD_RESPONSE" as EgressErrorCode }));
      });
    };

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("timeout", onTimeout);
    socket.once("close", () => {
      finish(() => {
        const sep = raw.indexOf("\r\n\r\n");
        if (sep === -1) {
          reject(Object.assign(new Error("no HTTP response received over tunnel"), { egressCode: "UPSTREAM_BAD_RESPONSE" as EgressErrorCode }));
          return;
        }
        const headBlock = raw.slice(0, sep);
        const lines = headBlock.split("\r\n");
        const status = Number((/^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? "") ?? [])[1] ?? 0);
        if (!status) {
          reject(Object.assign(new Error("unparseable upstream status line"), { egressCode: "UPSTREAM_BAD_RESPONSE" as EgressErrorCode }));
          return;
        }
        const headers: Record<string, string> = {};
        for (const line of lines.slice(1)) {
          const c = line.indexOf(":");
          if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
        }
        let bodyText = raw.slice(sep + 4);
        if ((headers["transfer-encoding"] ?? "").includes("chunked")) bodyText = parseChunkedBody(bodyText);
        resolve({ status, headers, bodyText });
      });
    });

    socket.setTimeout(timeoutMs);
    socket.write(head + body);
  });
}

async function tunnelFetch(
  proxy: EgressProxy,
  target: URL,
  init: EgressFetchInit,
  timeoutMs: number,
): Promise<EgressHttpResponse> {
  const isTls = target.protocol === "https:";
  const port = Number(target.port) || (isTls ? 443 : 80);
  const socket = await connectThroughProxy(proxy, target.hostname, port, timeoutMs);

  try {
    if (!isTls) {
      // Plain-HTTP target: the tunnel already ends at the target — send raw HTTP.
      const r = await sendRawOverSocket(socket, target, init, timeoutMs);
      return { ...r, via: "tunnel" };
    }

    return await new Promise<EgressHttpResponse>((resolve, reject) => {
      const tlsSocket = tls.connect({
        socket,
        servername: target.hostname,
        rejectUnauthorized: true,
        ALPNProtocols: ["http/1.1"],
      });
      const tlsFail = (e: Error) => {
        socket.destroy();
        tlsSocket.destroy();
        reject(Object.assign(new Error("TLS through tunnel failed"), { cause: e.message, egressCode: "TUNNEL_TLS_FAILED" as EgressErrorCode }));
      };
      tlsSocket.once("error", tlsFail);
      tlsSocket.once("secureConnect", () => {
        tlsSocket.off("error", tlsFail);
        sendRawOverSocket(tlsSocket, target, init, timeoutMs)
          .then((r) => {
            tlsSocket.destroy();
            socket.destroy();
            resolve({ ...r, via: "tunnel" });
          })
          .catch((e: Error & { egressCode?: EgressErrorCode }) => {
            tlsSocket.destroy();
            socket.destroy();
            reject(Object.assign(e, { egressCode: e.egressCode ?? "UPSTREAM_BAD_RESPONSE" }));
          });
      });
    });
  } catch (e) {
    socket.destroy();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// undici + bun transports
// ---------------------------------------------------------------------------

const undiciAgents = new Map<string, unknown>();

async function undiciFetch(proxy: EgressProxy, target: URL, init: EgressFetchInit, timeoutMs: number): Promise<EgressHttpResponse> {
  const undiciSpecifier = ["un", "dici"].join("");
  const mod = (await import(undiciSpecifier)) as unknown as {
    ProxyAgent: new (uri: string) => unknown;
  };
  let agent = undiciAgents.get(proxy.id) as object | undefined;
  if (!agent) {
    agent = new mod.ProxyAgent(proxy.url) as object;
    if (undiciAgents.size >= 32) undiciAgents.clear();
    undiciAgents.set(proxy.id, agent);
  }
  const initExt = {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher: agent,
  } as RequestInit & { dispatcher?: unknown };
  const res = await fetch(target, initExt);
  const bodyText = (await res.text()).slice(0, MAX_BODY_BYTES);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  return { status: res.status, headers, bodyText, via: "undici" };
}

function bunFetch(proxy: EgressProxy, target: URL, init: EgressFetchInit, timeoutMs: number): Promise<EgressHttpResponse | EgressHttpFailure> {
  const bfetch = (globalThis as { Bun?: { fetch?: (u: URL, i: Record<string, unknown>) => Promise<Response> } }).Bun?.fetch;
  if (typeof bfetch !== "function") {
    return Promise.resolve({
      code: "PROXY_TRANSPORT_UNAVAILABLE",
      message: "bun runtime not present — cannot use native proxy fetch.",
      via: null,
    });
  }
  return bfetch(target, {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
    proxy: proxy.url,
    signal: AbortSignal.timeout(timeoutMs),
  }).then(async (res) => {
    const bodyText = (await res.text()).slice(0, MAX_BODY_BYTES);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return { status: res.status, headers, bodyText, via: "bun" as const };
  });
}

// ---------------------------------------------------------------------------
// Public fetch surface
// ---------------------------------------------------------------------------

export type EgressFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

/** Direct (sandbox egress) fetch with the same envelope as proxiedFetch. */
export async function directFetch(target: string, init: EgressFetchInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<EgressHttpResponse | EgressHttpFailure> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { code: "UPSTREAM_BAD_RESPONSE", message: "probe target URL is invalid", via: null };
  }
  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const bodyText = (await res.text()).slice(0, MAX_BODY_BYTES);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return { status: res.status, headers, bodyText, via: "direct" };
  } catch {
    return {
      code: "UNREACHABLE_FROM_SANDBOX",
      message: "target did not answer from the sandbox egress (network/WAF drop) — this is never a key problem.",
      via: "direct",
    };
  }
}

/**
 * Route one request through a chosen pool proxy. Tries the resolved transport;
 * typed failures when the proxy itself cannot be used. Upstream statuses pass
 * through untouched (honesty — we never convert HTTP answers into transport
 * failures).
 */
export async function proxiedFetch(
  target: string,
  init: EgressFetchInit,
  opts: { proxy: EgressProxy; timeoutMs?: number },
): Promise<EgressHttpResponse | EgressHttpFailure> {
  const transport = await resolveTransport();
  if (!transport) {
    return {
      code: "PROXY_TRANSPORT_UNAVAILABLE",
      message: "no usable proxy transport in this runtime (undici/bun/tunnel all unavailable).",
      via: null,
    };
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { code: "UPSTREAM_BAD_RESPONSE", message: "probe target URL is invalid", via: null };
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    if (transport === "undici") return await undiciFetch(opts.proxy, url, init, timeoutMs);
    if (transport === "bun") return await bunFetch(opts.proxy, url, init, timeoutMs);
    return await tunnelFetch(opts.proxy, url, init, timeoutMs);
  } catch (e) {
    const err = e as Error & { egressCode?: EgressErrorCode; proxyStatus?: number; cause?: string };
    const code: EgressErrorCode = err.egressCode ?? "PROXY_CONNECT_REFUSED";
    return {
      code,
      message:
        code === "PROXY_TIMEOUT"
          ? "pool proxy did not complete CONNECT in time."
          : code === "PROXY_AUTH_REJECTED"
            ? "pool proxy rejected the credentials (CONNECT 407)."
            : code === "TUNNEL_TLS_FAILED"
              ? "TLS handshake to the target through the tunnel failed."
              : "pool proxy could not establish the tunnel.",
      via: "tunnel",
      proxyStatus: err.proxyStatus,
    };
  }
}

// ---------------------------------------------------------------------------
// Pool loading (vault → webshare connector → in-memory URLs)
// ---------------------------------------------------------------------------

type PoolCache = {
  pool: EgressProxy[];
  count: number | null;
  unusable: number;
  loadedAt: number;
};

let poolCache: PoolCache | null = null;
let poolCachePromise: Promise<LoadEgressPoolResult> | null = null;
const POOL_CACHE_TTL_MS = 60_000;

export type LoadEgressPoolResult =
  | { ok: true; pool: EgressProxy[]; count: number | null; unusable: number; loadedAt: string }
  | { ok: false; code: EgressErrorCode; message: string };

/**
 * Load the proxy pool through the webshare connector (vault token). Rows are
 * reduced to in-memory connection URLs — transient in-process only (≤60 s TTL),
 * never cached to disk, never logged. Uses a shared in-flight promise so
 * concurrent callers cannot stampede the 60 req/min Webshare budget.
 */
export async function loadEgressPool(opts: { forceRefresh?: boolean } = {}): Promise<LoadEgressPoolResult> {
  if (!opts.forceRefresh && poolCache && Date.now() - poolCache.loadedAt < POOL_CACHE_TTL_MS) {
    return {
      ok: true,
      pool: poolCache.pool,
      count: poolCache.count,
      unusable: poolCache.unusable,
      loadedAt: new Date(poolCache.loadedAt).toISOString(),
    };
  }
  if (poolCachePromise) return poolCachePromise;

  poolCachePromise = (async (): Promise<LoadEgressPoolResult> => {
    const row = await db.credential.findUnique({
      where: { service_label: { service: "webshare", label: "api" } },
    });
    if (!row) {
      return { ok: false, code: "NOT_CONFIGURED", message: "no Webshare token in the vault — save it on the Webshare card first." };
    }

    let apiToken: string;
    try {
      apiToken = decryptSecret(row.cipher);
    } catch (e) {
      if (e instanceof VaultIntegrityError) {
        return { ok: false, code: "VAULT_UNREADABLE", message: "stored Webshare token cannot be decrypted — re-save it on the card." };
      }
      return { ok: false, code: "VAULT_UNREADABLE", message: "stored Webshare token could not be read." };
    }

    const poolPage = await listAllProxies(apiToken);
    if (!poolPage.ok) {
      return { ok: false, code: poolPage.code, message: poolPage.message };
    }

    const pool: EgressProxy[] = extractProxyCredentials(poolPage.results).map((c) => ({
      id: c.id,
      // Built in-memory only (P7). encodeURIComponent keeps the URL parseable
      // even if the credential contains reserved characters.
      url: `http://${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}`,
      port: c.port,
      country: c.country,
      valid: c.valid,
    }));

    poolCache = { pool, count: poolPage.count, unusable: poolPage.unusable, loadedAt: Date.now() };
    return {
      ok: true,
      pool,
      count: poolPage.count,
      unusable: poolPage.unusable,
      loadedAt: new Date(poolCache.loadedAt).toISOString(),
    };
  })();

  try {
    return await poolCachePromise;
  } finally {
    poolCachePromise = null;
  }
}

/** UI-safe pool summary — counts/booleans/countries only (P7). */
export function summarizePool(pool: EgressProxy[]): { count: number; validCount: number; countries: string[] } {
  const countries = [...new Set(pool.map((p) => p.country).filter((c): c is string => typeof c === "string"))].sort();
  return {
    count: pool.length,
    validCount: pool.filter((p) => p.valid === true).length,
    countries,
  };
}

/** Pick up to `n` pool proxies for probing — valid ones first, stable order (no identity leaves the process). */
export function pickProxies(pool: EgressProxy[], n: number): EgressProxy[] {
  const valid = pool.filter((p) => p.valid === true);
  const rest = pool.filter((p) => p.valid !== true);
  return [...valid, ...rest].slice(0, Math.max(1, n));
}

// ---------------------------------------------------------------------------
// Routing registry (Settings KV)
// ---------------------------------------------------------------------------

function sanitizeRoutingMap(raw: unknown): Record<string, EgressMode> {
  const out: Record<string, EgressMode> = { default: "direct" };
  if (typeof raw !== "object" || raw === null) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || !/^[a-z0-9-]{1,64}$/.test(k)) continue;
    if (v === "direct" || v === "proxy") out[k] = v;
  }
  return out;
}

/** Read the `egress.routing` KV map. Default (missing/corrupt): {"default":"direct"}. */
export async function readRoutingMap(): Promise<Record<string, EgressMode>> {
  try {
    const row = await db.setting.findUnique({ where: { key: EGRESS_ROUTING_KEY } });
    if (!row) return { default: "direct" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      return { default: "direct" };
    }
    return sanitizeRoutingMap(parsed);
  } catch {
    return { default: "direct" };
  }
}

/** Resolve the mode for one target: map[target] ?? map.default ?? "direct". */
export function routeFor(target: string, map: Record<string, EgressMode>): EgressMode {
  return map[target] ?? map["default"] ?? "direct";
}

// ---------------------------------------------------------------------------
// Honest classification
// ---------------------------------------------------------------------------

/**
 * Classify an upstream answer. RULES (honesty contract):
 * - no HTTP answer at all → UNREACHABLE_FROM_SANDBOX (NEVER "key rejected").
 * - 401 → KEY_REJECTED (the upstream answered and rejected auth — it IS reachable).
 * - 403 → UNREACHABLE_WAF (answered, but access is refused at the edge — e.g.
 *   Groq from the sandbox egress IP [MEASURED]).
 */
export function classifyEgress(status: number | null): { classification: EgressClassification; reachable: boolean } {
  if (status === null) return { classification: "UNREACHABLE_FROM_SANDBOX", reachable: false };
  if (status >= 200 && status < 300) return { classification: "OK", reachable: true };
  if (status === 401) return { classification: "KEY_REJECTED", reachable: true };
  if (status === 403) return { classification: "UNREACHABLE_WAF", reachable: true };
  if (status === 404) return { classification: "NOT_FOUND", reachable: true };
  if (status === 429) return { classification: "RATE_LIMITED", reachable: true };
  if (status >= 500) return { classification: "UPSTREAM_ERROR", reachable: true };
  return { classification: "HTTP_OTHER", reachable: true };
}

/**
 * Cloudflare-trace helper for the generic-echo target: returns the `loc=` country
 * code ONLY. Every other line (notably `ip=…`) is discarded and must never be
 * echoed anywhere (P7).
 */
export function parseTraceCountry(bodyText: string): string | null {
  const m = /^loc=([A-Za-z]{2})$/m.exec(bodyText);
  return m ? m[1].toUpperCase() : null;
}
