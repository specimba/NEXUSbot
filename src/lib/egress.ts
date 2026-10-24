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
 * R19-c — keep-alive tunnel pool + measured route latency:
 * - Pooled tunnels: reusable CONNECT+TLS connections keyed
 *   `${proxyId}|${host}:${port}` (≤4 per key, ≤16 total, 60 s idle TTL, evicted
 *   on close/error/idle-timeout). Pooled requests send `Connection: keep-alive`
 *   and are parsed by protocol framing (Content-Length or chunked) — never by
 *   waiting for socket close. A stale pooled socket that fails BEFORE any
 *   response bytes arrive is evicted and retried ONCE on a fresh tunnel; a
 *   failure after bytes arrived is an honest failure (a possibly-executed
 *   request is never re-sent). Kill-switch: EGRESS_TUNNEL_POOL=off/0 restores
 *   the one-shot close-based path byte-for-byte.
 * - Latency stats per (routing key × mode) — EWMA(α=0.3), last, count, and a
 *   handshake/request (proxied) or headers (direct) split — persisted
 *   (debounced) to Settings KV `egress.stats`; numbers/timestamps only (P7).
 *   Keys are inferred from the target hostname: vyceai.com → "vyce",
 *   api.groq.com → "groq", configured custom-provider hosts →
 *   "custom-providers", everything else → "default".
 * [MEASURED R19-c] proxied cloudflare-trace GET before pooling: 814–870 ms
 * (mean 843 ms, fresh CONNECT+TLS each call); after pooling: see worklog R19-c.
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

/** R19-c additive latency telemetry on every egress response (numbers only). */
export type EgressTiming = {
  /** Proxied/tunnel: CONNECT + (optional) TLS handshake cost; ~0 on a pooled tunnel. */
  handshakeMs?: number;
  /** Tunnel: request write → first response byte. */
  requestMs?: number;
  /** Direct: fetch() → response headers. */
  headersMs?: number;
  /** Call start → first response byte. */
  firstByteMs?: number;
  /** Call start → complete response (headers + body). */
  totalMs?: number;
  /** True when a pooled (reused keep-alive) tunnel served the request. */
  pooled?: boolean;
};

export type EgressHttpResponse = {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  via: "direct" | EgressTransportName;
  /** R19-c additive — existing consumers ignore it. */
  timing?: EgressTiming;
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
/**
 * R17 — dedicated routing key for the custom AI providers section (probe +
 * non-streaming chat). Falls back to map.default when unset, so behavior is
 * unchanged for owners who never touch it. [MEASURED R17] aihubmix.com answers
 * direct from the sandbox (200, 1.1s) while the SAME request through the
 * Webshare pool fails at the transport layer (UPSTREAM_BAD_RESPONSE) — a
 * dedicated key lets the owner route custom providers direct while Groq stays
 * proxied via "default".
 */
export const EGRESS_CUSTOM_PROVIDERS_KEY = "custom-providers";

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

// ---------------------------------------------------------------------------
// Keep-alive tunnel pool + protocol-framed HTTP/1.1 parsing (R19-c)
// ---------------------------------------------------------------------------

/** Reusable CONNECT+TLS tunnel. SERVER-ONLY — never serialized (P7). */
type PooledTunnel = {
  /** `${proxyId}|${host}:${port}` */
  key: string;
  proxyId: string;
  host: string;
  port: number;
  /** The connection HTTP is spoken over (TLSSocket for https, raw socket otherwise). */
  conn: net.Socket;
  /** Underlying raw socket (=== conn for plain-HTTP targets). */
  raw: net.Socket;
  checkedOut: boolean;
  inPool: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleHandlers: { data: () => void; close: () => void; error: () => void } | null;
  createdAt: number;
  lastUsedAt: number;
};

const TUNNEL_POOL_MAX_PER_KEY = 4;
const TUNNEL_POOL_IDLE_TTL_MS = 60_000;
const TUNNEL_POOL_MAX_TOTAL = 16;
/** Operational kill-switch: EGRESS_TUNNEL_POOL=off/0/1 semantics — off restores the one-shot close-based path. */
const TUNNEL_POOL_ENABLED = !/^(0|off|false|no)$/i.test(process.env.EGRESS_TUNNEL_POOL ?? "");

const tunnelPool = new Map<string, PooledTunnel[]>();
let tunnelPoolTotal = 0;

/** Destroy a tunnel entry and remove it from the pool (idempotent). */
function destroyTunnel(entry: PooledTunnel): void {
  if (entry.inPool) {
    const arr = tunnelPool.get(entry.key);
    if (arr) {
      const idx = arr.indexOf(entry);
      if (idx !== -1) arr.splice(idx, 1);
      if (arr.length === 0) tunnelPool.delete(entry.key);
      tunnelPoolTotal--;
    }
    entry.inPool = false;
  }
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  // Keep idle handlers attached through destroy so the inevitable error/close
  // events are swallowed instead of crashing the process; detach afterwards.
  entry.conn.destroy();
  entry.raw.destroy();
  detachIdleHandlers(entry);
}

function attachIdleHandlers(entry: PooledTunnel): void {
  // Any activity while idle means the connection is no longer cleanly reusable:
  // unexpected bytes (pipelined garbage) or the peer closing/erroring → evict.
  const data = () => destroyTunnel(entry);
  const close = () => destroyTunnel(entry);
  const error = () => destroyTunnel(entry);
  entry.idleHandlers = { data, close, error };
  entry.conn.on("data", data);
  entry.conn.on("close", close);
  entry.conn.on("error", error);
}

function detachIdleHandlers(entry: PooledTunnel): void {
  if (!entry.idleHandlers) return;
  const { data, close, error } = entry.idleHandlers;
  entry.conn.off("data", data);
  entry.conn.off("close", close);
  entry.conn.off("error", error);
  entry.idleHandlers = null;
}

/**
 * Check out an idle pooled tunnel for this key (concurrency-safe: a checked-out
 * entry is never handed out twice). Stale entries (destroyed/unwritable) are
 * evicted on sight. Returns null when no usable tunnel exists.
 */
function acquirePooledTunnel(key: string): PooledTunnel | null {
  const arr = tunnelPool.get(key);
  if (!arr) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const entry = arr[i]!;
    if (entry.checkedOut) continue;
    if (entry.conn.destroyed || !entry.conn.writable) {
      destroyTunnel(entry); // stale — evict, keep scanning
      continue;
    }
    detachIdleHandlers(entry);
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    entry.checkedOut = true;
    return entry;
  }
  return null;
}

/** Evict the least-recently-used IDLE entry (preferring `preferredKey`'s bucket). */
function evictOldestIdle(preferredKey?: string): boolean {
  const scan = (arr: PooledTunnel[]): PooledTunnel | null => {
    let oldest: PooledTunnel | null = null;
    for (const e of arr) {
      if (!e.checkedOut && (oldest === null || e.lastUsedAt < oldest.lastUsedAt)) oldest = e;
    }
    return oldest;
  };
  if (preferredKey) {
    const arr = tunnelPool.get(preferredKey);
    const e = arr ? scan(arr) : null;
    if (e) {
      destroyTunnel(e);
      return true;
    }
  }
  let oldest: PooledTunnel | null = null;
  for (const arr of tunnelPool.values()) {
    const e = scan(arr);
    if (e && (oldest === null || e.lastUsedAt < oldest.lastUsedAt)) oldest = e;
  }
  if (oldest) {
    destroyTunnel(oldest);
    return true;
  }
  return false;
}

/** Return a healthy tunnel to the pool (idle TTL eviction, caps enforced). */
function checkinPooledTunnel(entry: PooledTunnel): void {
  if (!TUNNEL_POOL_ENABLED || entry.conn.destroyed || !entry.conn.writable) {
    destroyTunnel(entry);
    return;
  }
  if (entry.inPool) {
    // Re-checkin of an acquired entry — capacity was already granted.
    entry.checkedOut = false;
    entry.lastUsedAt = Date.now();
    attachIdleHandlers(entry);
    entry.idleTimer = setTimeout(() => destroyTunnel(entry), TUNNEL_POOL_IDLE_TTL_MS);
    entry.idleTimer.unref?.();
    return;
  }
  let arr = tunnelPool.get(entry.key);
  if (arr && arr.length >= TUNNEL_POOL_MAX_PER_KEY) {
    destroyTunnel(entry);
    return;
  }
  if (tunnelPoolTotal >= TUNNEL_POOL_MAX_TOTAL && !evictOldestIdle(entry.key)) {
    destroyTunnel(entry); // pool full with everything in flight — do not pool
    return;
  }
  arr ??= [];
  tunnelPool.set(entry.key, arr);
  entry.inPool = true;
  entry.checkedOut = false;
  entry.lastUsedAt = Date.now();
  attachIdleHandlers(entry);
  entry.idleTimer = setTimeout(() => destroyTunnel(entry), TUNNEL_POOL_IDLE_TTL_MS);
  entry.idleTimer.unref?.();
  arr.push(entry);
  tunnelPoolTotal++;
}

/** Proxy ids that currently have at least one idle live tunnel to `host`. */
function warmProxyIdsForHost(host: string): Set<string> {
  const out = new Set<string>();
  const prefix = `${host}:`;
  for (const [key, arr] of tunnelPool) {
    const sep = key.indexOf("|");
    if (sep === -1 || !key.slice(sep + 1).startsWith(prefix)) continue;
    for (const e of arr) {
      if (!e.checkedOut && !e.conn.destroyed) {
        out.add(key.slice(0, sep));
        break;
      }
    }
  }
  return out;
}

function makeTunnelEntry(
  key: string,
  proxy: EgressProxy,
  host: string,
  port: number,
  conn: net.Socket,
  raw: net.Socket,
): PooledTunnel {
  const now = Date.now();
  return {
    key,
    proxyId: proxy.id,
    host,
    port,
    conn,
    raw,
    checkedOut: true,
    inPool: false,
    idleTimer: null,
    idleHandlers: null,
    createdAt: now,
    lastUsedAt: now,
  };
}

function tunnelPoolSnapshot() {
  let idle = 0;
  for (const arr of tunnelPool.values()) {
    for (const e of arr) if (!e.checkedOut) idle++;
  }
  return {
    enabled: TUNNEL_POOL_ENABLED,
    liveSockets: tunnelPoolTotal,
    idleSockets: idle,
    keys: tunnelPool.size,
    maxPerKey: TUNNEL_POOL_MAX_PER_KEY,
    maxTotal: TUNNEL_POOL_MAX_TOTAL,
    idleTtlMs: TUNNEL_POOL_IDLE_TTL_MS,
  };
}

type FramedParse =
  | { state: "headers" } // not enough bytes yet
  | { state: "complete"; status: number; headers: Record<string, string>; bodyText: string; reusable: boolean }
  | { state: "close-delimited"; status: number; headers: Record<string, string>; bodyText: string }
  | { state: "error" }; // protocol violation

/**
 * Protocol-framed HTTP/1.1 response parser for keep-alive sockets: a response
 * is COMPLETE at Content-Length bytes / the terminating 0-chunk — never by
 * waiting for socket close. Close-delimited responses (no framing) are flagged
 * so the caller can fall back to the legacy close-based completion.
 */
function parseFramedResponse(raw: string, method: string): FramedParse {
  const sep = raw.indexOf("\r\n\r\n");
  if (sep === -1) return { state: "headers" };
  const headBlock = raw.slice(0, sep);
  const lines = headBlock.split("\r\n");
  const status = Number((/^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? "") ?? [])[1] ?? 0);
  if (!status) return { state: "error" };
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const c = line.indexOf(":");
    if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
  }
  const bodyRaw = raw.slice(sep + 4);
  const chunked = (headers["transfer-encoding"] ?? "").includes("chunked");
  const contentLength =
    headers["content-length"] !== undefined ? Number(headers["content-length"]) : null;
  const serverClose = (headers["connection"] ?? "").includes("close");
  const bodyless =
    status === 204 || status === 304 || (status >= 100 && status < 200) || method === "HEAD";

  if (bodyless) {
    return {
      state: "complete",
      status,
      headers,
      bodyText: "",
      // extra bytes after a bodyless response would corrupt the next read
      reusable: !serverClose && bodyRaw.length === 0,
    };
  }
  if (chunked) {
    let i = 0;
    let out = "";
    for (;;) {
      const lineEnd = bodyRaw.indexOf("\r\n", i);
      if (lineEnd === -1) return { state: "headers" };
      const size = parseInt(bodyRaw.slice(i, lineEnd).split(";")[0].trim(), 16);
      if (!Number.isFinite(size)) return { state: "error" };
      if (size === 0) {
        // terminating 0-chunk: complete once the trailer terminator CRLF is in
        const rest = bodyRaw.slice(lineEnd + 2);
        if (rest === "" ) return { state: "headers" };
        if (rest === "\r\n" || rest.endsWith("\r\n\r\n")) {
          return { state: "complete", status, headers, bodyText: out, reusable: !serverClose };
        }
        return { state: "headers" }; // trailers still arriving
      }
      if (bodyRaw.length < lineEnd + 2 + size + 2) return { state: "headers" };
      out += bodyRaw.slice(lineEnd + 2, lineEnd + 2 + size);
      i = lineEnd + 2 + size + 2;
    }
  }
  if (contentLength !== null && Number.isFinite(contentLength)) {
    if (bodyRaw.length < contentLength) return { state: "headers" };
    const leftover = bodyRaw.slice(contentLength);
    return {
      state: "complete",
      status,
      headers,
      bodyText: bodyRaw.slice(0, contentLength),
      // bytes beyond the declared body = protocol violation/pipelining → never reuse
      reusable: !serverClose && leftover.length === 0,
    };
  }
  // No framing: body ends at socket close (legacy behavior; socket not reusable).
  return { state: "close-delimited", status, headers, bodyText: bodyRaw };
}

type FramedResult = {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  /** Connection may return to the pool for another request. */
  reusable: boolean;
  /** Any response bytes arrived before an error/timeout (stale-retry guard). */
  sawBytes: boolean;
  /** request write → first response byte. */
  requestMs: number | undefined;
};

/**
 * Send one HTTP/1.1 request with `Connection: keep-alive` and parse the response
 * by protocol framing (Content-Length / chunked). Close-delimited responses
 * fall back to legacy close-based completion and are never re-pooled.
 */
function sendRawOverSocketFramed(
  socket: net.Socket,
  target: URL,
  init: EgressFetchInit,
  timeoutMs: number,
): Promise<FramedResult> {
  const body = typeof init.body === "string" ? init.body : "";
  const method = (init.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {
    Host: target.host,
    Accept: "*/*",
    "User-Agent": "NEXUS-OS/0.1 (+egress layer 12-a)",
    Connection: "keep-alive",
    ...(init.headers ?? {}),
  };
  if (body.length > 0 && !Object.keys(headers).some((h) => h.toLowerCase() === "content-length")) {
    headers["Content-Length"] = String(Buffer.byteLength(body, "utf8"));
  }

  const head =
    `${method} ${target.pathname}${target.search} HTTP/1.1\r\n` +
    Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n") +
    "\r\n\r\n";

  return new Promise((resolve, reject) => {
    let raw = "";
    let done = false;
    let closeDelimited = false;
    let firstByteAt = 0;
    const writtenAt = Date.now();

    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      socket.setTimeout(0);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
      socket.off("close", onClose);
      fn();
    };
    const onError = (e: Error) => finish(() => {
      socket.destroy();
      reject(
        Object.assign(new Error("tunnel read failed"), {
          cause: e.message,
          egressCode: "UPSTREAM_BAD_RESPONSE" as EgressErrorCode,
          sawBytes: raw.length > 0,
        }),
      );
    });
    const onTimeout = () => finish(() => {
      socket.destroy();
      reject(
        Object.assign(new Error("upstream timed out over tunnel"), {
          egressCode: "UPSTREAM_TIMEOUT" as EgressErrorCode,
          sawBytes: raw.length > 0,
        }),
      );
    });
    const onData = (chunk: Buffer) => {
      if (raw.length === 0) firstByteAt = Date.now();
      raw += chunk.toString("latin1");
      if (raw.length > MAX_BODY_BYTES + 16_384) {
        finish(() => {
          socket.destroy();
          reject(
            Object.assign(new Error("upstream response exceeded body cap"), {
              egressCode: "UPSTREAM_BAD_RESPONSE" as EgressErrorCode,
              sawBytes: true,
            }),
          );
        });
        return;
      }
      if (closeDelimited) return; // body completes at socket close
      const p = parseFramedResponse(raw, method);
      if (p.state === "headers") return;
      if (p.state === "error") {
        finish(() => {
          socket.destroy();
          reject(
            Object.assign(new Error("unparseable upstream response over tunnel"), {
              egressCode: "UPSTREAM_BAD_RESPONSE" as EgressErrorCode,
              sawBytes: true,
            }),
          );
        });
        return;
      }
      if (p.state === "close-delimited") {
        closeDelimited = true; // no Content-Length/chunked — wait for close, never re-pool
        return;
      }
      finish(() => {
        if (!p.reusable) socket.destroy();
        resolve({
          status: p.status,
          headers: p.headers,
          bodyText: p.bodyText,
          reusable: p.reusable,
          sawBytes: true,
          requestMs: firstByteAt ? firstByteAt - writtenAt : undefined,
        });
      });
    };
    const onClose = () => finish(() => {
      if (closeDelimited) {
        const p = parseFramedResponse(raw, method);
        if (p.state === "close-delimited" || p.state === "complete") {
          resolve({
            status: p.status,
            headers: p.headers,
            bodyText: p.bodyText,
            reusable: false,
            sawBytes: true,
            requestMs: firstByteAt ? firstByteAt - writtenAt : undefined,
          });
          return;
        }
        reject(
          Object.assign(new Error("no HTTP response received over tunnel"), {
            egressCode: "UPSTREAM_BAD_RESPONSE" as EgressErrorCode,
            sawBytes: raw.length > 0,
          }),
        );
        return;
      }
      reject(
        Object.assign(
          new Error(raw.length === 0 ? "tunnel closed before any response bytes" : "tunnel closed mid-response"),
          {
            egressCode: "UPSTREAM_BAD_RESPONSE" as EgressErrorCode,
            sawBytes: raw.length > 0,
          },
        ),
      );
    });

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("timeout", onTimeout);
    socket.on("close", onClose);
    socket.setTimeout(timeoutMs);
    socket.write(head + body);
  });
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

/** LEGACY (pre-R19-c) close-based one-shot sender — kept verbatim as the
 *  kill-switch path and the close-delimited fallback. */

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
  const poolKey = `${proxy.id}|${target.hostname}:${port}`;
  const t0 = Date.now();

  // 1) Prefer a warm pooled tunnel for this proxy+target (R19-c).
  const pooled = TUNNEL_POOL_ENABLED ? acquirePooledTunnel(poolKey) : null;
  if (pooled) {
    const tAcquired = Date.now();
    try {
      const r = await sendRawOverSocketFramed(pooled.conn, target, init, timeoutMs);
      if (r.reusable && TUNNEL_POOL_ENABLED) checkinPooledTunnel(pooled);
      else destroyTunnel(pooled);
      const acquireMs = tAcquired - t0; // ~0 — no CONNECT/TLS happened
      return {
        status: r.status,
        headers: r.headers,
        bodyText: r.bodyText,
        via: "tunnel",
        timing: {
          handshakeMs: acquireMs,
          requestMs: r.requestMs,
          firstByteMs: acquireMs + (r.requestMs ?? 0),
          totalMs: Date.now() - t0,
          pooled: true,
        },
      };
    } catch (e) {
      destroyTunnel(pooled);
      const err = e as Error & { sawBytes?: boolean; egressCode?: EgressErrorCode };
      if (err.sawBytes !== true) {
        // STALE-RETRY (safety-critical): the pooled socket failed BEFORE any
        // response bytes arrived — evicted, then ONE retry on a fresh tunnel.
        // After bytes arrived we fail honestly: a possibly-executed request is
        // never re-sent. Fresh-tunnel failures never retry (same as pre-R19-c).
        return tunnelFetchFresh(proxy, target, init, timeoutMs);
      }
      throw err;
    }
  }

  // 2) Fresh tunnel — framed + keep-alive so the connection can be pooled.
  return tunnelFetchFresh(proxy, target, init, timeoutMs);
}

/** Fresh CONNECT (+TLS) tunnel; framed keep-alive request; pooled when healthy. */
async function tunnelFetchFresh(
  proxy: EgressProxy,
  target: URL,
  init: EgressFetchInit,
  timeoutMs: number,
): Promise<EgressHttpResponse> {
  if (!TUNNEL_POOL_ENABLED) return tunnelFetchLegacy(proxy, target, init, timeoutMs);
  const isTls = target.protocol === "https:";
  const port = Number(target.port) || (isTls ? 443 : 80);
  const poolKey = `${proxy.id}|${target.hostname}:${port}`;
  const t0 = Date.now();
  const socket = await connectThroughProxy(proxy, target.hostname, port, timeoutMs);
  const tConnected = Date.now();

  try {
    if (!isTls) {
      // Plain-HTTP target: the tunnel already ends at the target — send raw HTTP.
      const r = await sendRawOverSocketFramed(socket, target, init, timeoutMs);
      const entry = makeTunnelEntry(poolKey, proxy, target.hostname, port, socket, socket);
      if (r.reusable) checkinPooledTunnel(entry);
      else destroyTunnel(entry);
      const handshakeMs = tConnected - t0;
      return {
        status: r.status,
        headers: r.headers,
        bodyText: r.bodyText,
        via: "tunnel",
        timing: {
          handshakeMs,
          requestMs: r.requestMs,
          firstByteMs: handshakeMs + (r.requestMs ?? 0),
          totalMs: Date.now() - t0,
          pooled: false,
        },
      };
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
        const handshakeMs = Date.now() - t0; // CONNECT + TLS
        sendRawOverSocketFramed(tlsSocket, target, init, timeoutMs)
          .then((r) => {
            const entry = makeTunnelEntry(poolKey, proxy, target.hostname, port, tlsSocket, socket);
            if (r.reusable) checkinPooledTunnel(entry);
            else destroyTunnel(entry);
            resolve({
              status: r.status,
              headers: r.headers,
              bodyText: r.bodyText,
              via: "tunnel",
              timing: {
                handshakeMs,
                requestMs: r.requestMs,
                firstByteMs: handshakeMs + (r.requestMs ?? 0),
                totalMs: Date.now() - t0,
                pooled: false,
              },
            });
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

/** Pre-R19-c behavior, byte-for-byte: fresh tunnel, `Connection: close`,
 *  close-delimited response wait, sockets destroyed after one request. */
async function tunnelFetchLegacy(
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
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const headersMs = Date.now() - t0; // fetch → response headers (R19-c)
    const bodyText = (await res.text()).slice(0, MAX_BODY_BYTES);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const timing: EgressTiming = { headersMs, firstByteMs: headersMs, totalMs: Date.now() - t0 };
    // R19-c: record latency per (routing key × "direct") — answered exchanges only.
    void routingKeyForUrl(url)
      .then((key) => recordRouteSample(key, "direct", timing))
      .catch(() => { /* stats are best-effort, never fatal */ });
    return { status: res.status, headers, bodyText, via: "direct", timing };
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
  // R19-c route-affinity hint: the next pickProxies() call prefers proxies
  // with warm pooled tunnels to this host (hostnames are public probe targets;
  // they stay in memory and are never serialized — P7).
  lastProxiedTargetHost = url.hostname;
  const t0 = Date.now();

  try {
    let res: EgressHttpResponse | EgressHttpFailure;
    if (transport === "undici") res = await undiciFetch(opts.proxy, url, init, timeoutMs);
    else if (transport === "bun") res = await bunFetch(opts.proxy, url, init, timeoutMs);
    else res = await tunnelFetch(opts.proxy, url, init, timeoutMs);
    if ("status" in res) {
      // R19-c: record per (routing key × "proxy") latency on answered
      // exchanges. undici/bun transports only report a total (opaque client).
      const timing = res.timing ?? { totalMs: Date.now() - t0 };
      void routingKeyForUrl(url)
        .then((key) => recordRouteSample(key, "proxy", timing))
        .catch(() => { /* stats are best-effort, never fatal */ });
      return res.timing ? res : { ...res, timing };
    }
    return res;
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

/**
 * Pick up to `n` pool proxies for probing — valid ones first, stable order (no
 * identity leaves the process).
 *
 * R19-c route affinity (preference, never a guarantee): when a warm pooled
 * tunnel exists for a target host, its proxy moves to the FRONT of the picks —
 * pool-proxy randomness/refresh order otherwise defeats tunnel reuse. The
 * preferred proxy is validated against the caller's pool list; affinity only
 * reorders, it never adds. Without `opts.preferHost`, the host of the most
 * recent proxiedFetch() is used (the sequential same-upstream pattern that
 * dominates Vyce/Groq traffic).
 */
let lastProxiedTargetHost: string | null = null;

export function pickProxies(
  pool: EgressProxy[],
  n: number,
  opts: { preferHost?: string } = {},
): EgressProxy[] {
  const valid = pool.filter((p) => p.valid === true);
  const rest = pool.filter((p) => p.valid !== true);
  let ordered = [...valid, ...rest];
  const preferHost = opts.preferHost ?? lastProxiedTargetHost;
  if (preferHost && TUNNEL_POOL_ENABLED) {
    const warm = warmProxyIdsForHost(preferHost);
    if (warm.size > 0) {
      ordered = [
        ...ordered.filter((p) => warm.has(p.id)),
        ...ordered.filter((p) => !warm.has(p.id)),
      ];
    }
  }
  return ordered.slice(0, Math.max(1, n));
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
// Measured route latency stats (R19-c) — Settings KV `egress.stats`
// ---------------------------------------------------------------------------

export const EGRESS_STATS_KV_KEY = "egress.stats";
const EGRESS_STATS_EWMA_ALPHA = 0.3;
const EGRESS_STATS_FLUSH_DEBOUNCE_MS = 5_000;
/** Routing keys whose latency is tracked — mirrors the routing-map semantics. */
const EGRESS_STATS_ROUTE_KEYS: readonly string[] = [
  "vyce",
  "groq",
  EGRESS_CUSTOM_PROVIDERS_KEY,
  "default",
];

/** Per (routing key × mode) measured latency. Numbers/timestamps ONLY (P7). */
export type EgressRouteStatsEntry = {
  /** EWMA(α=0.3) of full-exchange latency in ms. */
  ewmaMs: number;
  lastLatencyMs: number;
  sampleCount: number;
  /** epoch ms of the last sample */
  lastAt: number;
  /** proxied: EWMA of CONNECT+TLS handshake cost (when the transport reports it) */
  handshakeEwmaMs?: number;
  /** proxied: EWMA of request-write → first-response-byte */
  requestEwmaMs?: number;
  /** direct: EWMA of fetch() → response headers */
  headersEwmaMs?: number;
};

/** UI/API-safe snapshot (awaits KV hydration so history is included). */
export type EgressRouteStatsSnapshot = {
  entries: Record<string, Partial<Record<EgressMode, EgressRouteStatsEntry>>>;
  tunnelPool: ReturnType<typeof tunnelPoolSnapshot>;
};

const routeStats: Record<string, EgressRouteStatsEntry> = {};
let routeStatsLoaded: Promise<void> | null = null;
let routeStatsDirty = false;
let routeStatsFlushTimer: ReturnType<typeof setTimeout> | null = null;

function sanitizeStatsEntry(raw: unknown): EgressRouteStatsEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  const ewmaMs = num(o.ewmaMs);
  const lastLatencyMs = num(o.lastLatencyMs);
  const sampleCount = num(o.sampleCount);
  const lastAt = num(o.lastAt);
  if (
    ewmaMs === undefined || lastLatencyMs === undefined ||
    sampleCount === undefined || lastAt === undefined || sampleCount < 1
  ) {
    return null;
  }
  const entry: EgressRouteStatsEntry = {
    ewmaMs: Math.round(ewmaMs),
    lastLatencyMs: Math.round(lastLatencyMs),
    sampleCount: Math.floor(sampleCount),
    lastAt: Math.floor(lastAt),
  };
  const h = num(o.handshakeEwmaMs);
  if (h !== undefined) entry.handshakeEwmaMs = Math.round(h);
  const rq = num(o.requestEwmaMs);
  if (rq !== undefined) entry.requestEwmaMs = Math.round(rq);
  const hd = num(o.headersEwmaMs);
  if (hd !== undefined) entry.headersEwmaMs = Math.round(hd);
  return entry;
}

/** Hydrate from KV once per process so stats survive dev-server reloads. */
function ensureRouteStatsLoaded(): Promise<void> {
  if (!routeStatsLoaded) {
    routeStatsLoaded = (async (): Promise<void> => {
      try {
        const row = await db.setting.findUnique({ where: { key: EGRESS_STATS_KV_KEY } });
        if (!row) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.value);
        } catch {
          return; // corrupt KV → start empty (honest-state doctrine)
        }
        const entries =
          typeof parsed === "object" && parsed !== null
            ? (parsed as { entries?: unknown }).entries
            : null;
        if (typeof entries !== "object" || entries === null) return;
        for (const [k, v] of Object.entries(entries as Record<string, unknown>)) {
          const m = /^([a-z0-9-]{1,64})\|(direct|proxy)$/.exec(k);
          if (!m || !EGRESS_STATS_ROUTE_KEYS.includes(m[1]!)) continue;
          if (routeStats[k]) continue; // in-process samples win over persisted history
          const e = sanitizeStatsEntry(v);
          if (e) routeStats[k] = e;
        }
      } catch {
        // db unavailable — keep in-memory stats only, never fatal
      }
    })();
  }
  return routeStatsLoaded;
}

function ewma(prev: number | undefined, sample: number): number {
  return prev === undefined
    ? Math.round(sample)
    : Math.round(EGRESS_STATS_EWMA_ALPHA * sample + (1 - EGRESS_STATS_EWMA_ALPHA) * prev);
}

/** Record one measured exchange (answered requests only). Fire-and-forget. */
function recordRouteSample(routeKey: string, mode: EgressMode, timing: EgressTiming): void {
  if (!EGRESS_STATS_ROUTE_KEYS.includes(routeKey)) return;
  const total = timing.totalMs ?? timing.firstByteMs;
  if (total === undefined || !Number.isFinite(total) || total < 0) return;
  void ensureRouteStatsLoaded()
    .then(() => {
      const k = `${routeKey}|${mode}`;
      const prev = routeStats[k];
      const now = Date.now();
      const next: EgressRouteStatsEntry = prev
        ? {
            ...prev,
            ewmaMs: ewma(prev.ewmaMs, total),
            lastLatencyMs: Math.round(total),
            sampleCount: prev.sampleCount + 1,
            lastAt: now,
          }
        : { ewmaMs: Math.round(total), lastLatencyMs: Math.round(total), sampleCount: 1, lastAt: now };
      if (timing.handshakeMs !== undefined) next.handshakeEwmaMs = ewma(prev?.handshakeEwmaMs, timing.handshakeMs);
      if (timing.requestMs !== undefined) next.requestEwmaMs = ewma(prev?.requestEwmaMs, timing.requestMs);
      if (timing.headersMs !== undefined) next.headersEwmaMs = ewma(prev?.headersEwmaMs, timing.headersMs);
      routeStats[k] = next;
      scheduleRouteStatsFlush();
    })
    .catch(() => { /* never fatal */ });
}

function scheduleRouteStatsFlush(): void {
  routeStatsDirty = true;
  if (routeStatsFlushTimer) return;
  routeStatsFlushTimer = setTimeout(() => {
    routeStatsFlushTimer = null;
    void flushRouteStats();
  }, EGRESS_STATS_FLUSH_DEBOUNCE_MS);
  routeStatsFlushTimer.unref?.();
}

async function flushRouteStats(): Promise<void> {
  if (!routeStatsDirty) return;
  routeStatsDirty = false;
  try {
    await ensureRouteStatsLoaded();
    const value = JSON.stringify({ version: 1, entries: routeStats });
    await db.setting.upsert({
      where: { key: EGRESS_STATS_KV_KEY },
      update: { value },
      create: { key: EGRESS_STATS_KV_KEY, value },
    });
  } catch {
    routeStatsDirty = true; // retry on the next sample — never fatal
  }
}

let customProviderHostsCache: { hosts: Set<string>; loadedAt: number } | null = null;
const CUSTOM_PROVIDER_HOSTS_TTL_MS = 60_000;

/** Hostnames of configured custom AI providers (KV `ai.custom-providers`, parsed defensively here to avoid a circular import). */
async function customProviderHosts(): Promise<Set<string>> {
  if (customProviderHostsCache && Date.now() - customProviderHostsCache.loadedAt < CUSTOM_PROVIDER_HOSTS_TTL_MS) {
    return customProviderHostsCache.hosts;
  }
  const hosts = new Set<string>();
  try {
    const row = await db.setting.findUnique({ where: { key: "ai.custom-providers" } });
    if (row) {
      try {
        const parsed: unknown = JSON.parse(row.value);
        if (Array.isArray(parsed)) {
          for (const p of parsed) {
            const base =
              typeof (p as { baseUrl?: unknown })?.baseUrl === "string"
                ? (p as { baseUrl: string }).baseUrl
                : null;
            if (!base) continue;
            try {
              const u = new URL(base);
              hosts.add(u.hostname);
              hosts.add(u.host);
            } catch {
              // malformed baseUrl — skip (sanitizeConfig filters it on write anyway)
            }
          }
        }
      } catch {
        // corrupt KV → no hosts
      }
    }
  } catch {
    // db down → no hosts
  }
  customProviderHostsCache = { hosts, loadedAt: Date.now() };
  return hosts;
}

/**
 * Attribute a URL to a routing key for latency stats. Deterministic hostname
 * inference (callers pass URLs, not keys): vyceai.com → "vyce",
 * api.groq.com → "groq", any configured custom-provider host →
 * "custom-providers", everything else → "default".
 */
async function routingKeyForUrl(url: URL): Promise<string> {
  const h = url.hostname;
  if (h === "vyceai.com" || h.endsWith(".vyceai.com")) return "vyce";
  if (h === "api.groq.com") return "groq";
  const cpHosts = await customProviderHosts();
  if (cpHosts.has(h)) return EGRESS_CUSTOM_PROVIDERS_KEY;
  return "default";
}

/** UI-safe stats snapshot: per key×mode EWMA/last/count/split + live tunnel-pool counts. */
export async function getEgressRouteStats(): Promise<EgressRouteStatsSnapshot> {
  await ensureRouteStatsLoaded();
  const entries: EgressRouteStatsSnapshot["entries"] = {};
  for (const key of EGRESS_STATS_ROUTE_KEYS) {
    for (const mode of ["direct", "proxy"] as const) {
      const e = routeStats[`${key}|${mode}`];
      if (e) (entries[key] ??= {})[mode] = e;
    }
  }
  return { entries, tunnelPool: tunnelPoolSnapshot() };
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
