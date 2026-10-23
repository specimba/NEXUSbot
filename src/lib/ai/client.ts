import { db } from "@/lib/db";
import { PrismaClient } from "@prisma/client";
import { createRequire } from "node:module";
import path from "node:path";
import { decryptSecret } from "@/lib/crypto";
import {
  DEFAULT_VYCE_BASE_URL,
  VYCE_ROLE_MODELS,
  VYCE_ROLES,
  isValidVyceBaseUrl,
  loadVyceBaseUrlOverride,
  loadVyceKey,
  normalizeVyceBaseUrl,
  type VyceRole,
} from "@/lib/connectors/vyce";
import { SUPABASE_MGMT_BASE, getMgmtPat, mgmtListProjects } from "@/lib/connectors/supabase";

/**
 * NEXUS OS — brain client (T-207). OpenAI-compatible client for the Vyce LLM
 * gateway (https://vyceai.com/v1 [MEASURED envelope], plus any owner-set base).
 *
 * ============================================================================
 * KEY HYGIENE — "the key must never leak at conversation chat" (implemented,
 * not promised). This module is the ONLY place brain key material is handled:
 *
 * 1. resolveVyceCredentials() decrypts key plaintext transiently, per call.
 *    It is held in local scope, passed only into the Authorization header,
 *    and never written to DB, logs, responses, or Error messages.
 * 2. Every secret the brain layer touches is ALSO registered (in-memory Set)
 *    for redaction via registerSecretForRedaction(); redactSecrets(text)
 *    replaces any occurrence with "[filtered]".
 * 3. redactSecrets() is applied by BrainError's constructor — the single choke
 *    point through which every failure path leaves this module — so even a
 *    hypothetical upstream echo of the key in an error string is scrubbed.
 * 4. Error MESSAGES are built from static strings + HTTP status + model id
 *    only. Upstream response BODIES are never included in brain errors.
 * 5. UsageEvent rows carry model/latency/tokens-if-reported/ok + static meta
 *    (error code, source, role) — NEVER prompt or response content.
 * 6. No console logging of key material exists in this module. None.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// Redaction core (P7 sanitizer)
// ---------------------------------------------------------------------------

const redactionSecrets = new Set<string>();
let vaultRedactionAt = 0;
const VAULT_REDACTION_TTL = 30_000;

/** Registers a plaintext for redaction. Values never leave this process. */
export function registerSecretForRedaction(value: string): void {
  if (typeof value === "string" && value.length >= 8) redactionSecrets.add(value);
}

/**
 * Best-effort refresh: pulls every vault credential plaintext into the
 * redaction set (transiently, TTL-throttled to once per 30s). The brain layer
 * typically only handles the Vyce key; this widens coverage to any vault
 * secret that could ever appear in a shared error string.
 */
export async function refreshRedactionList(): Promise<void> {
  const now = Date.now();
  if (now - vaultRedactionAt < VAULT_REDACTION_TTL) return;
  vaultRedactionAt = now;
  try {
    const rows = await db.credential.findMany({ select: { cipher: true } });
    for (const row of rows) {
      try {
        registerSecretForRedaction(decryptSecret(row.cipher));
      } catch {
        // unreadable credential — nothing to register
      }
    }
  } catch {
    // best-effort only
  }
}

/**
 * Scrubs any occurrence of registered secret material out of `text` and
 * returns the safe copy. Exported for every brain-layer throw/return path.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const secret of redactionSecrets) {
    if (out.includes(secret)) out = out.split(secret).join("[filtered]");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Typed errors — messages: static strings + http status + model id ONLY
// ---------------------------------------------------------------------------

export type BrainErrorCode =
  | "NO_KEY"
  | "KEY_REJECTED"
  | "UNREACHABLE_FROM_SANDBOX"
  | "RATE_LIMITED"
  | "BAD_RESPONSE"
  | "BAD_INPUT";

export class BrainError extends Error {
  readonly code: BrainErrorCode;
  readonly httpStatus: number | null;
  readonly model: string | null;

  constructor(
    code: BrainErrorCode,
    message: string,
    opts: { httpStatus?: number | null; model?: string | null } = {},
  ) {
    // P7 choke point: even a hypothetical key echo inside `message` is scrubbed
    // before the Error exists.
    super(redactSecrets(message));
    this.name = "BrainError";
    this.code = code;
    this.httpStatus = opts.httpStatus ?? null;
    this.model = opts.model ?? null;
  }
}

// ---------------------------------------------------------------------------
// Key resolution — vault → Supabase Edge-Function secret fallback → NO_KEY
// ---------------------------------------------------------------------------

export type VyceCredentials = {
  key: string;
  baseUrl: string;
  source: "vault" | "supabase-edge-secret";
};

function envVyceBaseUrl(): string | null {
  const raw = process.env.VYCE_BASE_URL?.trim();
  return raw && isValidVyceBaseUrl(raw) ? normalizeVyceBaseUrl(raw) : null;
}

/**
 * Supabase Edge-Function secret fallback: the owner stored VYCE_API_KEY
 * (+ VYCE_BASE_URL) as Edge Function secrets on the harness project. This
 * reads them server-side, transiently, via the stored Management PAT.
 * Values NEVER leave this function except through the return value, which
 * callers must treat per the hygiene rules above.
 */
export type VyceFallback =
  | { ok: true; key: string; baseUrl: string | null }
  | { ok: false; reason: string };

const FALLBACK_NOT_FOUND = "VYCE_API_KEY not found among Edge Function secrets";
let fallbackCache: { at: number; result: VyceFallback } | null = null;
const FALLBACK_TTL = 60_000;

async function readEdgeSecretValues(
  pat: string,
  projectRef: string,
  wanted: readonly string[],
): Promise<Map<string, string> | null> {
  try {
    const res = await fetch(`${SUPABASE_MGMT_BASE}/v1/projects/${encodeURIComponent(projectRef)}/secrets`, {
      method: "GET",
      headers: { Authorization: `Bearer ${pat}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data: unknown = await res.json().catch(() => null);
    if (!Array.isArray(data)) return null;
    const found = new Map<string, string>();
    for (const raw of data) {
      const o = (raw ?? {}) as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name : "";
      const value = typeof o.value === "string" ? o.value : "";
      if (wanted.includes(name) && value.length > 0) found.set(name, value);
    }
    return found;
  } catch {
    return null;
  }
}

export async function resolveVyceKeyFallback(): Promise<VyceFallback> {
  const now = Date.now();
  if (fallbackCache && now - fallbackCache.at < FALLBACK_TTL) return fallbackCache.result;

  const result = await (async (): Promise<VyceFallback> => {
    const pat = await getMgmtPat();
    if (!pat) {
      return { ok: false, reason: "supabase PAT not stored — connect the Supabase connector first" };
    }
    registerSecretForRedaction(pat);

    const projects = await mgmtListProjects(pat);
    if (!projects.ok) {
      return {
        ok: false,
        reason:
          projects.status === 401 || projects.status === 403
            ? "supabase PAT rejected by the Mgmt API"
            : "supabase Mgmt API unreachable from sandbox",
      };
    }
    if (projects.projects.length === 0) return { ok: false, reason: "no accessible supabase projects" };

    // Search the first few projects for the VYCE_API_KEY edge secret.
    for (const project of projects.projects.slice(0, 5)) {
      const found = await readEdgeSecretValues(pat, project.ref, ["VYCE_API_KEY", "VYCE_BASE_URL"]);
      if (found === null) continue; // project unreachable — try the next
      const key = found.get("VYCE_API_KEY");
      if (key && key.trim().length >= 8) {
        const baseUrlRaw = found.get("VYCE_BASE_URL")?.trim();
        return {
          ok: true,
          key: key.trim(),
          baseUrl:
            baseUrlRaw && isValidVyceBaseUrl(baseUrlRaw) ? normalizeVyceBaseUrl(baseUrlRaw) : null,
        };
      }
    }
    return { ok: false, reason: FALLBACK_NOT_FOUND };
  })();

  if (result.ok) registerSecretForRedaction(result.key);
  fallbackCache = { at: now, result };
  return result;
}

/** Resolution order: vault ("vyce"/"api") → Supabase edge-secret → null. */
export async function resolveVyceCredentials(): Promise<VyceCredentials | null> {
  void refreshRedactionList(); // fire-and-forget, TTL-throttled

  const vault = await loadVyceKey();
  if (vault.ok) {
    registerSecretForRedaction(vault.key);
    const override = await loadVyceBaseUrlOverride();
    return {
      key: vault.key,
      baseUrl: override ?? envVyceBaseUrl() ?? DEFAULT_VYCE_BASE_URL,
      source: "vault",
    };
  }

  const fb = await resolveVyceKeyFallback();
  if (fb.ok) {
    return { key: fb.key, baseUrl: fb.baseUrl ?? envVyceBaseUrl() ?? DEFAULT_VYCE_BASE_URL, source: "supabase-edge-secret" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Model registry — role → model over the six R11 tiers, overridable via the
// Settings KV key "ai.models" (JSON object role→model; invalid → defaults).
// ---------------------------------------------------------------------------

export type BrainRole = VyceRole;
export const BRAIN_ROLES = VYCE_ROLES;

const REGISTRY_TTL = 15_000;
let registryCache: { at: number; map: Record<BrainRole, string> } | null = null;

export async function getRoleModelMap(): Promise<Record<BrainRole, string>> {
  const now = Date.now();
  if (registryCache && now - registryCache.at < REGISTRY_TTL) return registryCache.map;
  const map: Record<BrainRole, string> = { ...VYCE_ROLE_MODELS };
  try {
    const row = await db.setting.findUnique({ where: { key: "ai.models" } });
    if (row?.value) {
      const parsed: unknown = JSON.parse(row.value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if ((BRAIN_ROLES as readonly string[]).includes(k) && typeof v === "string") {
            const id = v.trim();
            if (id.length > 0 && id.length <= 128) map[k as BrainRole] = id;
          }
        }
      }
    }
  } catch {
    // malformed override — defaults stand
  }
  registryCache = { at: now, map };
  return map;
}

async function resolveModel(roleOrModel: string): Promise<{ model: string; role: BrainRole | null }> {
  if ((BRAIN_ROLES as readonly string[]).includes(roleOrModel)) {
    const map = await getRoleModelMap();
    return { model: map[roleOrModel as BrainRole], role: roleOrModel as BrainRole };
  }
  if (!/^[A-Za-z0-9._:\-\/]{1,128}$/.test(roleOrModel)) {
    throw new BrainError("BAD_INPUT", "roleOrModel must be a known role or a safe model id");
  }
  return { model: roleOrModel, role: null };
}

// ---------------------------------------------------------------------------
// Usage ledger tap — counters only, NEVER prompt/response content (P7)
// ---------------------------------------------------------------------------

/**
 * Dev-server resilience for the additive UsageEvent model.
 *
 * The panel dev server caches its PrismaClient on globalThis; `bun run db:push`
 * that ADDS a model leaves that cached singleton without the new delegate
 * (`usageEvent`) until the process restarts. getUsageDb() reuses the healthy
 * singleton when it already knows the model; otherwise it rebinds ONCE with a
 * freshly constructed client (busting the CommonJS require cache for the
 * generated .prisma/client modules so the on-disk regenerated client is
 * loaded), and returns null when even that cannot see the model (honest 503
 * upstream — never a fake success; the pending restart resolves it).
 */
let usageRebindAttempted = false;

/** Re-require @prisma/client with the CJS cache entries dropped, so the
 * regenerated on-disk generated client is re-evaluated in this process. */
function loadFreshPrismaModule(): { PrismaClient: typeof PrismaClient } | null {
  try {
    const req = createRequire(path.join(process.cwd(), "package.json"));
    for (const id of ["@prisma/client", ".prisma/client", ".prisma/client/default"]) {
      try {
        const resolved = req.resolve(id) as string;
        delete req.cache[resolved];
      } catch {
        // not resolvable from this project — skip
      }
    }
    const mod = req("@prisma/client") as { PrismaClient?: typeof PrismaClient };
    return typeof mod?.PrismaClient === "function" ? { PrismaClient: mod.PrismaClient } : null;
  } catch {
    return null;
  }
}

export function getUsageDb(): PrismaClient | null {
  const g = globalThis as { prisma?: PrismaClient };
  const cached = g.prisma;
  if (cached && "usageEvent" in cached) return cached;
  if (cached && !usageRebindAttempted) {
    usageRebindAttempted = true;
    try {
      const Fresh = loadFreshPrismaModule()?.PrismaClient ?? PrismaClient;
      const fresh = new Fresh({ log: ["query"] });
      if ("usageEvent" in fresh) {
        void cached.$disconnect().catch(() => undefined);
        g.prisma = fresh;
        return fresh;
      }
    } catch {
      // fall through to the stale singleton
    }
  }
  if (db && "usageEvent" in db) return db;
  return null;
}

type BrainUsageTap = {
  model: string;
  ok: boolean;
  latencyMs: number | null;
  tokens?: { prompt: number | null; completion: number | null } | null;
  error?: string; // static code only
  source?: VyceCredentials["source"];
  role?: BrainRole | null;
  streamed?: boolean;
};

async function recordBrainUsage(tap: BrainUsageTap): Promise<void> {
  const pdb = getUsageDb();
  if (!pdb) return; // schema not live in this process yet — restart pending
  try {
    const meta: Record<string, unknown> = {};
    if (tap.error) meta.error = tap.error;
    if (tap.source) meta.source = tap.source;
    if (tap.role) meta.role = tap.role;
    if (tap.streamed) meta.streamed = true;
    if (tap.tokens) {
      if (tap.tokens.prompt !== null) meta.promptTokens = tap.tokens.prompt;
      if (tap.tokens.completion !== null) meta.completionTokens = tap.tokens.completion;
    }
    let metaJson = "{}";
    try {
      metaJson = redactSecrets(JSON.stringify(meta)).slice(0, 2048) || "{}";
    } catch {
      metaJson = "{}";
    }
    await pdb.usageEvent.create({
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

// ---------------------------------------------------------------------------
// chatComplete + streamComplete
// ---------------------------------------------------------------------------

export type BrainMessage = { role: string; content: string };

export type ChatCompleteOpts = {
  temperature?: number;
  maxTokens?: number;
  /** Per-call timeout (ms). Default 45s. */
  timeoutMs?: number;
  /** Extra OpenAI-compatible body fields (tools, response_format, …). */
  extraBody?: Record<string, unknown>;
  /** Optional static scalar fields for the UsageEvent meta (never content). */
  trace?: Record<string, string | number | boolean>;
};

export type ChatCompletionResult = {
  model: string;
  content: string;
  latencyMs: number;
  usage: { prompt: number | null; completion: number | null; total: number | null } | null;
};

const DEFAULT_CHAT_TIMEOUT_MS = 45_000;

function mapHttpFailure(status: number, model: string): BrainError {
  if (status === 401) {
    // 401 NEVER fails over — the key is wrong and must be surfaced as-is.
    return new BrainError("KEY_REJECTED", `Vyce rejected the key (HTTP 401) — model "${model}" was not called`, {
      httpStatus: 401,
      model,
    });
  }
  if (status === 403) {
    return new BrainError("UNREACHABLE_FROM_SANDBOX", `Vyce answered HTTP 403 (WAF/egress block likely) for model "${model}"`, {
      httpStatus: 403,
      model,
    });
  }
  if (status === 429) {
    return new BrainError("RATE_LIMITED", `Vyce rate-limited the request (HTTP 429) for model "${model}"`, {
      httpStatus: 429,
      model,
    });
  }
  return new BrainError("BAD_RESPONSE", `Vyce answered HTTP ${status} for model "${model}"`, { httpStatus: status, model });
}

type ParsedChunk = { content: string | null; usage: ChatCompletionResult["usage"] };

function parseCompletionPayload(data: unknown): ParsedChunk {
  const o = (data ?? {}) as Record<string, unknown>;
  const choices = Array.isArray(o.choices) ? o.choices : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (first.message ?? {}) as Record<string, unknown>;
  const content = typeof message.content === "string" ? message.content : null;

  let usage: ParsedChunk["usage"] = null;
  const u = (o.usage ?? null) as Record<string, unknown> | null;
  if (u && typeof u === "object") {
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    usage = {
      prompt: num(u.prompt_tokens),
      completion: num(u.completion_tokens),
      total: num(u.total_tokens),
    };
  }
  return { content, usage };
}

export async function chatComplete(
  roleOrModel: string,
  messages: BrainMessage[],
  opts: ChatCompleteOpts = {},
): Promise<ChatCompletionResult> {
  const started = Date.now();
  const { model, role } = await resolveModel(roleOrModel);
  const creds = await resolveVyceCredentials();
  if (!creds) {
    await recordBrainUsage({ model, ok: false, latencyMs: null, error: "NO_KEY", role });
    throw new BrainError("NO_KEY", "no Vyce key available — vault empty and Supabase edge-secret fallback unavailable");
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new BrainError("BAD_INPUT", "messages must be a non-empty array");
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(`${creds.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.extraBody ?? {}),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    await recordBrainUsage({
      model,
      ok: false,
      latencyMs: Date.now() - started,
      error: timedOut ? "TIMEOUT" : "NETWORK",
      source: creds.source,
      role,
    });
    throw new BrainError(
      "UNREACHABLE_FROM_SANDBOX",
      timedOut
        ? `Vyce did not respond within ${Math.round(timeoutMs / 1000)}s calling model "${model}"`
        : `network error reaching Vyce calling model "${model}"`,
      { model },
    );
  }

  if (!res.ok) {
    // Body is intentionally NOT read into the error message (static strings only).
    await recordBrainUsage({
      model,
      ok: false,
      latencyMs: Date.now() - started,
      error: `HTTP_${res.status}`,
      source: creds.source,
      role,
    });
    throw mapHttpFailure(res.status, model);
  }

  const data: unknown = await res.json().catch(() => null);
  const parsed = parseCompletionPayload(data);
  if (parsed.content === null) {
    await recordBrainUsage({
      model,
      ok: false,
      latencyMs: Date.now() - started,
      error: "BAD_RESPONSE_SHAPE",
      source: creds.source,
      role,
    });
    throw new BrainError("BAD_RESPONSE", `Vyce returned an unrecognized completion shape for model "${model}"`, {
      httpStatus: res.status,
      model,
    });
  }

  const latencyMs = Date.now() - started;
  await recordBrainUsage({
    model,
    ok: true,
    latencyMs,
    tokens: parsed.usage ? { prompt: parsed.usage.prompt, completion: parsed.usage.completion } : null,
    source: creds.source,
    role,
  });

  return { model, content: parsed.content, latencyMs, usage: parsed.usage };
}

/**
 * Streaming chat completion — async iterable of SSE content deltas.
 * Parses "data: " lines and honors the [DONE] sentinel. Errors follow the
 * same typed taxonomy as chatComplete; UsageEvent is written in `finally`.
 */
export async function* streamComplete(
  roleOrModel: string,
  messages: BrainMessage[],
  opts: ChatCompleteOpts = {},
): AsyncGenerator<string, void, unknown> {
  const started = Date.now();
  const { model, role } = await resolveModel(roleOrModel);
  const creds = await resolveVyceCredentials();
  if (!creds) {
    await recordBrainUsage({ model, ok: false, latencyMs: null, error: "NO_KEY", role, streamed: true });
    throw new BrainError("NO_KEY", "no Vyce key available — vault empty and Supabase edge-secret fallback unavailable");
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new BrainError("BAD_INPUT", "messages must be a non-empty array");
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(`${creds.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.key}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.extraBody ?? {}),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    await recordBrainUsage({
      model,
      ok: false,
      latencyMs: Date.now() - started,
      error: timedOut ? "TIMEOUT" : "NETWORK",
      source: creds.source,
      role,
      streamed: true,
    });
    throw new BrainError(
      "UNREACHABLE_FROM_SANDBOX",
      timedOut
        ? `Vyce did not respond within ${Math.round(timeoutMs / 1000)}s calling model "${model}"`
        : `network error reaching Vyce calling model "${model}"`,
      { model },
    );
  }

  if (!res.ok || !res.body) {
    await recordBrainUsage({
      model,
      ok: false,
      latencyMs: Date.now() - started,
      error: `HTTP_${res.status}`,
      source: creds.source,
      role,
      streamed: true,
    });
    throw mapHttpFailure(res.status, model);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: ChatCompletionResult["usage"] = null;
  let sawDone = false;
  let streamError: string | null = null;

  try {
    while (!sawDone) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          sawDone = true;
          break;
        }
        let chunk: unknown;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // malformed line — skip, keep streaming
        }
        const parsed = parseCompletionPayload(chunk);
        if (parsed.usage) usage = parsed.usage;
        if (parsed.content) yield parsed.content;
      }
    }
  } catch {
    streamError = "STREAM_INTERRUPTED";
    throw new BrainError("BAD_RESPONSE", `stream from Vyce was interrupted for model "${model}"`, { model });
  } finally {
    void reader.cancel().catch(() => undefined);
    await recordBrainUsage({
      model,
      ok: streamError === null,
      latencyMs: Date.now() - started,
      tokens: usage ? { prompt: usage.prompt, completion: usage.completion } : null,
      error: streamError ?? undefined,
      source: creds.source,
      role,
      streamed: true,
    });
  }
}
