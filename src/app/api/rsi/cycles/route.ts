import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { db } from "@/lib/db";
import { createCycle } from "@/lib/rsi/engine";
import { ensurePapersSeeded } from "@/lib/rsi/seed";

export const dynamic = "force-dynamic";

/**
 * GET  /api/rsi/cycles — cycle rows, NEWEST-FIRST (repo F-1 lesson).
 * POST /api/rsi/cycles {name, thesis, module, techniqueRefs[]} — open a cycle
 *      at stage "scout". The baselineSnapshot is captured from the CURRENT
 *      persona prompt (cortex buildSystemPrompt, read-only import) so every
 *      cycle's numbers are attributable to an exact baseline artifact.
 */
export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`rsi-cycles-list:${clientKey(req)}`, 60, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "slow down — 60 cycle reads per minute" } },
      { status: 429 },
    );
  }
  const url = new URL(req.url);
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "30", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 30;

  const cycles = await db.rsiCycle.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  return NextResponse.json({
    ok: true,
    cycles: cycles.map((c) => ({
      id: c.id,
      name: c.name,
      thesis: c.thesis,
      techniqueRefs: c.techniqueRefs,
      status: c.status,
      pluginId: c.pluginId,
      gateResults: c.gateResults,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
  });
}

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`rsi-cycles-create:${clientKey(req)}`, 10, 10 * 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "10 new cycles per 10 minutes — cycles are deliberate" } },
      { status: 429 },
    );
  }
  const body = (await req.json().catch(() => null)) as
    | { name?: unknown; thesis?: unknown; module?: unknown; techniqueRefs?: unknown }
    | null;
  const name = typeof body?.name === "string" ? body.name : "";
  const thesis = typeof body?.thesis === "string" ? body.thesis : "";
  const moduleScope = typeof body?.module === "string" ? body.module : "";
  const refs = Array.isArray(body?.techniqueRefs)
    ? (body!.techniqueRefs as unknown[]).filter((r): r is string => typeof r === "string")
    : [];

  await ensurePapersSeeded();

  const res = await createCycle({ name, thesis, module: moduleScope, techniqueRefs: refs });
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: { code: res.code, message: res.message } }, { status: 400 });
  }
  return NextResponse.json({
    ok: true,
    cycle: {
      id: res.cycle.id,
      name: res.cycle.name,
      status: res.cycle.status,
      createdAt: res.cycle.createdAt,
    },
  });
}
