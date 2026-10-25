import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import {
  getCustomProviderRow,
  isPlausibleProviderKey,
  isValidCustomBaseUrl,
  normalizeCustomBaseUrl,
  probeCustomProvider,
  storeProviderKey,
} from "@/lib/connectors/custom-provider";

/**
 * PUT    /api/providers/custom/[id] — partial update. A non-empty apiKey
 *        replaces the stored key; an absent/empty apiKey leaves it untouched.
 *        `probe: true` runs a MEASURED probe after the update.
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
    data.model = body.model.trim().slice(0, 128);
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
  if (body?.probe === true) {
    probe = await probeCustomProvider(id).catch(() => ({ ok: false, code: "PROBE_ERROR", detail: "Probe failed unexpectedly." }));
  }

  return NextResponse.json({ ok: true, probe });
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
