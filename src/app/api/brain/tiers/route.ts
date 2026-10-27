import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { VYCE_ROLE_MODELS, VYCE_ROLES } from "@/lib/connectors/vyce";
import { CUSTOM_PROVIDER_KEY_LABEL, loadProviders } from "@/lib/ai/custom-providers";
import {
  ROLE_BINDING_MODELS_MAX,
  clearRoleBinding,
  loadRoleBindings,
  sanitizeRoleBinding,
  saveRoleBinding,
  type BrainRole,
  type RoleBinding,
  type RoleBindingVia,
} from "@/lib/ai/role-bindings";

export const dynamic = "force-dynamic";

/**
 * Task R18-b — brain tier registry (owner queue ④: "A brain-tier switch or
 * model-registry page for custom providers — any measured model can now be
 * promoted to a tier").
 *
 * GET  → { ok, roleOrder, roles: [{ role, vyceDefault, aiModelsOverride,
 *          binding }], providers: [{ slug, name, style, baseUrl, hasKey,
 *          modelCount }] }
 *        - vyceDefault: the hardcoded VYCE_ROLE_MODELS value for the role.
 *        - aiModelsOverride: the role's entry in the Settings KV "ai.models"
 *          map if set (vyce model ids only, legacy override) — else null.
 *        - binding: the role's R18-b binding ({via, provider?, model}) or null.
 *        - providers: the custom-provider registry (config models length as
 *          modelCount). P7: hasKey is a BOOLEAN ONLY — no masked keys, no key
 *          material, ever.
 *
 * PUT  { role, via, provider?, model } → promote/bind a role; OR
 *      { role, binding: null }          → clear a role's binding (back to the
 *                                          ai.models override → Vyce default).
 *
 * Errors → §11 { ok:false, error:{ code, message } } 400s: INVALID_BODY,
 * INVALID_ROLE, INVALID_VIA, INVALID_PROVIDER (unknown custom-provider slug),
 * INVALID_MODEL (empty or >128 chars), MISSING_PROVIDER (via "custom" without
 * a provider); 401 UNAUTHORIZED; 429 RATE_LIMITED; 500 KV_WRITE_FAILED
 * (internal detail never leaked).
 *
 * On success an L0 Event row is written (source "system", type
 * "brain.tier_bound" | "brain.tier_cleared", level "info", payload JSON
 * {role, via, provider?} — config only, no secrets).
 */

function badRequest(code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status: 400 });
}

function isRoleBindingVia(value: unknown): value is RoleBindingVia {
  return value === "vyce" || value === "groq" || value === "custom";
}

/** Reads the legacy Settings KV "ai.models" role→model map (validated, P7-safe:
 * model ids only). Corrupt values are ignored per-role. */
async function readAiModelsOverride(): Promise<Partial<Record<BrainRole, string>>> {
  const out: Partial<Record<BrainRole, string>> = {};
  try {
    const row = await db.setting.findUnique({ where: { key: "ai.models" } });
    if (!row?.value) return out;
    const parsed: unknown = JSON.parse(row.value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!(VYCE_ROLES as readonly string[]).includes(k) || typeof v !== "string") continue;
      const id = v.trim().slice(0, ROLE_BINDING_MODELS_MAX);
      if (id.length > 0) out[k as BrainRole] = id;
    }
  } catch {
    // malformed override — treated as unset
  }
  return out;
}

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  // 30/min ≈ the tab's 30 s refetch cadence with headroom.
  if (!rateLimit(`brain-tiers-read:${clientKey(req)}`, 30, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many tier reads — slow down." } },
      { status: 429 },
    );
  }

  const [bindings, aiModels, providerConfigs, keyRows] = await Promise.all([
    loadRoleBindings(),
    readAiModelsOverride(),
    loadProviders(),
    db.credential.findMany({
      where: { label: CUSTOM_PROVIDER_KEY_LABEL, service: { startsWith: "provider:" } },
      select: { service: true, cipher: true },
    }),
  ]);

  // P7: hasKey BOOLEAN ONLY — presence of a vault row; nothing decrypted here.
  const keyedSlugs = new Set(keyRows.map((r) => r.service.slice("provider:".length)));

  const roles = VYCE_ROLES.map((role) => ({
    role,
    vyceDefault: VYCE_ROLE_MODELS[role],
    aiModelsOverride: aiModels[role] ?? null,
    binding: bindings[role],
  }));

  const providers = providerConfigs.map((cfg) => ({
    slug: cfg.slug,
    name: cfg.name,
    style: cfg.style,
    baseUrl: cfg.baseUrl,
    hasKey: keyedSlugs.has(cfg.slug),
    modelCount: cfg.models.length,
  }));

  return NextResponse.json({ ok: true, roleOrder: VYCE_ROLES, roles, providers });
}

export async function PUT(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  // 10/min — owner-scale tier switches, generous headroom.
  if (!rateLimit(`brain-tiers-write:${clientKey(req)}`, 10, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many tier writes — slow down." } },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return badRequest("INVALID_BODY", "Request body must be a JSON object.");
  }
  const raw = body as { role?: unknown; via?: unknown; provider?: unknown; model?: unknown; binding?: unknown };

  const role = typeof raw.role === "string" ? raw.role : "";
  if (!(VYCE_ROLES as readonly string[]).includes(role)) {
    return badRequest(
      "INVALID_ROLE",
      `role must be one of: ${VYCE_ROLES.join(", ")}.`,
    );
  }

  // CLEAR path: { role, binding: null }
  if (raw.binding === null) {
    try {
      await clearRoleBinding(role as BrainRole);
    } catch {
      return NextResponse.json(
        { ok: false, error: { code: "KV_WRITE_FAILED", message: "Could not clear the tier binding — try again." } },
        { status: 500 },
      );
    }
    await writeTierEvent("brain.tier_cleared", { role });
    return NextResponse.json({ ok: true, binding: null });
  }

  // BIND path: { role, via, provider?, model }
  if (!isRoleBindingVia(raw.via)) {
    return badRequest("INVALID_VIA", "via must be exactly one of: vyce, groq, custom.");
  }
  const via: RoleBindingVia = raw.via;

  if (via === "custom") {
    if (typeof raw.provider !== "string" || raw.provider.length === 0) {
      return badRequest(
        "MISSING_PROVIDER",
        'a binding with via "custom" requires the "provider" field (a custom-provider slug).',
      );
    }
    const known = await loadProviders();
    if (!known.some((p) => p.slug === raw.provider)) {
      return badRequest(
        "INVALID_PROVIDER",
        `provider "${String(raw.provider)}" is not a configured custom provider — add it in Connectors first.`,
      );
    }
  }

  if (typeof raw.model !== "string") {
    return badRequest("INVALID_MODEL", "model must be a string of 1–128 characters.");
  }
  const model = raw.model.trim().slice(0, ROLE_BINDING_MODELS_MAX);
  if (model.length === 0 || raw.model.trim().length > ROLE_BINDING_MODELS_MAX) {
    return badRequest("INVALID_MODEL", "model must be 1–128 characters (after trim).");
  }

  const binding: RoleBinding | null = sanitizeRoleBinding({
    via,
    ...(via === "custom" ? { provider: raw.provider } : {}),
    model,
  });
  // Defensive: sanitizeRoleBinding only rejects what validation above already
  // guaranteed — belt-and-braces against the two validators drifting.
  if (!binding) {
    return badRequest("INVALID_MODEL", "model must be 1–128 characters (after trim).");
  }

  try {
    await saveRoleBinding(role as BrainRole, binding);
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "KV_WRITE_FAILED", message: "Could not persist the tier binding — try again." } },
      { status: 500 },
    );
  }

  await writeTierEvent("brain.tier_bound", {
    role,
    via: binding.via,
    ...(binding.provider !== undefined ? { provider: binding.provider } : {}),
  });

  return NextResponse.json({ ok: true, binding });
}

/** L0 Event row — config only ({role, via, provider?}), never secrets. */
async function writeTierEvent(type: "brain.tier_bound" | "brain.tier_cleared", payload: Record<string, string>): Promise<void> {
  try {
    await db.event.create({
      data: {
        source: "system",
        type,
        level: "info",
        payload: JSON.stringify(payload).slice(0, 8192),
      },
    });
  } catch {
    // best-effort — the event log must never break the tier switch itself
  }
}
