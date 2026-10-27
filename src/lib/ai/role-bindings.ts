import { db } from "@/lib/db";
import { VYCE_ROLES } from "@/lib/connectors/vyce";
import { isValidCustomSlug } from "@/lib/ai/custom-providers";

/**
 * NEXUS OS — brain tier bindings (task R18-b).
 *
 * The brain has six roles (router, worker, frontier, free, batch, image — the
 * VYCE_ROLES registry) with hardcoded Vyce defaults in VYCE_ROLE_MODELS and a
 * Settings KV "ai.models" override (vyce model ids only). This module adds the
 * PROMOTION mechanism: any measured model — including one from a CUSTOM
 * provider (src/lib/ai/custom-providers.ts) — can be bound to a brain role.
 *
 * Storage (no Prisma changes — same pattern as saveProviders):
 *   Settings KV key "ai.role-bindings" = JSON object role → binding:
 *     { via: "vyce" | "groq" | "custom", provider?: string, model: string }
 *   - provider is REQUIRED when via === "custom" (a custom-provider slug).
 *   - model is 1..128 chars after trim.
 *   The whole KV value is upserted on every save/clear (read-modify-write).
 *
 * HONESTY CONTRACT (corrupt data is NEVER trusted, never throws): every read
 * re-validates the stored JSON — unknown roles are dropped, invalid `via`
 * values are dropped, custom bindings without a format-valid slug are
 * dropped, model ids are trimmed and length-capped (empty → dropped). A
 * custom binding whose slug no longer exists in the providers KV is KEPT at
 * this layer and surfaces honestly at call time (chatCompleteCustom answers
 * NOT_CONFIGURED → the brain maps it to BAD_INPUT naming the role).
 *
 * P7: bindings are pure config (role + slug + model id) — no key material
 * ever passes through this module.
 */

export const ROLE_BINDINGS_KV_KEY = "ai.role-bindings";

export const ROLE_BINDING_MODELS_MAX = 128;

/** Role type mirrors client.ts's BrainRole (= VyceRole) without importing it
 * (client.ts imports this module — the role type is derived from the same
 * VYCE_ROLES registry both sides already share). */
export type BrainRole = (typeof VYCE_ROLES)[number];

export type RoleBindingVia = "vyce" | "groq" | "custom";

export type RoleBinding = {
  via: RoleBindingVia;
  /** Custom provider slug — REQUIRED (and format-valid) when via === "custom". */
  provider?: string;
  /** Model id, 1..128 chars after trim. */
  model: string;
};

export type RoleBindingMap = Record<BrainRole, RoleBinding | null>;

// ---------------------------------------------------------------------------
// Validation — applied on EVERY read (and again on save inputs)
// ---------------------------------------------------------------------------

function isRoleBindingVia(value: unknown): value is RoleBindingVia {
  return value === "vyce" || value === "groq" || value === "custom";
}

/** Normalizes one raw binding record; null when the record must be dropped. */
export function sanitizeRoleBinding(raw: unknown): RoleBinding | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!isRoleBindingVia(o.via)) return null;
  if (typeof o.model !== "string") return null;
  const model = o.model.trim().slice(0, ROLE_BINDING_MODELS_MAX);
  if (model.length === 0) return null;

  if (o.via === "custom") {
    // Local bind + typeof: a negated type-guard does not narrow the property,
    // so the return below needs an explicitly string-typed value.
    const provider = o.provider;
    if (typeof provider !== "string" || !isValidCustomSlug(provider)) return null;
    return { via: "custom", provider, model };
  }
  // vyce / groq bindings carry no provider — a stale extra field is dropped,
  // never trusted forward.
  return { via: o.via, model };
}

/** Parses + validates the raw KV JSON into a full role → binding map. */
function parseBindings(rawJson: string | null): RoleBindingMap {
  const map = emptyRoleBindings();
  if (!rawJson) return map;
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return map;
    for (const [role, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!(VYCE_ROLES as readonly string[]).includes(role)) continue; // unknown role — dropped
      const binding = sanitizeRoleBinding(value);
      if (binding) map[role as BrainRole] = binding;
    }
  } catch {
    // malformed JSON — every role rests unbound (defaults stand)
  }
  return map;
}

function emptyRoleBindings(): RoleBindingMap {
  const map = {} as RoleBindingMap;
  for (const role of VYCE_ROLES) map[role] = null;
  return map;
}

// ---------------------------------------------------------------------------
// Read (cached, TTL like the ai.models registry) + write (whole-KV upsert)
// ---------------------------------------------------------------------------

const BINDINGS_TTL = 15_000;
let bindingsCache: { at: number; map: RoleBindingMap } | null = null;

/**
 * Loads the role → binding map (all six roles; null = unbound). Never throws:
 * DB errors surface as an all-null map (the brain honestly falls back to the
 * ai.models override → VYCE_ROLE_MODELS defaults).
 */
export async function loadRoleBindings(): Promise<RoleBindingMap> {
  const now = Date.now();
  if (bindingsCache && now - bindingsCache.at < BINDINGS_TTL) return { ...bindingsCache.map };
  let map: RoleBindingMap;
  try {
    const row = await db.setting.findUnique({ where: { key: ROLE_BINDINGS_KV_KEY } });
    map = parseBindings(row?.value ?? null);
  } catch {
    map = emptyRoleBindings();
  }
  bindingsCache = { at: now, map };
  return { ...map };
}

/** Saves one binding (upserts the whole KV value like saveProviders). */
export async function saveRoleBinding(role: BrainRole, binding: RoleBinding): Promise<void> {
  const clean = sanitizeRoleBinding(binding);
  if (!clean) {
    throw new Error("invalid role binding");
  }
  const current = { ...(await loadRoleBindingsRaw()) };
  current[role] = clean;
  await persistBindings(current);
}

/** Clears one binding (null → role absent from the KV value). */
export async function clearRoleBinding(role: BrainRole): Promise<void> {
  const current = { ...(await loadRoleBindingsRaw()) };
  current[role] = null;
  await persistBindings(current);
}

/** Raw (uncached) read used by the write path so read-modify-write is fresh. */
async function loadRoleBindingsRaw(): Promise<RoleBindingMap> {
  try {
    const row = await db.setting.findUnique({ where: { key: ROLE_BINDINGS_KV_KEY } });
    return parseBindings(row?.value ?? null);
  } catch {
    return emptyRoleBindings();
  }
}

async function persistBindings(map: RoleBindingMap): Promise<void> {
  // Only bound roles are stored — absent roles mean "unbound", and missing
  // keys parse back to null on read.
  const value: Record<string, RoleBinding> = {};
  for (const role of VYCE_ROLES) {
    const binding = map[role];
    if (binding) value[role] = binding;
  }
  const json = JSON.stringify(value);
  await db.setting.upsert({
    where: { key: ROLE_BINDINGS_KV_KEY },
    update: { value: json },
    create: { key: ROLE_BINDINGS_KV_KEY, value: json },
  });
  bindingsCache = null; // next read observes the write immediately
}
