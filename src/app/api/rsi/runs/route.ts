import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { db } from "@/lib/db";
import { startRun } from "@/lib/rsi/runner";
import { ensureSuitesSeeded } from "@/lib/rsi/seed";

export const dynamic = "force-dynamic";

/**
 * POST /api/rsi/runs {suiteId, variant, pluginId?, cycleId?} — queue one
 * paired-battery leg (fire-and-forget executor; the panel polls the list).
 * GET  /api/rsi/runs?limit=20 — run rows, NEWEST-FIRST (repo F-1 lesson).
 */
export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`rsi-runs-list:${clientKey(req)}`, 60, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "slow down — 60 run reads per minute" } },
      { status: 429 },
    );
  }
  const url = new URL(req.url);
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 20;
  await ensureSuitesSeeded();

  const runs = await db.rsiRun.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  return NextResponse.json({
    ok: true,
    runs: runs.map((r) => ({
      id: r.id,
      suiteId: r.suiteId,
      cycleId: r.cycleId,
      pluginId: r.pluginId,
      variant: r.variant,
      status: r.status,
      passRate: r.passRate,
      judgeAvg: r.judgeAvg,
      abstainRate: r.abstainRate,
      latencyP50Ms: r.latencyP50Ms,
      latencyP95Ms: r.latencyP95Ms,
      tokensAvg: r.tokensAvg,
      costUnits: r.costUnits,
      compositeScore: r.compositeScore,
      error: r.error,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
    })),
  });
}

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`rsi-runs-launch:${clientKey(req)}`, 10, 10 * 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "10 run launches per 10 minutes — eval calls are budget-capped" } },
      { status: 429 },
    );
  }
  const body = (await req.json().catch(() => null)) as
    | { suiteId?: unknown; variant?: unknown; pluginId?: unknown; cycleId?: unknown }
    | null;
  const suiteId = typeof body?.suiteId === "string" ? body.suiteId : "";
  const variant = body?.variant === "candidate" ? "candidate" : body?.variant === "baseline" ? "baseline" : "";
  const pluginId = typeof body?.pluginId === "string" && body.pluginId ? body.pluginId : null;
  const cycleId = typeof body?.cycleId === "string" && body.cycleId ? body.cycleId : null;
  if (!suiteId || !variant) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_INPUT", message: "suiteId and variant (baseline|candidate) are required" } },
      { status: 400 },
    );
  }

  const res = await startRun({ suiteId, variant, pluginId, cycleId });
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: { code: res.code, message: res.message } }, { status: 400 });
  }
  return NextResponse.json({ ok: true, run: res.run });
}
