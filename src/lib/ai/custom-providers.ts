import { db } from "@/lib/db";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import { registerSecretForRedaction, redactSecrets } from "@/lib/ai/client";
import { checkCircuit, recordCircuitFailure, recordCircuitSuccess, type CircuitKey } from "@/lib/ai/circuit";
import {
  EGRESS_CUSTOM_PROVIDERS_KEY,
  loadEgressPool,
  pickProxies,
  proxiedFetch,
  readRoutingMap,
  routeFor,
  type EgressTransportName,
} from "@/lib/egress";

/**
 * NEXUS OS — custom AI providers (task 16-b).
 *
 * A general, always-available provider section: the owner can register ANY
 * OpenAI-style or Anthropic-style API endpoint (base URL + key + models) and
 * call it through chatCompleteCustom(). NOT gated on any connector — works
 * with an empty vault (keys are optional at config time; calls honestly fail
 * with NO_KEY until one is stored).
 *
 * Storage (no Prisma changes):
 *   - Provider CONFIG (non-secret) → Settings KV key "ai.custom-providers",
 *     a JSON array of {slug,name,style,baseUrl,models}. Sanitized on every
 *     read (a corrupt entry is dropped, never trusted).
 *   - Provider KEY (secret) → Credential table, service "provider:<slug>",
 *     label "api-key" — same AES-256-GCM vault as vyce/groq. Masked previews
 *     only ever leave this module.
 *
 * P7 discipline (same as src/lib/connectors/vyce.ts): key plaintext is
 * decrypted transiently per call, held in local scope, passed only into
 * auth headers, registered for redaction via registerSecretForRedaction(),
 * and NEVER logged, echoed, or embedded into messages. Upstream response
 * bodies are scrubbed against the live key before any snippet is included
 * in a failure message. Error messages are static strings + HTTP status +
 * host (host is config, safe to display).
 *
 * Egress (task 13-b conventions, R17 refinement): chatCompleteCustom AND
 * probeCustomProvider resolve routeFor("custom-providers", readRoutingMap())
 * once per call — a dedicated routing key that falls back to map["default"]
 * when unset. [MEASURED R17] aihubmix.com answers direct from the sandbox but
 * fails at the pool transport layer, so the dedicated key lets the owner route
 * custom providers independently of the Groq-driven "default" choice.
 * "direct" → plain fetch; "proxy" → loadEgressPool → pickProxies →
 * proxiedFetch (BUFFERED — non-streaming only). Transport/pool failures map to
 * NETWORK_ERROR and are NEVER UNAUTHORIZED — only an HTTP 401 answered by the
 * upstream itself is a key error.
 *
 * STREAMING IS HONESTLY DEFERRED: proxiedFetch returns a complete buffered
 * envelope and cannot stream (same honesty constraint as the brain's
 * streamComplete). Custom providers are non-streaming only — no fake SSE.
 *
 * R19-a CIRCUIT BREAKER (src/lib/ai/circuit.ts, key "custom:<slug>"): chat
 * calls and probes share one breaker per provider — a chat 429 opens the
 * circuit for chats AND automated probes alike, so a fragile-limit upstream
 * (the aihubmix evidence: 5 RATE_LIMITED hits in ~90s, two 200ms apart) is
 * never hammered. A circuit-open chat fails FAST with exactly ONE honest
 * UsageEvent row (meta.error = recorded class, meta.circuit "open", no network
 * call); a circuit-open probe returns the typed failure with circuit "open"
 * unless the caller passes {force:true} (manual button = deliberate live
 * measurement). NO_KEY-class circuits never block PROBES — a keyless probe is
 * a legitimate measurement (the upstream 401 "demands a key" IS the honest
 * answer for a keyless provider). NOT_CONFIGURED / BAD_INPUT are input
 * problems, not provider health — never recorded to the breaker.
 */

export const CUSTOM_PROVIDERS_KV_KEY = "ai.custom-providers";
export const CUSTOM_PROVIDER_KEY_LABEL = "api-key";

export const CUSTOM_PROBE_TIMEOUT_MS = 8_000;
export const CUSTOM_CHAT_TIMEOUT_MS = 60_000;
export const CUSTOM_MAX_PROXY_ATTEMPTS = 2;

const MAX_PROVIDERS = 16;
const MAX_MODELS_PER_PROVIDER = 64;
const MAX_MODEL_ID_LENGTH = 128;

export type CustomProviderStyle = "openai" | "anthropic";

export type CustomProviderConfig = {
  slug: string;
  name: string;
  style: CustomProviderStyle;
  baseUrl: string;
  models: string[];
};

// ---------------------------------------------------------------------------
// Validation (mirrored client-side in custom-providers-card.tsx)
// ---------------------------------------------------------------------------

/** slug: /^[a-z0-9][a-z0-9-]{1,31}$/ (2..32 chars). */
export function isValidCustomSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,31}$/.test(value);
}

export function isValidCustomName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 64;
}

export function isCustomStyle(value: unknown): value is CustomProviderStyle {
  return value === "openai" || value === "anthropic";
}

/**
 * https-only EXCEPT http for local runners (localhost / 127.0.0.1) — e.g.
 * an Ollama runner at http://localhost:11434/v1. No credentials-in-URL.
 */
export function isValidCustomBaseUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 512) return false;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  if (u.protocol === "http:") {
    const host = u.hostname.toLowerCase();
    if (host !== "localhost" && host !== "127.0.0.1") return false;
  }
  return true;
}

export function normalizeCustomBaseUrl(value: string): string {
  // Trim, then strip trailing slashes. R17: also strip ONE trailing "/models"
  // segment — owners naturally paste the full models URL they copied from
  // provider docs (e.g. "https://aihubmix.com/api/v1/models" [MEASURED]), but
  // every request builder appends its own segment ("/models", "/models" +
  // "/v1/models" for anthropic, "/chat/completions", "/v1/messages"). Keeping
  // the segment would 404 every call; stripping it at this single choke point
  // fixes probe + chat for both styles. No real OpenAI-/Anthropic-style API
  // serves models at ".../models/models", so the ambiguity is theoretical.
  return value
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/models$/, "")
    .replace(/\/+$/, "");
}

/** Public host of the endpoint (safe for the panel — config, not a secret). */
export function customProviderHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * Models: optional free list. Accepts string[] or one big string split on
 * newlines/commas (mirrors the UI textarea). Trimmed, de-duped, capped.
 */
export function sanitizeCustomModels(raw: unknown): string[] {
  let parts: unknown[];
  if (Array.isArray(raw)) parts = raw;
  else if (typeof raw === "string") parts = raw.split(/[\n,]+/);
  else return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string") continue;
    const id = part.trim().slice(0, MAX_MODEL_ID_LENGTH);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_MODELS_PER_PROVIDER) break;
  }
  return out;
}

/** Key plausibility: trimmed 8..4096; strips ONE wrapping quote pair first. */
export function normalizeCustomKeyInput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let key = value.trim();
  if (key.length >= 2) {
    const first = key[0];
    const last = key[key.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      key = key.slice(1, -1).trim();
    }
  }
  if (key.length < 8 || key.length > 4096) return null;
  return key;
}

// ---------------------------------------------------------------------------
// CONFIG storage — Settings KV "ai.custom-providers" (sanitized on read)
// ---------------------------------------------------------------------------

function sanitizeConfig(raw: unknown): CustomProviderConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!isValidCustomSlug(o.slug)) return null;
  if (!isValidCustomName(o.name)) return null;
  if (!isCustomStyle(o.style)) return null;
  if (!isValidCustomBaseUrl(o.baseUrl)) return null;
  return {
    slug: o.slug,
    name: o.name.trim(),
    style: o.style,
    baseUrl: normalizeCustomBaseUrl(o.baseUrl),
    models: sanitizeCustomModels(o.models),
  };
}

/** Read + sanitize the whole provider list. Never throws (corrupt → []). */
export async function loadProviders(): Promise<CustomProviderConfig[]> {
  try {
    const row = await db.setting.findUnique({ where: { key: CUSTOM_PROVIDERS_KV_KEY } });
    if (!row) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out: CustomProviderConfig[] = [];
    const seen = new Set<string>();
    for (const raw of parsed) {
      const cfg = sanitizeConfig(raw);
      if (!cfg || seen.has(cfg.slug)) continue;
      seen.add(cfg.slug);
      out.push(cfg);
      if (out.length >= MAX_PROVIDERS) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Persist the whole list. Throws on DB failure — callers map to KV_WRITE_FAILED. */
export async function saveProviders(configs: CustomProviderConfig[]): Promise<void> {
  const value = JSON.stringify(configs);
  await db.setting.upsert({
    where: { key: CUSTOM_PROVIDERS_KV_KEY },
    update: { value },
    create: { key: CUSTOM_PROVIDERS_KV_KEY, value },
  });
}

// ---------------------------------------------------------------------------
// KEY storage — Credential table, service "provider:<slug>", label "api-key"
// ---------------------------------------------------------------------------

export function customProviderService(slug: string): string {
  return `provider:${slug}`;
}

export async function storeCustomProviderKey(slug: string, key: string): Promise<{ keyId: string }> {
  const { keyId, cipher } = encryptSecret(key);
  await db.credential.upsert({
    where: {
      service_label: { service: customProviderService(slug), label: CUSTOM_PROVIDER_KEY_LABEL },
    },
    create: {
      service: customProviderService(slug),
      label: CUSTOM_PROVIDER_KEY_LABEL,
      keyId,
      cipher,
    },
    update: { keyId, cipher },
  });
  return { keyId };
}

export async function clearCustomProviderKey(slug: string): Promise<number> {
  const res = await db.credential.deleteMany({
    where: { service: customProviderService(slug), label: CUSTOM_PROVIDER_KEY_LABEL },
  });
  return res.count;
}

/** Removes the key regardless of label — used by provider DELETE (idempotent). */
export async function clearAllCustomProviderCredentials(slug: string): Promise<number> {
  const res = await db.credential.deleteMany({
    where: { service: customProviderService(slug) },
  });
  return res.count;
}

// ---------------------------------------------------------------------------
// resolveCustomProvider — config + transient key (registered for redaction)
// ---------------------------------------------------------------------------

export type ResolvedCustomProvider = {
  config: CustomProviderConfig | null;
  key: string | null;
  maskedKey: string | null;
  keyUpdatedAt: string | null;
};

export async function resolveCustomProvider(slug: string): Promise<ResolvedCustomProvider> {
  const config = (await loadProviders()).find((p) => p.slug === slug) ?? null;
  let key: string | null = null;
  let maskedKey: string | null = null;
  let keyUpdatedAt: string | null = null;
  const row = await db.credential.findUnique({
    where: {
      service_label: { service: customProviderService(slug), label: CUSTOM_PROVIDER_KEY_LABEL },
    },
  });
  if (row) {
    try {
      key = decryptSecret(row.cipher);
      maskedKey = maskSecret(key);
      keyUpdatedAt = row.updatedAt.toISOString();
      // P7: any error string that ever carries this plaintext is scrubbed.
      registerSecretForRedaction(key);
    } catch {
      // Unreadable vault entry — treat as absent, honestly.
      key = null;
      maskedKey = null;
    }
  }
  return { config, key, maskedKey, keyUpdatedAt };
}

// ---------------------------------------------------------------------------
// Typed probe — GET {base}/models (openai) | GET {base}/v1/models (anthropic)
// ---------------------------------------------------------------------------

export type CustomProbeFailureCode =
  | "NOT_CONFIGURED"
  | "NETWORK_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "BAD_RESPONSE";

export type CustomProviderProbe =
  | { ok: true; httpStatus: number; models: string[] }
  // R19-a additive `circuit` field: present when the breaker answered instead
  // of the upstream (no network call was made).
  | { ok: false; code: CustomProbeFailureCode; httpStatus: number | null; message: string; circuit?: "open" };

// ---------------------------------------------------------------------------
// R19-a — circuit class mapping (custom taxonomy ⇄ breaker classes)
// ---------------------------------------------------------------------------

/** Custom failure code → breaker error class (same semantics as today's
 *  chat-failure mapping in client.ts: UNAUTHORIZED is the key-rejection
 *  class; NETWORK_ERROR/FORBIDDEN are transport, never key errors). */
function circuitClassForCustomCode(code: string): string {
  switch (code) {
    case "UNAUTHORIZED":
      return "KEY_REJECTED";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "NETWORK_ERROR":
    case "FORBIDDEN":
      return "UNREACHABLE_FROM_SANDBOX";
    case "BAD_RESPONSE":
      return "BAD_RESPONSE";
    case "NO_KEY":
      return "NO_KEY";
    default:
      // NOT_CONFIGURED / BAD_INPUT never reach the breaker (input problems).
      return "BAD_INPUT";
  }
}

/** Breaker class → custom CHAT failure code (for circuit-open chat results). */
function chatCodeForCircuitClass(cls: string): CustomChatFailureCode {
  switch (cls) {
    case "KEY_REJECTED":
      return "UNAUTHORIZED";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "UNREACHABLE_FROM_SANDBOX":
      return "NETWORK_ERROR";
    case "NO_KEY":
      return "NO_KEY";
    default:
      return "BAD_RESPONSE";
  }
}

/** Breaker class → custom PROBE failure code. null = the class never blocks a
 *  probe (NO_KEY: a keyless probe is a legitimate measurement; unknown classes
 *  are treated as keyless config gaps rather than blocking diagnostics). */
function probeCodeForCircuitClass(cls: string | null): CustomProbeFailureCode | null {
  switch (cls) {
    case "KEY_REJECTED":
      return "UNAUTHORIZED";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "UNREACHABLE_FROM_SANDBOX":
      return "NETWORK_ERROR";
    case "BAD_RESPONSE":
      return "BAD_RESPONSE";
    default:
      return null;
  }
}

/** Circuit-key helper for a custom provider slug. */
function customCircuitKey(slug: string): CircuitKey {
  return `custom:${slug}`;
}

/** Models list request per style. Both answer {data:[{id}]} when healthy. */
function probeTargetUrl(style: CustomProviderStyle, baseUrl: string): string {
  const base = normalizeCustomBaseUrl(baseUrl);
  return style === "anthropic" ? `${base}/v1/models` : `${base}/models`;
}

function probeHeaders(style: CustomProviderStyle, key: string | null): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (style === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (key) headers["x-api-key"] = key;
  } else if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

function parseModelListPayload(text: string): string[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { data?: unknown }).data)
      ? ((data as { data: unknown[] }).data as unknown[])
      : null;
  if (!list) return null;
  // R17: accept the common id-field variants. OpenAI-style rows carry `id`;
  // [MEASURED] aihubmix.com rows carry `model_id` (+ human `model_name`).
  // First non-empty string wins per row; duplicates dropped; order preserved.
  const ids = list
    .map((m) => {
      const o = (m ?? {}) as Record<string, unknown>;
      if (typeof o.id === "string" && o.id.trim()) return o.id.trim();
      if (typeof o.model_id === "string" && o.model_id.trim()) return o.model_id.trim();
      if (typeof o.model === "string" && o.model.trim()) return o.model.trim();
      if (typeof o.name === "string" && o.name.trim()) return o.name.trim();
      return null;
    })
    .filter((id): id is string => id !== null);
  return [...new Set(ids)];
}

/**
 * Probe with or without a key — both are honest measurements. Without a key
 * the upstream's 401 IS the honest answer ("this endpoint demands a key").
 * Bodies on failure are truncated + scrubbed against the key (P7). 8s timeout.
 *
 * Task 17-b: egress-aware exactly like chatCompleteCustom — the probe follows
 * routeFor("custom-providers", readRoutingMap()) (falls back to "default"):
 * "direct" keeps the plain sandbox
 * fetch, "proxy" goes through the Webshare pool (2 proxies, buffered). A
 * WAF-blocked host (measured: sandbox egress can 403/timeout where the pool
 * passes) is therefore still measurable. Transport/pool failures return
 * NETWORK_ERROR — NEVER UNAUTHORIZED (transport is not auth). The probe RESULT
 * shape is unchanged.
 *
 * R19-a circuit: when the provider's breaker is open (chat/probe failures)
 * this returns the TYPED failure with circuit:"open" WITHOUT a network call —
 * automated retries must not hammer a fragile-limit upstream. A caller who
 * deliberately wants a live measurement (manual probe button) passes
 * {force:true}. Probe outcomes feed the same breaker: success closes it (a
 * successful forced probe acts as the half-open trial), failure re-opens it.
 */
export async function probeCustomProvider(
  slug: string,
  opts: { force?: boolean } = {},
): Promise<CustomProviderProbe> {
  const circuitKey = customCircuitKey(slug);

  if (opts.force !== true) {
    const circuit = checkCircuit(circuitKey);
    const probeCode = probeCodeForCircuitClass(circuit.lastErrorClass);
    if (circuit.open && probeCode !== null) {
      const secs = Math.max(1, Math.ceil(circuit.retryInMs / 1000));
      return {
        ok: false,
        code: probeCode,
        httpStatus: null,
        message: `circuit open — provider "${slug}" skipped for ${secs}s after ${circuit.lastErrorClass} at ${circuit.lastErrorAt ?? "unknown time"}; no network call made (pass {force:true} for a deliberate live probe)`,
        circuit: "open",
      };
    }
  }

  const result = await probeCustomProviderLive(slug);
  if (result.ok) {
    recordCircuitSuccess(circuitKey);
  } else if (result.code !== "NOT_CONFIGURED") {
    recordCircuitFailure(circuitKey, circuitClassForCustomCode(result.code));
  }
  return result;
}

/** The live probe (pre-R19-a probeCustomProvider body, unchanged behavior). */
async function probeCustomProviderLive(slug: string): Promise<CustomProviderProbe> {
  const { config, key } = await resolveCustomProvider(slug);
  if (!config) {
    return { ok: false, code: "NOT_CONFIGURED", httpStatus: null, message: "provider config not found" };
  }

  const host = customProviderHost(config.baseUrl);
  const url = probeTargetUrl(config.style, config.baseUrl);
  const headers = probeHeaders(config.style, key);

  // Egress routing — same conventions as chatCompleteCustom (resolved once).
  const mode = routeFor(EGRESS_CUSTOM_PROVIDERS_KEY, await readRoutingMap());

  let status: number;
  let bodyText: string;

  if (mode === "proxy") {
    const pool = await loadEgressPool();
    if (!pool.ok) {
      return {
        ok: false,
        code: "NETWORK_ERROR",
        httpStatus: null,
        message: `egress proxy pool unavailable for the ${host} probe (${pool.code}) — configure the Webshare connector or set egress.routing default back to direct`,
      };
    }
    const candidates = pickProxies(pool.pool, CUSTOM_MAX_PROXY_ATTEMPTS);
    let answered: { status: number; bodyText: string } | null = null;
    let lastCode: string | null = null;
    for (const proxy of candidates) {
      const r = await proxiedFetch(url, { method: "GET", headers }, { proxy, timeoutMs: CUSTOM_PROBE_TIMEOUT_MS });
      if ("code" in r) {
        lastCode = r.code; // proxy/transport failure — try the next pool proxy
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
    status = answered.status;
    bodyText = answered.bodyText;
  } else {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(CUSTOM_PROBE_TIMEOUT_MS),
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
          ? `${host} did not respond within ${CUSTOM_PROBE_TIMEOUT_MS / 1000}s (GET ${probeTargetUrl(config.style, "")})`
          : `network error reaching ${host} (${causeCode})`,
      };
    }
    status = res.status;
    bodyText = await res.text().catch(() => "");
  }

  // Scrubs the live key out of any snippet and caps the length (P7).
  const scrub = (text: string): string => {
    let out = text;
    if (key && out.includes(key)) out = out.split(key).join("[filtered]");
    return out.slice(0, 200);
  };

  if (status === 401) {
    return {
      ok: false,
      code: "UNAUTHORIZED",
      httpStatus: 401,
      message: key
        ? `${host} rejected the key (HTTP 401)`
        : `${host} answered HTTP 401 — this endpoint demands a key and none is stored yet`,
    };
  }
  if (status === 403) {
    return { ok: false, code: "FORBIDDEN", httpStatus: 403, message: `${host} refused access (HTTP 403) — key lacks access or a WAF is in the way` };
  }
  if (status === 429) {
    return { ok: false, code: "RATE_LIMITED", httpStatus: 429, message: `${host} rate-limited the probe (HTTP 429)` };
  }

  if (status < 200 || status >= 300) {
    return {
      ok: false,
      code: "BAD_RESPONSE",
      httpStatus: status,
      message: `${host} answered HTTP ${status}${bodyText ? `: ${scrub(bodyText)}` : ""}`,
    };
  }

  const models = parseModelListPayload(bodyText);
  if (!models) {
    return { ok: false, code: "BAD_RESPONSE", httpStatus: status, message: `${host} returned a non-JSON or unrecognized models payload` };
  }

  return { ok: true, httpStatus: status, models };
}

// ---------------------------------------------------------------------------
// chatCompleteCustom — non-streaming, egress-aware
// ---------------------------------------------------------------------------

export type CustomChatFailureCode =
  | "NOT_CONFIGURED"
  | "NO_KEY"
  | "BAD_INPUT"
  | "NETWORK_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "BAD_RESPONSE";

export type CustomChatMessage = { role: string; content: string };

export type CustomChatUsage = { prompt: number | null; completion: number | null; total: number | null };

export type CustomChatResult =
  | {
      ok: true;
      content: string;
      model: string;
      httpStatus: number;
      usage: CustomChatUsage | null;
      latencyMs: number;
      egress: "direct" | "proxy";
    }
  | { ok: false; code: CustomChatFailureCode; httpStatus: number | null; message: string };

type CustomUsageTap = {
  slug: string;
  model: string;
  ok: boolean;
  latencyMs: number | null;
  /** Static egress mode actually used; absent when no transport ran (R19-a
   *  circuit-open rows honestly carry no egress — nothing was sent). */
  egress?: "direct" | "proxy";
  /** Static failure code only — never content, never key material. */
  error?: string;
  /** R19-a: set when the attempt was rejected by the circuit breaker before
   *  any network call — meta.circuit "open" keeps the telemetry truthful. */
  circuit?: "open";
};

/** UsageEvent kind:"llm" with static meta only (source "custom:<slug>"). */
async function recordCustomUsage(tap: CustomUsageTap): Promise<void> {
  try {
    const meta: Record<string, unknown> = {
      source: `custom:${tap.slug}`,
    };
    if (tap.egress) meta.egress = tap.egress;
    if (tap.error) meta.error = tap.error;
    if (tap.circuit) meta.circuit = tap.circuit;
    let metaJson = "{}";
    try {
      metaJson = redactSecrets(JSON.stringify(meta)).slice(0, 2048) || "{}";
    } catch {
      metaJson = "{}";
    }
    await db.usageEvent.create({
      data: {
        kind: "llm",
        model: tap.model.slice(0, 128),
        ok: tap.ok,
        latencyMs: tap.latencyMs ?? undefined,
        meta: metaJson,
      },
    });
  } catch {
    // best-effort — telemetry must never break the call
  }
}

function validMessages(messages: unknown): messages is CustomChatMessage[] {
  return (
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.every(
      (m) =>
        m !== null &&
        typeof m === "object" &&
        typeof (m as { role?: unknown }).role === "string" &&
        typeof (m as { content?: unknown }).content === "string" &&
        ((m as { role: string }).role === "system" ||
          (m as { role: string }).role === "user" ||
          (m as { role: string }).role === "assistant"),
    )
  );
}

/** OpenAI-shape: choices[0].message.content (+ usage). */
function parseOpenAiChatPayload(text: string): { content: string | null; usage: CustomChatUsage | null } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { content: null, usage: null };
  }
  const o = (data ?? {}) as Record<string, unknown>;
  const choices = Array.isArray(o.choices) ? o.choices : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (first.message ?? {}) as Record<string, unknown>;
  const content = typeof message.content === "string" ? message.content : null;

  let usage: CustomChatUsage | null = null;
  const u = o.usage as Record<string, unknown> | null;
  if (u && typeof u === "object") {
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    usage = { prompt: num(u.prompt_tokens), completion: num(u.completion_tokens), total: num(u.total_tokens) };
  }
  return { content, usage };
}

/** Anthropic-shape: content[] blocks → join .text (+ input/output_tokens). */
function parseAnthropicChatPayload(text: string): { content: string | null; usage: CustomChatUsage | null } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { content: null, usage: null };
  }
  const o = (data ?? {}) as Record<string, unknown>;
  const blocks = Array.isArray(o.content) ? o.content : [];
  const parts = blocks
    .map((b) => {
      const blk = (b ?? {}) as Record<string, unknown>;
      return typeof blk.text === "string" ? blk.text : null;
    })
    .filter((t): t is string => t !== null);
  const content = parts.length > 0 ? parts.join("") : null;

  let usage: CustomChatUsage | null = null;
  const u = o.usage as Record<string, unknown> | null;
  if (u && typeof u === "object") {
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    usage = { prompt: num(u.input_tokens), completion: num(u.output_tokens), total: null };
  }
  return { content, usage };
}

/**
 * Non-streaming completion against a custom provider. Egress-aware
 * (routeFor("custom-providers") → "default" fallback). 60s timeout. Transport/pool failures are
 * NETWORK_ERROR — NEVER UNAUTHORIZED (only an upstream-answered 401 is).
 *
 * R19-a circuit: the breaker (key "custom:<slug>") is checked FIRST — before
 * any credential resolution or network call. A circuit-open call fails fast
 * and still writes exactly ONE honest UsageEvent row (meta.error = the
 * RECORDED breaker class, meta.circuit "open", no egress — nothing was sent).
 */
export async function chatCompleteCustom(
  slug: string,
  messages: CustomChatMessage[],
  opts: { model?: string; temperature?: number; maxTokens?: number; timeoutMs?: number } = {},
): Promise<CustomChatResult> {
  const started = Date.now();
  const circuitKey = customCircuitKey(slug);

  // R19-a: circuit-open → fail fast (no key decrypt, no network). A config-only
  // read (local DB) resolves the model id so the usage row stays honest.
  const circuit = checkCircuit(circuitKey);
  if (circuit.open) {
    const cls = circuit.lastErrorClass ?? "UNKNOWN";
    const cfg = (await loadProviders()).find((p) => p.slug === slug) ?? null;
    const model = ((opts.model ?? cfg?.models[0] ?? "unknown").trim() || "unknown").slice(0, 128);
    const secs = Math.max(1, Math.ceil(circuit.retryInMs / 1000));
    await recordCustomUsage({
      slug,
      model,
      ok: false,
      latencyMs: Date.now() - started,
      error: cls,
      circuit: "open",
    });
    return {
      ok: false,
      code: chatCodeForCircuitClass(cls),
      httpStatus: null,
      message: `circuit open — "${cfg?.name ?? slug}" skipped for ${secs}s after ${cls} at ${circuit.lastErrorAt ?? "unknown time"}; no network call made`,
    };
  }

  const { config, key } = await resolveCustomProvider(slug);
  if (!config) {
    // Input problem, not provider health — never recorded to the breaker.
    return { ok: false, code: "NOT_CONFIGURED", httpStatus: null, message: "provider config not found" };
  }
  if (!key) {
    // Config gap (no key stored) — recorded per the R19-a class mapping so a
    // keyless chat storm cannot spam the resolution path either.
    recordCircuitFailure(circuitKey, "NO_KEY");
    return { ok: false, code: "NO_KEY", httpStatus: null, message: `no API key stored for "${config.name}" — add one in Connectors` };
  }
  if (!validMessages(messages)) {
    // Input problem, not provider health — never recorded to the breaker.
    return { ok: false, code: "BAD_INPUT", httpStatus: null, message: "messages must be a non-empty array of {role, content} with system/user/assistant roles" };
  }

  const model = (opts.model ?? config.models[0] ?? "").trim();
  if (!model) {
    return { ok: false, code: "BAD_INPUT", httpStatus: null, message: `no model specified and "${config.name}" has no default model in its config — add one` };
  }

  const timeoutMs = opts.timeoutMs ?? CUSTOM_CHAT_TIMEOUT_MS;
  const host = customProviderHost(config.baseUrl);
  const base = normalizeCustomBaseUrl(config.baseUrl);

  // Request body + headers per style.
  let url: string;
  let headers: Record<string, string>;
  let body: string;
  if (config.style === "anthropic") {
    const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
    const rest = messages.filter((m) => m.role !== "system");
    url = `${base}/v1/messages`;
    headers = {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    };
    body = JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 4096, // Anthropic: max_tokens REQUIRED
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
      messages: rest.map((m) => ({ role: m.role, content: m.content })),
    });
  } else {
    url = `${base}/chat/completions`;
    headers = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    };
    body = JSON.stringify({
      model,
      messages,
      stream: false,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    });
  }

  // Egress routing (task 13-b conventions): resolved once per call.
  const routingMap = await readRoutingMap();
  const mode = routeFor(EGRESS_CUSTOM_PROVIDERS_KEY, routingMap);

  const recordFailure = async (
    code: CustomChatFailureCode,
    httpStatus: number | null,
    message: string,
  ): Promise<CustomChatResult> => {
    recordCircuitFailure(circuitKey, circuitClassForCustomCode(code)); // R19-a
    await recordCustomUsage({
      slug,
      model,
      ok: false,
      latencyMs: Date.now() - started,
      egress: mode,
      error: code,
    });
    return { ok: false, code, httpStatus, message };
  };

  let status: number;
  let bodyText: string;
  let via: "direct" | EgressTransportName;

  if (mode === "proxy") {
    const pool = await loadEgressPool();
    if (!pool.ok) {
      return recordFailure(
        "NETWORK_ERROR",
        null,
        `egress proxy pool unavailable for the "${config.name}" call (${pool.code}) — configure the Webshare connector or set egress.routing default back to direct`,
      );
    }
    const candidates = pickProxies(pool.pool, CUSTOM_MAX_PROXY_ATTEMPTS);
    let lastCode: string | null = null;
    let answered: { status: number; bodyText: string; via: EgressTransportName } | null = null;
    for (const proxy of candidates) {
      const r = await proxiedFetch(url, { method: "POST", headers, body }, { proxy, timeoutMs });
      if ("code" in r) {
        lastCode = r.code; // proxy/transport failure — never a key error
        continue;
      }
      answered = { status: r.status, bodyText: r.bodyText, via: r.via };
      break;
    }
    if (!answered) {
      return recordFailure(
        "NETWORK_ERROR",
        null,
        `"${config.name}" call could not be completed through the egress proxy pool (${lastCode ?? "PROXY_FAILED"}) — proxy/transport failure, never a key error`,
      );
    }
    status = answered.status;
    bodyText = answered.bodyText;
    via = answered.via;
  } else {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      const timedOut = name === "TimeoutError" || name === "AbortError";
      return recordFailure(
        "NETWORK_ERROR",
        null,
        timedOut
          ? `${host} did not respond within ${Math.round(timeoutMs / 1000)}s calling model "${model}"`
          : `network error reaching ${host} calling model "${model}"`,
      );
    }
    status = res.status;
    bodyText = await res.text().catch(() => "");
    via = "direct";
  }

  const scrub = (text: string): string => {
    let out = text;
    if (out.includes(key)) out = out.split(key).join("[filtered]");
    return out.slice(0, 200);
  };

  if (status === 401) {
    return recordFailure("UNAUTHORIZED", 401, `${host} rejected the key (HTTP 401) calling model "${model}"`);
  }
  if (status === 403) {
    return recordFailure("FORBIDDEN", 403, `${host} refused access (HTTP 403) — key lacks access or a WAF is in the way`);
  }
  if (status === 429) {
    return recordFailure("RATE_LIMITED", 429, `${host} rate-limited the call (HTTP 429)`);
  }
  if (status < 200 || status >= 300) {
    // Static prefix + scrubbed, truncated snippet — never a raw body echo.
    return recordFailure(
      "BAD_RESPONSE",
      status,
      `${host} answered HTTP ${status} calling model "${model}"${bodyText ? `: ${scrub(bodyText)}` : ""}`,
    );
  }

  const parsed =
    config.style === "anthropic" ? parseAnthropicChatPayload(bodyText) : parseOpenAiChatPayload(bodyText);
  if (parsed.content === null) {
    return recordFailure(
      "BAD_RESPONSE",
      status,
      `${host} returned an unrecognized ${config.style === "anthropic" ? "Anthropic" : "OpenAI"}-shape completion payload for model "${model}"`,
    );
  }

  const latencyMs = Date.now() - started;
  recordCircuitSuccess(circuitKey); // R19-a: closes the breaker fully
  await recordCustomUsage({ slug, model, ok: true, latencyMs, egress: mode });

  return { ok: true, content: parsed.content, model, httpStatus: status, usage: parsed.usage, latencyMs, egress: mode };
}
