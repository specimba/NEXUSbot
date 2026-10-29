import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/rsi/runs/{id} — the full run row: aggregate metrics, engine truth
 * {provider, modelId} JSON and the per-task results array (verdict detail,
 * judgeScore, latency, tokens, replyExcerpt, provider/modelId per task).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`rsi-run-detail:${clientKey(req)}`, 120, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "slow down — 120 detail reads per minute" } },
      { status: 429 },
    );
  }
  const { id } = await ctx.params;
  const run = await db.rsiRun.findUnique({ where: { id } });
  if (!run) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "no such run" } },
      { status: 404 },
    );
  }
  const suite = await db.rsiSuite.findUnique({ where: { id: run.suiteId } });
  let results: unknown[] = [];
  let engine: unknown = {};
  try {
    results = JSON.parse(run.resultsJson || "[]") as unknown[];
  } catch {
    results = [];
  }
  try {
    engine = JSON.parse(run.engineJson || "{}") as unknown;
  } catch {
    engine = {};
  }
  return NextResponse.json({
    ok: true,
    run: {
      id: run.id,
      suiteId: run.suiteId,
      suiteKey: suite?.key ?? null,
      suiteName: suite?.name ?? null,
      cycleId: run.cycleId,
      pluginId: run.pluginId,
      variant: run.variant,
      status: run.status,
      passRate: run.passRate,
      judgeAvg: run.judgeAvg,
      abstainRate: run.abstainRate,
      latencyP50Ms: run.latencyP50Ms,
      latencyP95Ms: run.latencyP95Ms,
      tokensAvg: run.tokensAvg,
      costUnits: run.costUnits,
      compositeScore: run.compositeScore,
      error: run.error,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      results,
      engine,
    },
  });
}
