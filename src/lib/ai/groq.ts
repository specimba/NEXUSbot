import { db } from "@/lib/db";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";

/**
 * NEXUS OS — Groq provider slot (task 13-b). OpenAI-compatible LLM upstream at
 * https://api.groq.com/openai/v1.
 *
 * Egress reality [MEASURED 2026-10-23, this sandbox]:
 *   direct    → api.groq.com answers HTTP 403 {"error":{"message":"Forbidden"}}
 *               on EVERY path (WAF block of the sandbox egress IP). A 403 here is
 *               NEVER a key problem — the upstream never even evaluated the key.
 *   via proxy → the owner's Webshare pool bypasses the WAF (the same path then
 *               answers key-level 401/200 [MEASURED R12 via egress probe]).
 * The docs site is blocked too: console.groq.com/docs/models AND
 * console.groq.com/openapi/outputs → 403 {"error":{"message":"Forbidden"}}
 * [MEASURED this round] — so the static fallback model list below is
 * knowledge-based [INFERRED], never a live measurement.
 *
 * ONLY src/lib/ai/client.ts consumes this module — it is the brain's single
 * egress-aware, redaction-choke-point entry.
 *
 * P7 discipline (identical to connectors/vyce.ts): the key is decrypted
 * transiently in-process for use/masking only — never logged, never echoed,
 * never embedded into an Error message.
 */

export const GROQ_SERVICE = "groq";
export const GROQ_KEY_LABEL = "api-key";
export const DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const GROQ_TIMEOUT_MS = 8_000;

// ---------------------------------------------------------------------------
// Static fallback model catalog — docsSource "embedded-fallback"
// ---------------------------------------------------------------------------

/**
 * Conservative, well-known production model ids from Groq's public docs
 * ([INFERRED from knowledge; corroborates the R11 research round, worklog
 * 10-b]. NOT a live measurement — the docs/API hosts are WAF-blocked from this
 * sandbox [MEASURED 403, see header]). Consumers MUST label this list
 * "embedded-fallback" and never present it as measured. The live catalog, when
 * reachable (direct from an unblocked egress, or via the Webshare pool), always
 * supersedes this list.
 */
export const GROQ_STATIC_MODELS: readonly string[] = [
  "llama-3.1-8b-instant",
  "llama-3.3-70b-versatile",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3-32b",
  "moonshotai/kimi-k2-instruct",
  "deepseek-r1-distill-llama-70b",
  "groq/compound",
  "whisper-large-v3",
  "whisper-large-v3-turbo",
];

// ---------------------------------------------------------------------------
// Vault access (service "groq", label "api-key") — mirrors connectors/vyce.ts
// ---------------------------------------------------------------------------

export type GroqKeyLoad =
  | { ok: true; key: string; masked: string; keyId: string; updatedAt: string }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "unreadable" };

export async function loadGroqKey(): Promise<GroqKeyLoad> {
  const row = await db.credential.findUnique({
    where: { service_label: { service: GROQ_SERVICE, label: GROQ_KEY_LABEL } },
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

/** Shape check only — the live probe decides liveness honestly. */
export function isPlausibleGroqKey(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 8 && value.trim().length <= 4096;
}

export async function storeGroqKey(key: string): Promise<{ keyId: string }> {
  const { keyId, cipher } = encryptSecret(key.trim());
  await db.credential.upsert({
    where: { service_label: { service: GROQ_SERVICE, label: GROQ_KEY_LABEL } },
    create: { service: GROQ_SERVICE, label: GROQ_KEY_LABEL, keyId, cipher },
    update: { keyId, cipher },
  });
  return { keyId };
}

/** Removes the Groq vault config. Idempotent. */
export async function deleteGroqConfig(): Promise<number> {
  const res = await db.credential.deleteMany({ where: { service: GROQ_SERVICE } });
  return res.count;
}

// ---------------------------------------------------------------------------
// /models payload parsing (provider-agnostic OpenAI list shape)
// ---------------------------------------------------------------------------

/** Extracts model id strings from an OpenAI-style /models body; null = unrecognized. */
export function parseGroqModelsPayload(bodyText: string): string[] | null {
  let data: unknown;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { data?: unknown }).data)
      ? ((data as { data: unknown[] }).data as unknown[])
      : null;
  if (!list) return null;
  return list
    .map((m) => {
      const o = (m ?? {}) as Record<string, unknown>;
      return typeof o.id === "string" && o.id.length > 0 && o.id.length <= 128 ? o.id : null;
    })
    .filter((id): id is string => id !== null);
}
