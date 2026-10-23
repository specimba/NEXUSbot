/**
 * NEXUS OS — Upstash Redis REST connector (T-204).
 *
 * Talks to the Upstash REST API (https REST frontend over Redis):
 *   GET  {url}/ping     -> 200 {"result":"PONG"}          (health probe)
 *   POST {url}/pipeline -> 200 [{result, error}, ...]     (batched commands)
 *   401 on bad token · 429 rate-limited (Retry-After) · network/timeout otherwise.
 *
 * Credential layout stored in the encrypted vault (service "upstash", label "rest"):
 *   JSON {"url","token"} — url like https://<db-id>.upstash.io, token = REST token.
 *
 * P7 doctrine: this module NEVER logs, echoes, or embeds the url/token in errors.
 * Failure messages are sanitized to error codes only (e.g. ECONNREFUSED), so a
 * thrown error can never leak the endpoint host or credential into logs/chat.
 */

export const UPSTASH_SERVICE = "upstash" as const;
export const UPSTASH_LABEL = "rest" as const;

export const UPSTASH_TIMEOUT_MS = 8_000;

export type UpstashConfig = { url: string; token: string };

export type UpstashErrorKind =
  | "bad_url"
  | "not_configured"
  | "bad_config"
  | "timeout"
  | "network"
  | "auth"
  | "rate_limited"
  | "protocol"
  | "unexpected_status";

/** Typed connector error — message is always safe for UI/logs (no url/token). */
export class UpstashConnectorError extends Error {
  readonly kind: UpstashErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    kind: UpstashErrorKind,
    message: string,
    opts?: { status?: number; retryAfterMs?: number },
  ) {
    super(message);
    this.name = "UpstashConnectorError";
    this.kind = kind;
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

export type UpstashPipelineCommand = ReadonlyArray<string | number | null>;

export type UpstashPipelineResultItem =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

/** Parse a stored vault payload into a config; null when malformed. */
export function parseUpstashSecret(raw: string | null | undefined): UpstashConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { url?: unknown; token?: unknown };
    if (typeof parsed.url !== "string" || typeof parsed.token !== "string") return null;
    if (!parsed.url.trim() || !parsed.token.trim()) return null;
    return { url: parsed.url.trim(), token: parsed.token.trim() };
  } catch {
    return null;
  }
}

/** Validate a caller-supplied REST URL. https-only (token must never travel plaintext). */
export function validateUpstashUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new UpstashConnectorError("bad_url", "REST URL is not a valid absolute URL");
  }
  if (parsed.protocol !== "https:") {
    throw new UpstashConnectorError("bad_url", "REST URL must use https://");
  }
  if (!parsed.hostname) {
    throw new UpstashConnectorError("bad_url", "REST URL is missing a host");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new UpstashConnectorError("bad_url", "REST URL must not embed credentials, query or fragment");
  }
  return parsed;
}

function authHeaders(cfg: UpstashConfig): HeadersInit {
  return {
    Authorization: `Bearer ${cfg.token}`,
    "Content-Type": "application/json",
    "Upstash-Partner": "nexus-os",
  };
}

/**
 * Map an unexpected fetch failure to a typed error WITHOUT leaking host/token.
 * Only the numeric cause code (ENOTFOUND, ECONNREFUSED, CERT_*, …) is surfaced.
 */
function mapFetchFailure(e: unknown): UpstashConnectorError {
  const domName = e instanceof Error ? e.name : "";
  const cause = (e as { cause?: { code?: unknown } })?.cause;
  const code = typeof cause?.code === "string" ? cause.code : "";

  if (domName === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") {
    return new UpstashConnectorError("timeout", `Probe timed out after ${UPSTASH_TIMEOUT_MS / 1000}s`);
  }

  const KNOWN = new Set([
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EPROTO",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "EACCES",
  ]);
  if (code && KNOWN.has(code)) {
    return new UpstashConnectorError("network", `Connection failed (${code})`);
  }
  return new UpstashConnectorError("network", "Connection failed");
}

async function readRetryAfterMs(res: Response): Promise<number | undefined> {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const asSec = Number(raw);
  if (Number.isFinite(asSec) && asSec >= 0) return Math.round(asSec * 1000);
  const asDate = Date.parse(raw);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

function authOrStatusError(res: Response, retryAfterMs?: number): UpstashConnectorError {
  if (res.status === 401 || res.status === 403) {
    return new UpstashConnectorError("auth", "Upstash rejected the credential (auth failed)", {
      status: res.status,
    });
  }
  if (res.status === 429) {
    return new UpstashConnectorError(
      "rate_limited",
      retryAfterMs !== undefined
        ? `Rate limited — retry in ~${Math.ceil(retryAfterMs / 1000)}s`
        : "Rate limited by Upstash",
      { status: res.status, retryAfterMs },
    );
  }
  return new UpstashConnectorError(
    "unexpected_status",
    `Upstash REST returned unexpected status ${res.status}`,
    { status: res.status },
  );
}

export type UpstashPingOk = { ok: true; latencyMs: number };

/**
 * Health probe: GET {url}/ping with Bearer token, 8s hard timeout.
 * Resolves {ok:true, latencyMs} only on a genuine {"result":"PONG"};
 * everything else throws a typed UpstashConnectorError.
 */
export async function upstashPing(cfg: UpstashConfig): Promise<UpstashPingOk> {
  let parsed: URL;
  try {
    parsed = validateUpstashUrl(cfg.url);
  } catch (e) {
    throw e instanceof UpstashConnectorError
      ? e
      : new UpstashConnectorError("bad_url", "REST URL is invalid");
  }

  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(`${parsed.origin}/ping`, {
      method: "GET",
      headers: authHeaders(cfg),
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTASH_TIMEOUT_MS),
    });
  } catch (e) {
    throw mapFetchFailure(e);
  }
  const latencyMs = Math.round(performance.now() - started);

  if (!res.ok) {
    throw authOrStatusError(res, await readRetryAfterMs(res));
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new UpstashConnectorError("protocol", "Upstash REST returned non-JSON body");
  }

  const result = (body as { result?: unknown })?.result;
  if (result !== "PONG") {
    throw new UpstashConnectorError("protocol", "Ping did not return PONG");
  }
  return { ok: true, latencyMs };
}

/**
 * Batched commands: POST {url}/pipeline with a JSON array of commands.
 * Honors 429/Retry-After (typed rate_limited error carries retryAfterMs).
 * Per-command Upstash errors stay in-band ({ok:false,error}); only transport /
 * auth / rate-limit / non-JSON failures throw.
 */
export async function upstashPipeline(
  cfg: UpstashConfig,
  cmds: ReadonlyArray<UpstashPipelineCommand>,
): Promise<UpstashPipelineResultItem[]> {
  let parsed: URL;
  try {
    parsed = validateUpstashUrl(cfg.url);
  } catch (e) {
    throw e instanceof UpstashConnectorError
      ? e
      : new UpstashConnectorError("bad_url", "REST URL is invalid");
  }

  let res: Response;
  try {
    res = await fetch(`${parsed.origin}/pipeline`, {
      method: "POST",
      headers: authHeaders(cfg),
      body: JSON.stringify(cmds),
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTASH_TIMEOUT_MS),
    });
  } catch (e) {
    throw mapFetchFailure(e);
  }

  if (!res.ok) {
    throw authOrStatusError(res, await readRetryAfterMs(res));
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new UpstashConnectorError("protocol", "Upstash REST returned non-JSON body");
  }

  if (!Array.isArray(body)) {
    throw new UpstashConnectorError("protocol", "Pipeline response is not an array");
  }

  return body.map((item) => {
    const rec = (item ?? {}) as { result?: unknown; error?: unknown };
    if (typeof rec.error === "string" && rec.error.length > 0) {
      return { ok: false, error: rec.error };
    }
    return { ok: true, result: rec.result };
  });
}
