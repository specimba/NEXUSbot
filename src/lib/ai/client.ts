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
  looksLikeVyceFingerprint,
  normalizeVyceBaseUrl,
  type VyceRole,
} from "@/lib/connectors/vyce";
import { SUPABASE_MGMT_BASE, getMgmtPat, mgmtListProjects } from "@/lib/connectors/supabase";
import { joinProviderUrl, resolveCustomProvider } from "@/lib/connectors/custom-provider";
import {
  DEFAULT_GROQ_BASE_URL,
  GROQ_STATIC_MODELS,
  GROQ_TIMEOUT_MS,
  loadGroqKey,
  parseGroqModelsPayload,
} from "@/lib/ai/groq";
import {
  directFetch,
  loadEgressPool,
  pickProxies,
  proxiedFetch,
  readRoutingMap,
  routeFor,
  type EgressMode,
  type EgressTransportName,
} from "@/lib/egress";

/**
 * NEXUS OS — brain client (T-207 + task 13-b). OpenAI-compatible client for the
 * brain's LLM providers: the Vyce gateway (https://vyceai.com/v1 [MEASURED
 * envelope], plus any owner-set base) and the Groq slot (src/lib/ai/groq.ts —
 * this module is that file's ONLY consumer).
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
 *
 * EGRESS ROUTING (task 13-b) — before a non-streaming model call the route is
 * resolved once: routeFor(provider, readRoutingMap()) over the Settings KV
 * "egress.routing" map (keys "vyce"/"groq", fallback map.default → "direct").
 *   direct → the pre-existing native fetch path, byte-for-byte unchanged.
 *   proxy  → the BUFFERED egress transport (Webshare pool, src/lib/egress.ts)
 *            for NON-STREAMING calls only. Streaming stays DIRECT-ONLY — the
 *            proxy transport returns a complete buffered envelope and cannot
 *            stream; see the comment in streamComplete.
 * Proxy/transport failures map to UNREACHABLE-class BrainErrors and are NEVER
 * KEY_REJECTED — only an HTTP 401 answered by the upstream itself is a key
 * error, and a 401 never fails over.
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
        // Owner's live issue: the secret itself may be a SHA-256 fingerprint
        // (64 hex) — that can never authenticate, so treat it as absent and
        // say exactly why instead of probing with it forever.
        if (looksLikeVyceFingerprint(key)) {
          return {
            ok: false,
            reason:
              "the VYCE_API_KEY secret on the Supabase harness project is itself a 64-hex SHA-256 hash, not the raw key — re-store the RAW key there (or paste it below to make a vault key primary)",
          };
        }
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
  // A fingerprint-shaped vault value (64-hex SHA-256) can never authenticate
  // — skip it and fall through to the edge-secret path instead of replaying
  // the owner's 401 loop with a hash.
  if (vault.ok && !vault.fingerprint) {
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
// Groq provider slot (task 13-b) — key chain mirrors the Vyce one exactly:
// vault ("groq"/"api-key") → Supabase Edge-Function secret GROQ_API_KEY → null.
// Own TTL cache — no cross-contamination with the Vyce fallback cache.
// ---------------------------------------------------------------------------

export type BrainProvider = "vyce" | "groq";

export type GroqCredentials = {
  key: string;
  baseUrl: string; // fixed DEFAULT_GROQ_BASE_URL — no override surface by design
  source: "vault" | "supabase-edge-secret";
};

export type GroqFallback = { ok: true; key: string } | { ok: false; reason: string };

const GROQ_FALLBACK_NOT_FOUND = "GROQ_API_KEY not found among Edge Function secrets";
let groqFallbackCache: { at: number; result: GroqFallback } | null = null;
const GROQ_FALLBACK_TTL = 60_000;

/**
 * Groq Supabase Edge-Function secret fallback: the owner stored GROQ_API_KEY
 * as an Edge Function secret. SAME Mgmt-API mechanism as the Vyce fallback
 * (shared readEdgeSecretValues helper), but a SEPARATE cache so the two
 * providers' cached credentials never cross-contaminate. Values NEVER leave
 * this function except through the return value, handled per the hygiene rules.
 */
export async function resolveGroqKeyFallback(): Promise<GroqFallback> {
  const now = Date.now();
  if (groqFallbackCache && now - groqFallbackCache.at < GROQ_FALLBACK_TTL) return groqFallbackCache.result;

  const result = await (async (): Promise<GroqFallback> => {
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

    // Search the first few projects for the GROQ_API_KEY edge secret.
    for (const project of projects.projects.slice(0, 5)) {
      const found = await readEdgeSecretValues(pat, project.ref, ["GROQ_API_KEY"]);
      if (found === null) continue; // project unreachable — try the next
      const key = found.get("GROQ_API_KEY");
      if (key && key.trim().length >= 8) {
        // Same live issue as Vyce: the harness project's secrets were stored
        // as SHA-256 hashes — a 64-hex value can never authenticate at Groq.
        if (looksLikeVyceFingerprint(key)) {
          return {
            ok: false,
            reason:
              "the GROQ_API_KEY secret on the Supabase harness project is a 64-hex SHA-256 hash, not the raw key — re-store the RAW key there (or save it in the Groq vault slot)",
          };
        }
        return { ok: true, key: key.trim() };
      }
    }
    return { ok: false, reason: GROQ_FALLBACK_NOT_FOUND };
  })();

  if (result.ok) registerSecretForRedaction(result.key);
  groqFallbackCache = { at: now, result };
  return result;
}

/** Resolution order: vault ("groq"/"api-key") → Supabase edge-secret → null. */
export async function resolveGroqCredentials(): Promise<GroqCredentials | null> {
  void refreshRedactionList(); // fire-and-forget, TTL-throttled

  const vault = await loadGroqKey();
  // Fingerprint-shaped vault value (64-hex SHA-256) can never authenticate —
  // skip it and fall through to the edge-secret path.
  if (vault.ok && !looksLikeVyceFingerprint(vault.key)) {
    registerSecretForRedaction(vault.key);
    return { key: vault.key, baseUrl: DEFAULT_GROQ_BASE_URL, source: "vault" };
  }

  const fb = await resolveGroqKeyFallback();
  if (fb.ok) return { key: fb.key, baseUrl: DEFAULT_GROQ_BASE_URL, source: "supabase-edge-secret" };
  return null;
}

// ---------------------------------------------------------------------------
// Egress plumbing (task 13-b) — routing, buffered proxied transport, and the
// upstream-HTTP → BrainError mapper. Streaming never comes through here.
// ---------------------------------------------------------------------------

const BRAIN_MAX_PROXY_ATTEMPTS_CHAT = 2;
const BRAIN_MAX_PROXY_ATTEMPTS_PROBE = 3;

function labelFor(provider: BrainProvider): string {
  return provider === "groq" ? "Groq" : "Vyce";
}

/**
 * Resolve the egress mode for a brain provider: Settings KV "egress.routing"
 * key "vyce"/"groq" → map.default → "direct". A routing read failure must
 * never break calls — the fallback is DIRECT (the historical behavior).
 */
async function resolveBrainRoute(provider: BrainProvider): Promise<EgressMode> {
  try {
    return routeFor(provider, await readRoutingMap());
  } catch {
    return "direct";
  }
}

/**
 * Upstream HTTP status → typed BrainError. RULES (honesty contract, task 13-b):
 * - 401 → KEY_REJECTED: the upstream itself answered and rejected auth. This
 *   NEVER fails over (a wrong key stays a wrong key on every provider).
 * - 403 → UNREACHABLE_FROM_SANDBOX: an edge refusal is NEVER a key error.
 *   Groq-direct wording names the [measured] sandbox WAF block + the proxy
 *   path; via-proxy wording stays honest about not knowing which layer refused.
 * - Everything else maps per status. Messages are static strings + status +
 *   model id ONLY — upstream response BODIES are never included (P7); the
 *   BrainError constructor redacts as belt-and-braces.
 */
function mapUpstreamFailure(
  provider: BrainProvider,
  status: number,
  model: string | null,
  via: "direct" | EgressTransportName,
): BrainError {
  const label = labelFor(provider);
  const modelPart = model ? ` for model "${model}"` : "";
  const opts = { httpStatus: status as number, model: model ?? null };
  if (status === 401) {
    // 401 NEVER fails over — the key is wrong and must be surfaced as-is.
    return new BrainError(
      "KEY_REJECTED",
      `${label} rejected the key (HTTP 401)${model ? ` — model "${model}" was not called` : ""}`,
      { httpStatus: 401, model: model ?? null },
    );
  }
  if (status === 403) {
    if (provider === "groq" && via === "direct") {
      return new BrainError(
        "UNREACHABLE_FROM_SANDBOX",
        `Groq answered HTTP 403 at the sandbox egress edge (WAF block [measured])${modelPart} — reachable via the Webshare egress proxy once egress.routing routes "groq" through the pool`,
        opts,
      );
    }
    if (via === "direct") {
      return new BrainError(
        "UNREACHABLE_FROM_SANDBOX",
        `Vyce answered HTTP 403 (WAF/egress block likely)${modelPart}`,
        opts,
      );
    }
    return new BrainError(
      "UNREACHABLE_FROM_SANDBOX",
      `${label} answered HTTP 403 (refused at the upstream; egress proxy in use)${modelPart}`,
      opts,
    );
  }
  if (status === 429) {
    return new BrainError("RATE_LIMITED", `${label} rate-limited the request (HTTP 429)${modelPart}`, opts);
  }
  return new BrainError("BAD_RESPONSE", `${label} answered HTTP ${status}${modelPart}`, opts);
}

/**
 * Egress-routed, BUFFERED JSON call for the brain's NON-STREAMING paths.
 *   route "direct" → egress directFetch (same sandbox egress, typed envelope).
 *   route "proxy"  → Webshare pool via proxiedFetch, up to maxProxyAttempts
 *                    different pool proxies; transport failures try the next
 *                    proxy, then map to UNREACHABLE_FROM_SANDBOX — never
 *                    KEY_REJECTED. Upstream HTTP answers pass through untouched
 *                    (honesty — an HTTP 401 through a working proxy IS a key
 *                    error and is never retried on another proxy).
 * NEVER used for SSE streaming: proxiedFetch returns a complete buffered
 * envelope and cannot stream — see streamComplete.
 */
async function brainEgressJsonCall(
  provider: BrainProvider,
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  timeoutMs: number,
  opts: { model: string | null; maxProxyAttempts?: number },
): Promise<{ status: number; bodyText: string; via: "direct" | EgressTransportName }> {
  const label = labelFor(provider);
  const modelPart = opts.model ? ` for model "${opts.model}"` : "";
  const route = await resolveBrainRoute(provider);

  if (route === "direct") {
    const r = await directFetch(url, init, timeoutMs);
    if ("code" in r) {
      throw new BrainError(
        "UNREACHABLE_FROM_SANDBOX",
        `${label} did not answer from the sandbox egress (${r.code})${modelPart} — this is never a key problem`,
        { model: opts.model },
      );
    }
    return { status: r.status, bodyText: r.bodyText, via: "direct" };
  }

  // route === "proxy"
  const pool = await loadEgressPool();
  if (!pool.ok) {
    throw new BrainError(
      "UNREACHABLE_FROM_SANDBOX",
      `egress proxy pool unavailable for the ${label} call (${pool.code})${modelPart} — configure the Webshare connector or set egress.routing "${provider}" back to direct`,
      { model: opts.model },
    );
  }
  const candidates = pickProxies(pool.pool, opts.maxProxyAttempts ?? BRAIN_MAX_PROXY_ATTEMPTS_CHAT);
  let lastCode: string | null = null;
  for (const proxy of candidates) {
    const r = await proxiedFetch(url, init, { proxy, timeoutMs });
    if ("code" in r) {
      lastCode = r.code; // proxy/transport failure — try the next pool proxy
      continue;
    }
    return { status: r.status, bodyText: r.bodyText, via: r.via };
  }
  throw new BrainError(
    "UNREACHABLE_FROM_SANDBOX",
    `${label} call could not be completed through the egress proxy pool (${lastCode ?? "PROXY_FAILED"})${modelPart} — proxy/transport failure, never a key error`,
    { model: opts.model },
  );
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

async function resolveModel(
  roleOrModel: string,
  provider: BrainProvider,
): Promise<{ model: string; role: BrainRole | null }> {
  if ((BRAIN_ROLES as readonly string[]).includes(roleOrModel)) {
    if (provider === "groq") {
      // Roles map to the VYCE registry — silently sending a Vyce model id to
      // Groq would end in a confusing upstream 404. Honest BAD_INPUT instead.
      throw new BrainError(
        "BAD_INPUT",
        `role "${roleOrModel}" maps to the Vyce model registry — pass an explicit Groq model id for groq calls`,
      );
    }
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
  /** vyce rows carry the credential source; groq rows carry "groq" (provider). */
  source?: "vault" | "supabase-edge-secret" | "groq";
  role?: BrainRole | null;
  streamed?: boolean;
  /** Static egress mode actually used for the transport attempt. */
  egress?: "direct" | "proxy";
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
    if (tap.egress) meta.egress = tap.egress;
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
  /**
   * Provider slot for this call — default "vyce" preserves the pre-existing
   * behavior exactly. provider:"groq" resolves the Groq key chain (vault
   * "groq"/"api-key" → Supabase GROQ_API_KEY edge-secret → NO_KEY), routes via
   * the egress.routing key "groq", and tags UsageEvent meta source "groq".
   * Roles are Vyce-registry-only — pass explicit model ids for Groq.
   */
  provider?: BrainProvider;
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

/**
 * Shared non-streaming completion tail: upstream HTTP status → typed BrainError
 * (static messages only — response bodies are NEVER included), payload parse,
 * UsageEvent counters. Used by BOTH the direct and the proxied paths so the
 * handling is provably identical; P7's redaction choke point applies in
 * BrainError regardless of path.
 */
async function finishChatCompletion(
  provider: BrainProvider,
  status: number,
  via: "direct" | EgressTransportName,
  readBody: () => Promise<unknown>,
  ctx: { model: string; role: BrainRole | null; source: BrainUsageTap["source"]; egress: "direct" | "proxy"; started: number },
): Promise<ChatCompletionResult> {
  if (status < 200 || status >= 300) {
    await recordBrainUsage({
      model: ctx.model,
      ok: false,
      latencyMs: Date.now() - ctx.started,
      error: `HTTP_${status}`,
      source: ctx.source,
      role: ctx.role,
      egress: ctx.egress,
    });
    // Body is intentionally NOT read into the error message (static strings only).
    throw mapUpstreamFailure(provider, status, ctx.model, via);
  }

  const data: unknown = await readBody();
  const parsed = parseCompletionPayload(data);
  if (parsed.content === null) {
    await recordBrainUsage({
      model: ctx.model,
      ok: false,
      latencyMs: Date.now() - ctx.started,
      error: "BAD_RESPONSE_SHAPE",
      source: ctx.source,
      role: ctx.role,
      egress: ctx.egress,
    });
    throw new BrainError("BAD_RESPONSE", `${labelFor(provider)} returned an unrecognized completion shape for model "${ctx.model}"`, {
      httpStatus: status,
      model: ctx.model,
    });
  }

  const latencyMs = Date.now() - ctx.started;
  await recordBrainUsage({
    model: ctx.model,
    ok: true,
    latencyMs,
    tokens: parsed.usage ? { prompt: parsed.usage.prompt, completion: parsed.usage.completion } : null,
    source: ctx.source,
    role: ctx.role,
    egress: ctx.egress,
  });

  return { model: ctx.model, content: parsed.content, latencyMs, usage: parsed.usage };
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
  const provider: BrainProvider = opts.provider === "groq" ? "groq" : "vyce";
  const { model, role } = await resolveModel(roleOrModel, provider);
  const creds = provider === "groq" ? await resolveGroqCredentials() : await resolveVyceCredentials();
  if (!creds) {
    await recordBrainUsage({ model, ok: false, latencyMs: null, error: "NO_KEY", role });
    throw new BrainError(
      "NO_KEY",
      provider === "groq"
        ? "no Groq key available — vault empty and Supabase edge-secret fallback unavailable"
        : "no Vyce key available — vault empty and Supabase edge-secret fallback unavailable",
    );
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new BrainError("BAD_INPUT", "messages must be a non-empty array");
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
  // UsageEvent meta source: groq rows carry the PROVIDER marker ("groq"); vyce
  // rows keep the credential source ("vault" | "supabase-edge-secret").
  const tapSource: BrainUsageTap["source"] = provider === "groq" ? "groq" : creds.source;

  // EGRESS ROUTING (task 13-b): resolved once per call. "direct" keeps the
  // pre-existing native-fetch path byte-for-byte; "proxy" routes this
  // NON-STREAMING call through the buffered egress transport (Webshare pool).
  const route = await resolveBrainRoute(provider);

  if (route === "proxy") {
    let answer: { status: number; bodyText: string; via: "direct" | EgressTransportName };
    try {
      answer = await brainEgressJsonCall(
        provider,
        `${creds.baseUrl}/chat/completions`,
        {
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
        },
        timeoutMs,
        { model, maxProxyAttempts: BRAIN_MAX_PROXY_ATTEMPTS_CHAT },
      );
    } catch (err) {
      const e =
        err instanceof BrainError
          ? err
          : new BrainError("BAD_RESPONSE", `${labelFor(provider)} proxy call failed with an unexpected transport error for model "${model}"`, { model });
      await recordBrainUsage({
        model,
        ok: false,
        latencyMs: Date.now() - started,
        error: e.code, // static code — transport failures are never key failures
        source: tapSource,
        role,
        egress: "proxy",
      });
      throw e;
    }
    return finishChatCompletion(
      provider,
      answer.status,
      answer.via,
      () => {
        try {
          return Promise.resolve(JSON.parse(answer.bodyText) as unknown);
        } catch {
          return Promise.resolve(null);
        }
      },
      { model, role, source: tapSource, egress: "proxy", started },
    );
  }

  // --- direct path: the pre-existing native-fetch path (UNCHANGED) -----------
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
      source: tapSource,
      role,
      egress: "direct",
    });
    throw new BrainError(
      "UNREACHABLE_FROM_SANDBOX",
      timedOut
        ? `${labelFor(provider)} did not respond within ${Math.round(timeoutMs / 1000)}s calling model "${model}"`
        : `network error reaching ${labelFor(provider)} calling model "${model}"`,
      { model },
    );
  }

  return finishChatCompletion(provider, res.status, "direct", () => res.json().catch(() => null), {
    model,
    role,
    source: tapSource,
    egress: "direct",
    started,
  });
}

// ---------------------------------------------------------------------------
// Custom providers (owner-defined, beyond Vyce/Groq) — non-streaming only.
// Streaming for custom gateways is deliberately deferred (honesty over
// pretend-coverage): Anthropic SSE has a different event grammar, and routing
// an SSE stream through the buffered proxy transport is impossible (same
// constraint as streamComplete above). The KICK bot integration consumes this
// entry point.
// ---------------------------------------------------------------------------

export type CustomChatOpts = {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Override the provider row's default model for this call. */
  model?: string;
};

/**
 * Chat completion through an owner-defined custom provider row.
 *   openai protocol    → POST {base}[/v1]/chat/completions, Bearer key.
 *   anthropic protocol → POST {base}[/v1]/messages, x-api-key +
 *                        anthropic-version: 2023-06-01; system role messages
 *                        are lifted into the top-level `system` param (the
 *                        Messages API rejects them inline).
 * Egress routing honors the routing-map key `custom:<providerId>`, falling
 * back to the "vyce" route, then direct. UsageEvent meta.source is
 * "custom:<safe-name>"; role is null (roles are a Vyce-registry concept).
 */
export async function chatCompleteCustom(
  providerId: string,
  messages: BrainMessage[],
  opts: CustomChatOpts = {},
): Promise<ChatCompletionResult> {
  const started = Date.now();
  const row = await resolveCustomProvider(providerId);
  if (!row) {
    throw new BrainError("NO_KEY", "custom provider not found (or its stored key could not be decrypted)");
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new BrainError("BAD_INPUT", "messages must be a non-empty array");
  }
  const model = (opts.model ?? row.model).trim();
  if (!model) {
    throw new BrainError("BAD_INPUT", `custom provider "${row.name}" has no model configured`);
  }
  if (row.protocol === "openai" && !row.key) {
    throw new BrainError("NO_KEY", `custom provider "${row.name}" has no API key stored yet`);
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
  const metaSource = `custom:${row.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 48)}`;

  let route: EgressMode = "direct";
  try {
    const map = await readRoutingMap();
    route = routeFor(`custom:${providerId}`, map) === "direct" ? routeFor("vyce", map) : routeFor(`custom:${providerId}`, map);
  } catch {
    route = "direct";
  }

  // --- request builders per protocol ----------------------------------------
  const isOpenAi = row.protocol === "openai";
  const url = isOpenAi
    ? joinProviderUrl(row.baseUrl, "openai", "chat/completions")
    : joinProviderUrl(row.baseUrl, "anthropic", "messages");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (isOpenAi) {
    headers["Authorization"] = `Bearer ${row.key ?? ""}`;
  } else {
    headers["x-api-key"] = row.key ?? "";
    headers["anthropic-version"] = "2023-06-01";
  }

  let bodyJson: string;
  if (isOpenAi) {
    bodyJson = JSON.stringify({
      model,
      messages,
      stream: false,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    });
  } else {
    const systemParts = messages.filter((m) => String(m.role).toLowerCase() === "system").map((m) => m.content);
    const turns = messages
      .filter((m) => ["user", "assistant"].includes(String(m.role).toLowerCase()))
      .map((m) => ({ role: String(m.role).toLowerCase(), content: m.content }));
    if (turns.length === 0) {
      throw new BrainError("BAD_INPUT", "anthropic-compatible calls need at least one user/assistant message");
    }
    bodyJson = JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 1024,
      ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      messages: turns,
    });
  }

  let answer: { status: number; bodyText: string; via: "direct" | EgressTransportName };
  try {
    answer = await brainEgressJsonCall(
      "vyce", // transport label only — the URL/headers/body above are fully custom
      url,
      { method: "POST", headers, body: bodyJson },
      timeoutMs,
      { model, maxProxyAttempts: BRAIN_MAX_PROXY_ATTEMPTS_CHAT },
    );
  } catch (err) {
    const e =
      err instanceof BrainError
        ? err
        : new BrainError("BAD_RESPONSE", `custom provider "${row.name}" call failed with an unexpected transport error for model "${model}"`, { model });
    await recordBrainUsage({
      model,
      ok: false,
      latencyMs: Date.now() - started,
      error: e.code,
      source: metaSource as BrainUsageTap["source"],
      egress: route,
    });
    throw e;
  }

  // --- response parsing per protocol ----------------------------------------
  const status = answer.status;
  const fail = (code: string, message: string): never => {
    void recordBrainUsage({
      model,
      ok: false,
      latencyMs: Date.now() - started,
      error: code,
      source: metaSource as BrainUsageTap["source"],
      egress: route,
    });
    throw new BrainError(code, message, { model });
  };

  if (status === 401) {
    fail("KEY_REJECTED", `custom provider "${row.name}" rejected the key (HTTP 401) — paste the RAW key, never a hash`);
  }
  if (status < 200 || status >= 300) {
    fail(`HTTP_${status}`, `custom provider "${row.name}" answered HTTP ${status} for model "${model}"`);
  }

  let data: unknown = null;
  try {
    data = JSON.parse(answer.bodyText) as unknown;
  } catch {
    fail("BAD_RESPONSE_SHAPE", `custom provider "${row.name}" returned a non-JSON body for model "${model}"`);
  }

  const o = (data ?? {}) as Record<string, unknown>;
  let content: string | null = null;
  let usage: ChatCompletionResult["usage"] = null;
  if (isOpenAi) {
    const parsed = parseCompletionPayload(data);
    content = parsed.content;
    usage = parsed.usage;
  } else {
    const blocks = Array.isArray(o.content) ? o.content : [];
    const text = blocks
      .map((b) => {
        const rec = (b ?? {}) as Record<string, unknown>;
        return rec.type === "text" && typeof rec.text === "string" ? rec.text : null;
      })
      .filter((t): t is string => t !== null)
      .join("");
    content = text.length > 0 ? text : null;
    const u = (o.usage ?? null) as Record<string, unknown> | null;
    if (u && typeof u === "object") {
      const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
      usage = { prompt: num(u.input_tokens), completion: num(u.output_tokens), total: null };
    }
  }

  if (content === null) {
    fail("BAD_RESPONSE_SHAPE", `custom provider "${row.name}" returned an unrecognized completion shape for model "${model}"`);
  }

  const latencyMs = Date.now() - started;
  await recordBrainUsage({
    model,
    ok: true,
    latencyMs,
    tokens: usage ? { prompt: usage.prompt, completion: usage.completion } : null,
    source: metaSource as BrainUsageTap["source"],
    egress: route,
  });

  return { model, content, latencyMs, usage };
}

/**
 * Streaming chat completion — async iterable of SSE content deltas.
 * Parses "data: " lines and honors the [DONE] sentinel. Errors follow the
 * same typed taxonomy as chatComplete; UsageEvent is written in `finally`.
 *
 * EGRESS NOTE (task 13-b, DELIBERATE): streaming calls stay DIRECT-ONLY. The
 * egress proxy transport (proxiedFetch) is BUFFERED — it returns a complete
 * EgressHttp envelope and cannot stream — so routing an SSE stream through it
 * would mean buffering the whole response and replaying it as if it streamed:
 * dishonest, and explicitly out of scope. Streaming-over-proxy is DEFERRED
 * until a streaming-capable tunnel transport exists. Consequence: when the
 * routing map sends a provider via proxy, a streaming call still goes direct
 * and may therefore fail honestly (e.g. Groq 403 WAF from this sandbox) rather
 * than silently downgrade or pretend.
 */
export async function* streamComplete(
  roleOrModel: string,
  messages: BrainMessage[],
  opts: ChatCompleteOpts = {},
): AsyncGenerator<string, void, unknown> {
  const started = Date.now();
  const provider: BrainProvider = opts.provider === "groq" ? "groq" : "vyce";
  const { model, role } = await resolveModel(roleOrModel, provider);
  const creds = provider === "groq" ? await resolveGroqCredentials() : await resolveVyceCredentials();
  if (!creds) {
    await recordBrainUsage({ model, ok: false, latencyMs: null, error: "NO_KEY", role, streamed: true });
    throw new BrainError(
      "NO_KEY",
      provider === "groq"
        ? "no Groq key available — vault empty and Supabase edge-secret fallback unavailable"
        : "no Vyce key available — vault empty and Supabase edge-secret fallback unavailable",
    );
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new BrainError("BAD_INPUT", "messages must be a non-empty array");
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
  const tapSource: BrainUsageTap["source"] = provider === "groq" ? "groq" : creds.source;
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
      source: tapSource,
      role,
      streamed: true,
      egress: "direct",
    });
    throw new BrainError(
      "UNREACHABLE_FROM_SANDBOX",
      timedOut
        ? `${labelFor(provider)} did not respond within ${Math.round(timeoutMs / 1000)}s calling model "${model}"`
        : `network error reaching ${labelFor(provider)} calling model "${model}"`,
      { model },
    );
  }

  if (!res.ok || !res.body) {
    await recordBrainUsage({
      model,
      ok: false,
      latencyMs: Date.now() - started,
      error: `HTTP_${res.status}`,
      source: tapSource,
      role,
      streamed: true,
      egress: "direct",
    });
    throw mapUpstreamFailure(provider, res.status, model, "direct");
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
    throw new BrainError("BAD_RESPONSE", `stream from ${labelFor(provider)} was interrupted for model "${model}"`, { model });
  } finally {
    void reader.cancel().catch(() => undefined);
    await recordBrainUsage({
      model,
      ok: streamError === null,
      latencyMs: Date.now() - started,
      tokens: usage ? { prompt: usage.prompt, completion: usage.completion } : null,
      error: streamError ?? undefined,
      source: tapSource,
      role,
      streamed: true,
      egress: "direct",
    });
  }
}

// ---------------------------------------------------------------------------
// Groq model catalog (task 13-b) — connect-time GET {base}/models, egress-aware,
// with an honest static fallback. The static list is NEVER presented as a
// measurement: docsSource is "measured" / "measured-via-proxy" for a live
// answer and "embedded-fallback" otherwise.
// ---------------------------------------------------------------------------

export type GroqModelCatalog = {
  models: string[];
  docsSource: "measured" | "measured-via-proxy" | "embedded-fallback";
  via: "direct" | EgressTransportName | null;
  checkedAt: string | null;
  error: { code: string; message: string } | null;
};

const GROQ_CATALOG_TTL = 60_000;
let groqCatalogCache: { at: number; result: GroqModelCatalog } | null = null;

/**
 * Live Groq /models probe (route-aware: direct → expects the [measured] 403 WAF
 * block; proxy → real answer through the pool). On ANY failure it returns the
 * embedded fallback list WITH the honest error attached — this function never
 * throws, so status surfaces can always render the slot truthfully.
 */
export async function getGroqModelCatalog(): Promise<GroqModelCatalog> {
  const now = Date.now();
  if (groqCatalogCache && now - groqCatalogCache.at < GROQ_CATALOG_TTL) return groqCatalogCache.result;

  const result = await (async (): Promise<GroqModelCatalog> => {
    const creds = await resolveGroqCredentials();
    if (!creds) {
      // NO_KEY → nothing was measured. Static list, clearly labeled, no probe.
      return {
        models: [...GROQ_STATIC_MODELS],
        docsSource: "embedded-fallback",
        via: null,
        checkedAt: null,
        error: {
          code: "NO_KEY",
          message: "no Groq key available — vault empty and Supabase edge-secret fallback unavailable",
        },
      };
    }
    try {
      const answer = await brainEgressJsonCall(
        "groq",
        `${creds.baseUrl}/models`,
        { method: "GET", headers: { Authorization: `Bearer ${creds.key}`, Accept: "application/json" } },
        GROQ_TIMEOUT_MS,
        { model: null, maxProxyAttempts: BRAIN_MAX_PROXY_ATTEMPTS_PROBE },
      );
      if (answer.status < 200 || answer.status >= 300) {
        throw mapUpstreamFailure("groq", answer.status, null, answer.via);
      }
      const models = parseGroqModelsPayload(answer.bodyText);
      if (models === null) {
        throw new BrainError("BAD_RESPONSE", "Groq returned an unrecognized /models payload shape", {
          httpStatus: answer.status,
        });
      }
      return {
        models,
        docsSource: answer.via === "direct" ? "measured" : "measured-via-proxy",
        via: answer.via,
        checkedAt: new Date().toISOString(),
        error: null,
      };
    } catch (err) {
      const e =
        err instanceof BrainError
          ? err
          : new BrainError("BAD_RESPONSE", "Groq model-catalog probe failed with an unexpected error");
      return {
        models: [...GROQ_STATIC_MODELS],
        docsSource: "embedded-fallback",
        via: null,
        checkedAt: new Date().toISOString(),
        error: { code: e.code, message: e.message },
      };
    }
  })();

  groqCatalogCache = { at: now, result };
  return result;
}

// ---------------------------------------------------------------------------
// Groq slot status — additive panel surface (rendered as the `groq` field on
// GET /api/vyce/status). NO_KEY does NOT trigger a network probe (a probe
// without a key measures nothing about the slot); with a key the live
// egress-routed catalog probe decides honestly. P7: masked preview + static
// strings only — key material never leaves this module.
// ---------------------------------------------------------------------------

export type GroqSlotStatus = {
  configured: boolean; // key resolvable from vault or EF fallback
  keySource: "vault" | "supabase-edge-secret" | null;
  maskedKey: string | null; // masked preview (••••tail) only — vault-sourced
  modelCount: number | null; // live count only when actually measured
  models: string[]; // live list when measured, else the labeled static fallback
  docsSource: "measured" | "measured-via-proxy" | "embedded-fallback";
  probedAt: string | null;
  error: { code: string; message: string } | null;
};

export async function getGroqSlotStatus(): Promise<GroqSlotStatus> {
  const vault = await loadGroqKey();
  if (vault.ok) registerSecretForRedaction(vault.key);

  // Vault unreadable → honest VAULT_UNREADABLE, never fake-success (parity with
  // the Vyce status route's handling of the same condition).
  if (!vault.ok && vault.reason === "unreadable") {
    return {
      configured: true,
      keySource: null,
      maskedKey: null,
      modelCount: null,
      models: [...GROQ_STATIC_MODELS],
      docsSource: "embedded-fallback",
      probedAt: null,
      error: { code: "VAULT_UNREADABLE", message: "Stored Groq key could not be decrypted — re-save it." },
    };
  }

  const creds = await resolveGroqCredentials();
  if (!creds) {
    return {
      configured: false,
      keySource: null,
      maskedKey: null,
      modelCount: null,
      models: [...GROQ_STATIC_MODELS],
      docsSource: "embedded-fallback",
      probedAt: null,
      error: {
        code: "NO_KEY",
        message: "no Groq key available — vault empty and Supabase edge-secret fallback unavailable",
      },
    };
  }

  const catalog = await getGroqModelCatalog();
  return {
    configured: true,
    keySource: creds.source,
    maskedKey: vault.ok && creds.source === "vault" ? vault.masked : null,
    modelCount: catalog.error === null ? catalog.models.length : null,
    models: catalog.models,
    docsSource: catalog.docsSource,
    probedAt: catalog.checkedAt,
    error: catalog.error,
  };
}
