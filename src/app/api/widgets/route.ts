import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { ensureSeedWidgets } from "@/lib/widgets/seed";
import { toWidgetApi } from "@/lib/widgets/api";
import {
  STARTER_WIDGET,
  serializeWidgetVariables,
  validateWidgetPayload,
  type WidgetVariable,
} from "@/lib/widgets/runtime";

/**
 * Self-hosted widget system.
 *
 * GET  /api/widgets — full list (rows are small; the seed "Specimba Cyber AI
 *      Counter" is created once on the first list call, never re-overwritten).
 * POST /api/widgets — create { name, width?, height?, html?, css?, js?,
 *      variables? } (variables = JSON array of {name,label,type,value,secret}).
 *
 * Rendering happens client-side: the panel preview builds an iframe srcDoc via
 * buildWidgetDocument(), and GET /api/widgets/[id]/bundle serves the same
 * document as a single-file OBS Browser Source download. No hosted widget URL
 * exists — local-first, nothing leaves the sandbox.
 */

function err(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`widgets:${clientKey(req)}`, 60, 60_000)) {
    return err("RATE_LIMITED", "Too many requests — slow down.", 429);
  }
  await ensureSeedWidgets();
  const rows = await db.widget.findMany({ orderBy: { createdAt: "asc" } });
  // toWidgetApi strips the OBS-link vault columns and attaches the decrypted
  // stable link (obsLink) — the raw row never leaves the server.
  return NextResponse.json({ ok: true, widgets: rows.map(toWidgetApi) });
}

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`widgets:${clientKey(req)}`, 30, 60_000)) {
    return err("RATE_LIMITED", "Too many widget updates — slow down.", 429);
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return err("BAD_INPUT", "body must be JSON.", 400);

  const v = validateWidgetPayload(body);
  if ("error" in v) return err("BAD_WIDGET", v.error, 400);

  const created = await db.widget.create({
    data: {
      name: v.name,
      width: v.width,
      height: v.height,
      html: v.html || STARTER_WIDGET.html,
      css: v.css || STARTER_WIDGET.css,
      js: v.js || STARTER_WIDGET.js,
      variables:
        body.variables === undefined
          ? serializeWidgetVariables(STARTER_WIDGET.variables as WidgetVariable[])
          : v.variables,
      enabled: body.enabled === false ? false : true,
      seeded: false,
    },
  });
  return NextResponse.json({ ok: true, widget: toWidgetApi(created) }, { status: 201 });
}
