import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { syncSeedWidget } from "@/lib/widgets/seed";

export const dynamic = "force-dynamic";

/**
 * POST /api/widgets/[id]/sync-seed — explicit, session-gated overwrite of the
 * widget's html/css/js from the repo seed (v35.1). Owner VARIABLES, geometry
 * and enabled state are always preserved. The auto-sync in ensureSeedWidgets
 * deliberately refuses to touch code that was edited in the panel; this is the
 * owner's "I know, take the seed" button. An Event row records every force
 * sync (audit trail). After a sync the OBS Browser Source must be refreshed
 * once to run the new code — the stream endpoint always serves the saved state.
 */
function err(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`widget-sync-seed:${clientKey(req)}`, 10, 60_000)) {
    return err("RATE_LIMITED", "Too many sync attempts — slow down.", 429);
  }

  const { id } = await ctx.params;
  const widget = await db.widget.findUnique({ where: { id }, select: { id: true, seeded: true } });
  if (!widget) return err("NOT_FOUND", "Widget not found.", 404);
  if (!widget.seeded) {
    return err("NOT_SEEDED", "Only the seeded NEXUS widget syncs from the repo seed.", 400);
  }

  const result = await syncSeedWidget(id, { force: true });
  if (!result.ok) {
    return err("SYNC_FAILED", result.detail, 500);
  }
  return NextResponse.json({
    ok: true,
    mode: result.mode,
    jsHash: result.jsHash.slice(0, 12),
    detail: result.detail,
  });
}
