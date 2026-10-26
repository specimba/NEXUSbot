import { db } from "@/lib/db";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";

/**
 * NEXUS OS — Supabase Management API connector (T-203).
 *
 * Auth model: a SCOPED Management-API PAT (dashboard → Access Tokens) is stored
 * in the encrypted vault (service "supabase", label "mgmt"). Every Mgmt call is
 * `Authorization: Bearer <pat>` against https://api.supabase.com. This is the
 * documented connector model for Supabase (directive §10-A1: writes are the
 * service's own authenticated API, driven by the owner's stored credential).
 *
 * Client-side rate limit: 120 req/min (sliding fixed window, in-memory). A 429
 * from upstream sets a cooldown and is honored via Retry-After.
 *
 * P7: the PAT is never logged, echoed, or embedded in errors — responses are
 * reduced to {status, ok} plus parsed JSON for endpoints that carry no secret.
 */

export const SUPABASE_SERVICE = "supabase" as const;
export const SUPABASE_LABEL = "mgmt" as const;

export const SUPABASE_MGMT_BASE = "https://api.supabase.com";
export const MGMT_RATE_LIMIT_PER_MIN = 120;

export class MgmtRateLimitError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`client-side Mgmt rate limit reached (120 req/min), retry in ~${retryAfterSeconds}s`);
    this.name = "MgmtRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class MgmtCooldownError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`upstream asked to slow down (Retry-After), retry in ~${retryAfterSeconds}s`);
    this.name = "MgmtCooldownError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// ---------------------------------------------------------------------------
// Vault access (service "supabase", label "mgmt")
// ---------------------------------------------------------------------------

export async function getMgmtPat(): Promise<string | null> {
  const row = await db.credential.findUnique({
    where: { service_label: { service: SUPABASE_SERVICE, label: SUPABASE_LABEL } },
  });
  if (!row) return null;
  try {
    return decryptSecret(row.cipher);
  } catch {
    return null; // integrity failure — treat as absent; routes report honestly
  }
}

export async function storeMgmtPat(pat: string): Promise<void> {
  const { keyId, cipher } = encryptSecret(pat);
  await db.credential.upsert({
    where: { service_label: { service: SUPABASE_SERVICE, label: SUPABASE_LABEL } },
    create: { service: SUPABASE_SERVICE, label: SUPABASE_LABEL, keyId, cipher },
    update: { keyId, cipher },
  });
}

export async function deleteMgmtPat(): Promise<boolean> {
  const res = await db.credential.deleteMany({
    where: { service: SUPABASE_SERVICE, label: SUPABASE_LABEL },
  });
  return res.count > 0;
}

export function maskMgmtPat(pat: string): string {
  return maskSecret(pat);
}

/** Shape check only (no value validation — honest probe decides liveness). */
export function isPlausiblePat(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 8 && value.trim().length <= 4096;
}

// ---------------------------------------------------------------------------
// Mgmt HTTP client — 120 req/min client-side limiter + Retry-After cooldown.
// ---------------------------------------------------------------------------

let windowStart = 0;
let windowCount = 0;
let cooldownUntil = 0;

export function mgmtClientState(): { usageThisMinute: number; limited: boolean; limitPerMinute: number } {
  const now = Date.now();
  const usage = now - windowStart < 60_000 ? windowCount : 0;
  return { usageThisMinute: usage, limited: now < cooldownUntil, limitPerMinute: MGMT_RATE_LIMIT_PER_MIN };
}

export type MgmtResult = {
  status: number;
  ok: boolean;
  retryAfterSeconds: number | null;
  data: unknown;
};

async function mgmtRequest(
  pat: string,
  path: string,
  init?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown },
): Promise<MgmtResult> {
  const now = Date.now();
  if (now < cooldownUntil) {
    throw new MgmtCooldownError(Math.ceil((cooldownUntil - now) / 1000));
  }
  if (now - windowStart >= 60_000) {
    windowStart = now;
    windowCount = 0;
  }
  if (windowCount >= MGMT_RATE_LIMIT_PER_MIN) {
    throw new MgmtRateLimitError(Math.ceil((windowStart + 60_000 - now) / 1000));
  }
  windowCount += 1;

  let res: Response;
  try {
    res = await fetch(`${SUPABASE_MGMT_BASE}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json",
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      // Round-9 hardening (re-applied R11): never hang the panel on the Mgmt API.
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return { status: 0, ok: false, retryAfterSeconds: null, data: null };
  }

  const retryRaw = res.headers.get("retry-after");
  const retryParsed = retryRaw !== null ? Number(retryRaw) : NaN;
  const retryAfterSeconds = Number.isFinite(retryParsed) ? retryParsed : null;

  if (res.status === 429) {
    const wait = retryAfterSeconds !== null && retryAfterSeconds > 0 ? retryAfterSeconds : 5;
    cooldownUntil = Date.now() + wait * 1000;
  }

  const text = await res.text();
  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null; // non-JSON body — endpoints we parse tolerate null
    }
  }

  return { status: res.status, ok: res.ok, retryAfterSeconds, data };
}

// ---------------------------------------------------------------------------
// Endpoint wrappers. Parsers reduce upstream JSON to P7-safe shapes.
// ---------------------------------------------------------------------------

export type MgmtProject = {
  ref: string;
  name: string;
  region: string | null;
  status: string;
};

function parseProjects(data: unknown): MgmtProject[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((raw): MgmtProject | null => {
      const o = (raw ?? {}) as Record<string, unknown>;
      const ref = typeof o.id === "string" ? o.id : typeof o.ref === "string" ? o.ref : "";
      if (!ref) return null;
      return {
        ref,
        name: typeof o.name === "string" ? o.name : "unnamed",
        region: typeof o.region === "string" ? o.region : null,
        status: typeof o.status === "string" ? o.status : "UNKNOWN",
      };
    })
    .filter((p): p is MgmtProject => p !== null);
}

/** GET /v1/projects — the single MEASURED probe for status + health. */
export async function mgmtListProjects(pat: string): Promise<MgmtResult & { projects: MgmtProject[] }> {
  const res = await mgmtRequest(pat, "/v1/projects");
  return { ...res, projects: res.ok ? parseProjects(res.data) : [] };
}

export type MgmtHealthReport = { service: string; healthy: boolean; status: string | null };

/** GET /v1/projects/{ref}/health — per-project MEASURED health reports.
 * R11 re-applied Round-9 fix: the endpoint REQUIRES the `services` query param —
 * without it the Management API answers 400 (MEASURED 2026-10-22). */
export async function mgmtProjectHealth(
  pat: string,
  ref: string,
): Promise<MgmtResult & { reports: MgmtHealthReport[] }> {
  const services = "auth,db,pooler,rest,storage,realtime";
  const res = await mgmtRequest(
    pat,
    `/v1/projects/${encodeURIComponent(ref)}/health?services=${services}`,
  );
  let reports: MgmtHealthReport[] = [];
  if (res.ok && Array.isArray(res.data)) {
    reports = res.data.map((raw) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      return {
        service: typeof o.name === "string" ? o.name : "unknown",
        healthy: o.healthy === true,
        status: typeof o.status === "string" ? o.status : null,
      };
    });
  }
  return { ...res, reports };
}

export type MgmtSecretRow = { name: string; alias: string | null; hasValue: boolean };

/**
 * GET /v1/projects/{ref}/secrets — MASKED. The Mgmt API may include secret
 * values in its response; they are reduced to names + hasValue booleans here
 * and NEVER leave this module. (P7 / directive §8.)
 */
export async function mgmtListSecrets(
  pat: string,
  ref: string,
): Promise<MgmtResult & { secrets: MgmtSecretRow[] }> {
  const res = await mgmtRequest(pat, `/v1/projects/${encodeURIComponent(ref)}/secrets`);
  let secrets: MgmtSecretRow[] = [];
  if (res.ok && Array.isArray(res.data)) {
    secrets = res.data.map((raw) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      return {
        name: typeof o.name === "string" ? o.name : "unknown",
        alias: typeof o.alias === "string" ? o.alias : null,
        hasValue: typeof o.value === "string" && o.value.length > 0,
      };
    });
  }
  return { ...res, secrets };
}

/**
 * POST /v1/projects/{ref}/secrets — body [{name, value}].
 * [MEASURED 2026-10-25, deploy-edge-cortex.ts]: the Mgmt API rejects `key`
 * with 400 "expected string, received undefined" — the wire field is `name`.
 */
export async function mgmtUpsertSecrets(
  pat: string,
  ref: string,
  items: ReadonlyArray<{ key: string; value: string }>,
): Promise<MgmtResult> {
  return mgmtRequest(pat, `/v1/projects/${encodeURIComponent(ref)}/secrets`, {
    method: "POST",
    body: items.map((i) => ({ name: i.key, value: i.value })),
  });
}

/** DELETE /v1/projects/{ref}/secrets — body [{key}] (Mgmt API contract). */
export async function mgmtDeleteSecrets(pat: string, ref: string, keys: ReadonlyArray<string>): Promise<MgmtResult> {
  return mgmtRequest(pat, `/v1/projects/${encodeURIComponent(ref)}/secrets`, {
    method: "DELETE",
    body: keys.map((k) => ({ key: k })),
  });
}

// ---------------------------------------------------------------------------
// Validation helpers shared by the routes.
// ---------------------------------------------------------------------------

/** Supabase project refs are 20-char alphanumeric strings. */
export function isValidProjectRef(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]{20}$/i.test(value);
}

/**
 * The live bot's Supabase project ref lives in the widget's supabase_url
 * variable (https://<ref>.supabase.co/functions/v1/...) — single source of
 * truth shared by the Exa auto-arm flow and the deploy-cortex route.
 */
export async function resolveCortexProjectRef(): Promise<string | null> {
  const { db } = await import("@/lib/db");
  const widget = await db.widget.findFirst({ where: { name: "Specimba Cyber AI Counter" } });
  if (!widget) return null;
  let vars: Array<{ name?: string; value?: string }> = [];
  try {
    vars = JSON.parse(widget.variables || "[]") as Array<{ name?: string; value?: string }>;
  } catch {
    return null;
  }
  const url = vars.find((v) => v.name === "supabase_url")?.value ?? "";
  const m = url.match(/^https:\/\/([a-z0-9]{20})\.supabase\.co/i);
  return m ? m[1] : null;
}

/** Widget's stored supabase anon key (Bearer for edge health probes). */
export async function resolveCortexAnonKey(): Promise<string | null> {
  const { db } = await import("@/lib/db");
  const widget = await db.widget.findFirst({ where: { name: "Specimba Cyber AI Counter" } });
  if (!widget) return null;
  let vars: Array<{ name?: string; value?: string }> = [];
  try {
    vars = JSON.parse(widget.variables || "[]") as Array<{ name?: string; value?: string }>;
  } catch {
    return null;
  }
  const key = vars.find((v) => v.name === "supabase_anon_key")?.value?.trim() ?? "";
  return key || null;
}

/** Edge Function secret keys: env-style identifiers. */
export function isValidSecretKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && value.length <= 128;
}

// ---------------------------------------------------------------------------
// L0 event tap (best-effort) so the Stream tab reflects connector reality.
// ---------------------------------------------------------------------------

export async function logSupabaseEvent(type: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await db.event.create({
      data: {
        source: "connector",
        type,
        level: "info",
        actor: "panel",
        payload: JSON.stringify(payload),
      },
    });
  } catch {
    // best-effort only
  }
}
