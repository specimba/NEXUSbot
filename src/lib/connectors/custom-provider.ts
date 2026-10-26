import { db } from "@/lib/db";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";

/**
 * NEXUS OS — owner-defined brain providers beyond Vyce/Groq.
 *
 * The owner asked (explicitly, after finding it missing) for a custom
 * OpenAI-compatible OR Anthropic-compatible provider entry: name, protocol,
 * endpoint, model, key. This module is the storage + validation + probe layer;
 * src/lib/ai/client.ts consumes resolveCustomProvider() for chat calls.
 *
 * Protocols:
 *   "openai"    → POST {base}/chat/completions, Authorization: Bearer <key>
 *   "anthropic" → POST {base}/v1/messages, x-api-key: <key>,
 *                  anthropic-version: 2023-06-01
 *
 * Endpoint normalization: the owner may paste the base with or without the
 * trailing /v1 (OpenAI-style gateways). normalizeCustomBaseUrl() keeps the
 * URL exactly as pasted minus the trailing slash; joinProviderUrl() appends
 * the right path per protocol, avoiding a doubled /v1:
 *   openai:    base ends with /v1 → /models | /chat/completions
 *              otherwise          → /v1/models | /v1/chat/completions
 *   anthropic: base ends with /v1 → /models | /messages
 *              otherwise          → /v1/models | /v1/messages
 *
 * P7: the key is encrypted with the same AES-256-GCM envelope as the vault
 * (crypto.ts). It is decrypted transiently for probe/use/masking only — never
 * logged, never echoed, never embedded into an Error message. Probes and API
 * responses carry masked previews + static verdicts only.
 */

export const CUSTOM_PROTOCOLS = ["openai", "anthropic"] as const;
export type CustomProtocol = (typeof CUSTOM_PROTOCOLS)[number];

export const MAX_PROVIDER_MODELS = 100;

export type CustomProviderRow = {
  id: string;
  name: string;
  protocol: CustomProtocol;
  baseUrl: string;
  model: string;
  models: string[];
  enabled: boolean;
  keyPresent: boolean;
  keyId: string;
  maskedKey: string | null;
  lastProbeAt: string | null;
  lastProbeOk: boolean | null;
  lastProbeDetail: string;
  createdAt: string;
  updatedAt: string;
};

export function isCustomProtocol(v: unknown): v is CustomProtocol {
  return typeof v === "string" && (CUSTOM_PROTOCOLS as readonly string[]).includes(v);
}

export function isValidCustomBaseUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const trimmed = v.trim();
  if (trimmed.length < 8 || trimmed.length > 512) return false;
  try {
    const u = new URL(trimmed);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function normalizeCustomBaseUrl(v: string): string {
  return v.trim().replace(/\/+$/, "");
}

/** Path join with /v1 de-duplication (see module docs). */
export function joinProviderUrl(baseUrl: string, _protocol: CustomProtocol, path: string): string {
  const base = normalizeCustomBaseUrl(baseUrl);
  const needsV1 = path === "models" || path === "chat/completions" || path === "messages";
  if (needsV1 && !/\/v1$/.test(base)) return `${base}/v1/${path}`;
  return `${base}/${path}`;
}

export function isPlausibleProviderKey(key: string): boolean {
  return key.length >= 8 && key.length <= 4096;
}

/** UI-level guard parity with the Vyce card: a SHA-256 hex fingerprint is never a key. */
export function looksLikeSha256Fingerprint(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value.trim());
}

// --- batch model list (task C1) ---------------------------------------------
// `models` is a JSON string column holding ALL model ids; `model` stays the
// default (what chatCompleteCustom uses when the caller passes no model).
// Invariant kept by every writer: `model` ∈ models (when models is non-empty).

/** One model id: trimmed, no whitespace runs, 1–128 chars, no control chars. */
export function sanitizeModelId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, "");
  if (s.length < 1 || s.length > 128) return null;
  if (/\p{C}/u.test(s)) return null;
  return s;
}

/** Tolerant input → deduped, ordered model id list (max 100). Unknown junk is dropped. */
export function sanitizeModelList(input: unknown): string[] {
  const arr = Array.isArray(input) ? input : [];
  const out: string[] = [];
  for (const item of arr) {
    const id = sanitizeModelId(item);
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= MAX_PROVIDER_MODELS) break;
  }
  return out;
}

/** DB column (JSON string) → list. Corrupt JSON parses to [] (honest empty, row stays usable). */
export function parseProviderModels(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? sanitizeModelList(parsed) : [];
  } catch {
    return [];
  }
}

export function serializeProviderModels(list: string[]): string {
  return JSON.stringify(sanitizeModelList(list));
}

/** Pick the stored default from a batch: explicit default if present, else the first. */
export function resolveDefaultModel(models: string[], explicitDefault: unknown): string {
  const d = sanitizeModelId(explicitDefault);
  if (d && models.includes(d)) return d;
  return models[0] ?? "";
}

function toRow(r: {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  model: string;
  models: string;
  enabled: boolean;
  keyId: string;
  keyCipher: string;
  lastProbeAt: Date | null;
  lastProbeOk: boolean | null;
  lastProbeDetail: string;
  createdAt: Date;
  updatedAt: Date;
}): CustomProviderRow {
  let masked: string | null = null;
  if (r.keyCipher) {
    try {
      masked = maskSecret(decryptSecret(r.keyCipher));
    } catch {
      masked = "⚠ unreadable";
    }
  }
  return {
    id: r.id,
    name: r.name,
    protocol: isCustomProtocol(r.protocol) ? r.protocol : "openai",
    baseUrl: r.baseUrl,
    model: r.model,
    models: parseProviderModels(r.models),
    enabled: r.enabled,
    keyPresent: r.keyCipher.length > 0,
    keyId: r.keyId,
    maskedKey: masked,
    lastProbeAt: r.lastProbeAt ? r.lastProbeAt.toISOString() : null,
    lastProbeOk: r.lastProbeOk,
    lastProbeDetail: r.lastProbeDetail,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listCustomProviders(): Promise<CustomProviderRow[]> {
  const rows = await db.customProvider.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map(toRow);
}

export async function getCustomProviderRow(id: string) {
  return db.customProvider.findUnique({ where: { id } });
}

/** Decrypted credentials for brain calls — transient, never leaves the process. */
export type ResolvedCustomProvider = {
  id: string;
  name: string;
  protocol: CustomProtocol;
  baseUrl: string;
  model: string;
  key: string | null; // null when the row has no key stored yet
};

export async function resolveCustomProvider(id: string): Promise<ResolvedCustomProvider | null> {
  const r = await db.customProvider.findUnique({ where: { id } });
  if (!r) return null;
  let key: string | null = null;
  if (r.keyCipher) {
    try {
      key = decryptSecret(r.keyCipher);
    } catch {
      return null; // unreadable envelope — honest failure upstream
    }
  }
  return {
    id: r.id,
    name: r.name,
    protocol: isCustomProtocol(r.protocol) ? r.protocol : "openai",
    baseUrl: r.baseUrl,
    model: r.model,
    key,
  };
}

export type ProbeVerdict = { ok: boolean; code: string; detail: string };

/**
 * MEASURED probe: GET <models endpoint> with the stored key (or unauthenticated
 * when none stored — some gateways expose /models publicly; the verdict says
 * which). Static verdict strings only — never key material, never raw bodies.
 */
export async function probeCustomProvider(id: string): Promise<ProbeVerdict> {
  const r = await db.customProvider.findUnique({ where: { id } });
  if (!r) return { ok: false, code: "NOT_FOUND", detail: "Provider row not found." };

  let key: string | null = null;
  if (r.keyCipher) {
    try {
      key = decryptSecret(r.keyCipher);
    } catch {
      await db.customProvider.update({
        where: { id: r.id },
        data: { lastProbeAt: new Date(), lastProbeOk: false, lastProbeDetail: "VAULT_UNREADABLE: stored key could not be decrypted — re-save it." },
      });
      return { ok: false, code: "VAULT_UNREADABLE", detail: "Stored key could not be decrypted — re-save it." };
    }
  }

  const protocol: CustomProtocol = isCustomProtocol(r.protocol) ? r.protocol : "openai";
  const url = joinProviderUrl(r.baseUrl, protocol, "models");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (protocol === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (key) headers["x-api-key"] = key;
  } else if (key) {
    headers["Authorization"] = `Bearer ${key}`;
  }

  let status = 0;
  try {
    const res = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(8_000) });
    status = res.status;
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    const verdict: ProbeVerdict = {
      ok: false,
      code: timedOut ? "TIMEOUT" : "UNREACHABLE_FROM_SANDBOX",
      detail: timedOut
        ? "No answer within 8s — the endpoint may be down or egress-blocked."
        : "Network error before an HTTP answer (egress/DNS).",
    };
    await db.customProvider.update({
      where: { id: r.id },
      data: { lastProbeAt: new Date(), lastProbeOk: false, lastProbeDetail: `${verdict.code}: ${verdict.detail}` },
    });
    return verdict;
  }

  let verdict: ProbeVerdict;
  if (status === 200) {
    verdict = key
      ? { ok: true, code: "CONNECTED", detail: "GET models accepted the key (HTTP 200)." }
      : { ok: true, code: "CONNECTED_NO_KEY", detail: "GET models answered 200 without a key (public endpoint). Chat calls will still need a key." };
  } else if (status === 401) {
    verdict = {
      ok: false,
      code: "KEY_REJECTED",
      detail: key
        ? "HTTP 401 — the endpoint rejected the stored key. Paste the RAW key (a SHA-256 hash can never authenticate)."
        : "HTTP 401 — the endpoint requires a key; none is stored yet.",
    };
  } else if (status === 403) {
    verdict = { ok: false, code: "FORBIDDEN", detail: "HTTP 403 — edge/WAF refusal or key lacking access (never treated as a key verdict alone)." };
  } else if (status === 404) {
    verdict = { ok: false, code: "BAD_ENDPOINT", detail: "HTTP 404 — the models path does not exist there. Check the base URL (include or omit /v1 per the gateway's convention)." };
  } else if (status === 429) {
    verdict = { ok: false, code: "RATE_LIMITED", detail: "HTTP 429 — the endpoint asked to slow down." };
  } else {
    verdict = { ok: false, code: `HTTP_${status}`, detail: `HTTP ${status} — unexpected probe answer.` };
  }

  await db.customProvider.update({
    where: { id: r.id },
    data: { lastProbeAt: new Date(), lastProbeOk: verdict.ok, lastProbeDetail: `${verdict.code}: ${verdict.detail}` },
  });
  return verdict;
}

export async function storeProviderKey(id: string, key: string): Promise<{ keyId: string }> {
  const { keyId, cipher } = encryptSecret(key);
  await db.customProvider.update({ where: { id }, data: { keyId, keyCipher: cipher } });
  return { keyId };
}

// --- C1: gateway model discovery + per-model probes ---------------------------

function providerAuthHeaders(protocol: CustomProtocol, key: string | null): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (protocol === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (key) headers["x-api-key"] = key;
  } else if (key) {
    headers["Authorization"] = `Bearer ${key}`;
  }
  return headers;
}

/** Tolerant /models payload parser: OpenAI {data:[{id}]}, Anthropic {data:[{id}]}, {models:[…]}, bare arrays, string ids. */
export function parseModelsPayload(payload: unknown): string[] {
  const candidates: unknown[] = [];
  if (Array.isArray(payload)) candidates.push(payload);
  else if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.data)) candidates.push(obj.data);
    if (Array.isArray(obj.models)) candidates.push(obj.models);
  }
  const out: string[] = [];
  for (const list of candidates) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      let id: string | null = null;
      if (typeof item === "string") {
        id = sanitizeModelId(item);
      } else if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        id = sanitizeModelId(o.id ?? o.name ?? o.model);
      }
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

export type DiscoverResult =
  | { ok: true; models: string[]; truncated: boolean; keyUsed: boolean }
  | { ok: false; code: string; detail: string };

/**
 * Server-side GET {base}[/v1]/models — the panel backend proxies the call so
 * the browser never talks cross-origin to arbitrary gateways. P7: the key is
 * used transiently in headers only — never echoed, never logged, never part of
 * any error message.
 */
export async function discoverCustomModels(args: {
  baseUrl: string;
  protocol: CustomProtocol;
  key: string | null;
}): Promise<DiscoverResult> {
  const url = joinProviderUrl(args.baseUrl, args.protocol, "models");
  try {
    const res = await fetch(url, {
      headers: providerAuthHeaders(args.protocol, args.key),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const status = res.status;
    if (status === 401) {
      return {
        ok: false,
        code: "KEY_REJECTED",
        detail: args.key
          ? "HTTP 401 — the gateway rejected this key. Paste the RAW key (a SHA-256 hash can never authenticate)."
          : "HTTP 401 — the gateway requires a key; paste it above and retry.",
      };
    }
    if (status === 404) {
      return {
        ok: false,
        code: "BAD_ENDPOINT",
        detail: "HTTP 404 — no /models path there. Include or omit /v1 per the gateway's convention.",
      };
    }
    if (status === 403) {
      return { ok: false, code: "FORBIDDEN", detail: "HTTP 403 — edge/WAF refusal or key lacking access." };
    }
    if (status === 429) {
      return { ok: false, code: "RATE_LIMITED", detail: "HTTP 429 — the gateway asked to slow down." };
    }
    if (status !== 200) {
      return { ok: false, code: `HTTP_${status}`, detail: `HTTP ${status} — unexpected answer from the gateway.` };
    }
    const payload: unknown = await res.json().catch(() => null);
    const models = parseModelsPayload(payload);
    if (models.length === 0) {
      return {
        ok: false,
        code: "BAD_RESPONSE",
        detail: "HTTP 200 but no model ids found in the payload (expected an OpenAI-style {data:[{id}]} list).",
      };
    }
    const truncated = models.length > MAX_PROVIDER_MODELS;
    return { ok: true, models: models.slice(0, MAX_PROVIDER_MODELS), truncated, keyUsed: Boolean(args.key) };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return timedOut
      ? { ok: false, code: "TIMEOUT", detail: "No answer within 8s — the endpoint may be down or egress-blocked." }
      : { ok: false, code: "UNREACHABLE_FROM_SANDBOX", detail: "Network error before an HTTP answer (egress/DNS)." };
  }
}

export type ModelProbeVerdict = { model: string; ok: boolean; code: string; detail: string };

/**
 * MEASURED per-model probe: a minimal 1-token chat call through the gateway.
 * On save, up to the first 3 selected models are probed (batch-friendly);
 * verdicts are returned to the UI as per-model chips and are NOT persisted on
 * the row (the row keeps the endpoint probe verdict). Static verdict strings
 * only — never key material.
 */
export async function probeCustomProviderModel(id: string, model: string): Promise<ModelProbeVerdict> {
  const fail = (code: string, detail: string): ModelProbeVerdict => ({ model, ok: false, code, detail });
  const mid = sanitizeModelId(model);
  if (!mid) return fail("BAD_MODEL", "Model id is empty or malformed.");
  const r = await db.customProvider.findUnique({ where: { id } });
  if (!r) return fail("NOT_FOUND", "Provider row not found.");
  let key: string | null = null;
  if (r.keyCipher) {
    try {
      key = decryptSecret(r.keyCipher);
    } catch {
      return fail("VAULT_UNREADABLE", "Stored key could not be decrypted — re-save it.");
    }
  }
  const protocol: CustomProtocol = isCustomProtocol(r.protocol) ? r.protocol : "openai";
  const isOpenAi = protocol === "openai";
  const url = isOpenAi
    ? joinProviderUrl(r.baseUrl, protocol, "chat/completions")
    : joinProviderUrl(r.baseUrl, protocol, "messages");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...providerAuthHeaders(protocol, key),
  };
  const body = isOpenAi
    ? { model: mid, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }
    : { model: mid, max_tokens: 1, messages: [{ role: "user", content: "ping" }] };

  let status = 0;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    status = res.status;
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return timedOut
      ? fail("TIMEOUT", "No answer within 8s — the endpoint may be down or egress-blocked.")
      : fail("UNREACHABLE_FROM_SANDBOX", "Network error before an HTTP answer (egress/DNS).");
  }

  if (status === 200) return { model: mid, ok: true, code: "MODEL_OK", detail: "1-token chat call answered 200." };
  if (status === 401) return fail("KEY_REJECTED", "HTTP 401 — the gateway rejected the key for this call.");
  if (status === 404) return fail("MODEL_NOT_FOUND", "HTTP 404 — unknown model id or wrong chat path.");
  if (status === 400) return fail("MODEL_REJECTED", "HTTP 400 — the gateway rejected the probe (often an unknown model id).");
  if (status === 403) return fail("FORBIDDEN", "HTTP 403 — edge/WAF refusal or key lacking access to this model.");
  if (status === 429) return fail("RATE_LIMITED", "HTTP 429 — the gateway asked to slow down.");
  return fail(`HTTP_${status}`, `HTTP ${status} — unexpected probe answer.`);
}
