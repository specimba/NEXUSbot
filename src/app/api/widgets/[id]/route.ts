import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { validateWidgetPayload } from "@/lib/widgets/runtime";
import { toWidgetApi } from "@/lib/widgets/api";

/**
 * GET    /api/widgets/[id] — full widget row.
 * PUT    /api/widgets/[id] — partial update; every field optional, validated
 *        by the same clamp/validator as POST.
 * DELETE — removes the widget. Idempotent.
 */

function err(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const denied = await requireSession();
  if (denied) return denied;
  const { id } = await ctx.params;
  const widget = await db.widget.findUnique({ where: { id } });
  if (!widget) return err("NOT_FOUND", "Widget not found.", 404);
  return NextResponse.json({ ok: true, widget: toWidgetApi(widget) });
}

export async function PUT(req: Request, ctx: Ctx) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`widgets:${clientKey(req)}`, 60, 60_000)) {
    return err("RATE_LIMITED", "Too many widget updates — slow down.", 429);
  }
  const { id } = await ctx.params;
  const existing = await db.widget.findUnique({ where: { id } });
  if (!existing) return err("NOT_FOUND", "Widget not found.", 404);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return err("BAD_INPUT", "body must be JSON.", 400);

  const data: Record<string, unknown> = {};
  if (
    body.name !== undefined ||
    body.width !== undefined ||
    body.height !== undefined ||
    body.html !== undefined ||
    body.css !== undefined ||
    body.js !== undefined ||
    body.variables !== undefined
  ) {
    const v = validateWidgetPayload({
      name: body.name ?? existing.name,
      width: body.width ?? existing.width,
      height: body.height ?? existing.height,
      html: body.html ?? existing.html,
      css: body.css ?? existing.css,
      js: body.js ?? existing.js,
      variables: body.variables ?? existing.variables,
    });
    if ("error" in v) return err("BAD_WIDGET", v.error, 400);
    Object.assign(data, v);
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return err("BAD_ENABLED", "enabled must be a boolean.", 400);
    data.enabled = body.enabled;
  }

  const widget = await db.widget.update({ where: { id }, data });
  return NextResponse.json({ ok: true, widget: toWidgetApi(widget) });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`widgets:${clientKey(req)}`, 30, 60_000)) {
    return err("RATE_LIMITED", "Too many requests — slow down.", 429);
  }
  const { id } = await ctx.params;
  const removed = await db.widget.deleteMany({ where: { id } });
  // Idempotent: deleting an absent widget is still a success.
  return NextResponse.json({ ok: true, removed: removed.count });
}
