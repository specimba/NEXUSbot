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

export type CustomProviderRow = {
  id: string;
  name: string;
  protocol: CustomProtocol;
  baseUrl: string;
  model: string;
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

function toRow(r: {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  model: string;
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
