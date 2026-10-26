import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import {
  getCustomProviderRow,
  isCustomProtocol,
  isPlausibleProviderKey,
  isValidCustomBaseUrl,
  normalizeCustomBaseUrl,
  parseProviderModels,
  probeCustomProvider,
  probeCustomProviderModel,
  resolveDefaultModel,
  sanitizeModelId,
  sanitizeModelList,
  serializeProviderModels,
  storeProviderKey,
  MAX_PROVIDER_MODELS,
} from "@/lib/connectors/custom-provider";

/**
 * PUT    /api/providers/custom/[id] — partial update. A non-empty apiKey
 *        replaces the stored key; an absent/empty apiKey leaves it untouched.
 *        `models` (string[]) replaces the whole batch list (task C1 chips
 *        editor); `defaultModel` picks the default within it. A bare `model`
 *        (legacy) still sets the default and is unioned into the stored list.
 *        `probe: true` runs a MEASURED endpoint probe after the update plus
 *        up to 3 per-model probes from the FINAL list.
 * DELETE — removes the provider row (key envelope goes with it). Idempotent.
 */

function err(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, ctx: Ctx) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`custom-providers:${clientKey(req)}`, 30, 60_000)) {
    return err("RATE_LIMITED", "Too many provider updates — slow down.", 429);
  }
  const { id } = await ctx.params;
  const row = await getCustomProviderRow(id);
  if (!row) return err("NOT_FOUND", "Provider not found.", 404);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const data: Record<string, unknown> = {};

  if (body?.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 1 || name.length > 80) return err("BAD_NAME", "name must be 1–80 characters.", 400);
    data.name = name;
  }
  if (body?.protocol !== undefined) {
    if (!isCustomProtocol(body.protocol)) return err("BAD_PROTOCOL", "protocol must be \"openai\" or \"anthropic\".", 400);
    data.protocol = body.protocol;
  }
  if (body?.baseUrl !== undefined) {
    if (!isValidCustomBaseUrl(body.baseUrl)) return err("BAD_BASE_URL", "baseUrl must be a valid https:// URL without credentials.", 400);
    data.baseUrl = normalizeCustomBaseUrl(body.baseUrl as string);
  }
  if (body?.model !== undefined) {
    if (typeof body.model !== "string") return err("BAD_MODEL", "model must be a string when provided.", 400);
    const legacy = sanitizeModelId(body.model);
    if (legacy === null) return err("BAD_MODEL", "model must be 1–128 characters.", 400);
    data.model = legacy;
  }
  if (body?.models !== undefined) {
    const batch = sanitizeModelList(body.models);
    if (batch.length === 0) {
      return err("BAD_MODELS", "models must contain at least one valid model id (1–128 chars).", 400);
    }
    data.models = serializeProviderModels(batch);
    data.model = resolveDefaultModel(batch, body?.defaultModel ?? body?.model);
  } else if (typeof data.model === "string") {
    // Legacy single-model update: keep the default inside the stored batch list.
    const legacy = data.model;
    const current = parseProviderModels(row.models);
    if (current.length > 0 && !current.includes(legacy) && current.length < MAX_PROVIDER_MODELS) {
      data.models = serializeProviderModels([...current, legacy]);
    }
  }
  if (body?.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return err("BAD_ENABLED", "enabled must be a boolean.", 400);
    data.enabled = body.enabled;
  }
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  if (apiKey.length > 0) {
    if (!isPlausibleProviderKey(apiKey)) return err("BAD_KEY", "apiKey must be 8–4096 characters.", 400);
    data.keyCipher = "PENDING"; // placeholder so validation failures cannot wipe the old key
  }

  if (Object.keys(data).length > 0) {
    await db.customProvider.update({ where: { id }, data });
    if (typeof data.keyCipher === "string" && data.keyCipher === "PENDING") {
      await storeProviderKey(id, apiKey);
    }
  }

  let probe: { ok: boolean; code: string; detail: string } | null = null;
  let modelProbes: { model: string; ok: boolean; code: string; detail: string }[] = [];
  if (body?.probe === true) {
    probe = await probeCustomProvider(id).catch(() => ({ ok: false, code: "PROBE_ERROR", detail: "Probe failed unexpectedly." }));
    // Per-model verdicts from the FINAL list (after this update) — up to 3, parallel.
    const updated = await getCustomProviderRow(id);
    const list = updated ? parseProviderModels(updated.models) : [];
    if (list.length > 0) {
      modelProbes = await Promise.all(
        list.slice(0, 3).map((m) =>
          probeCustomProviderModel(id, m).catch(() => ({
            model: m,
            ok: false,
            code: "PROBE_ERROR",
            detail: "Probe failed unexpectedly.",
          })),
        ),
      );
    }
  }

  return NextResponse.json({ ok: true, probe, modelProbes });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`custom-providers:${clientKey(req)}`, 30, 60_000)) {
    return err("RATE_LIMITED", "Too many requests — slow down.", 429);
  }
  const { id } = await ctx.params;
  const removed = await db.customProvider.deleteMany({ where: { id } });
  // Idempotent: deleting an absent row is still a success.
  return NextResponse.json({ ok: true, removed: removed.count });
}
