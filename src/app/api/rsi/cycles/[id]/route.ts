import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { db } from "@/lib/db";
import { verifyCycleChain } from "@/lib/rsi/engine";

export const dynamic = "force-dynamic";

/**
 * GET /api/rsi/cycles/{id} — full cycle detail: the cycle row, the complete
 * hash-chained event ledger, the linked paired runs, the linked plugin, and
 * chainOk recomputed by replay (G8 audit truth available at any moment, not
 * just at the AUDIT stage).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`rsi-cycle-detail:${clientKey(req)}`, 120, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "slow down — 120 detail reads per minute" } },
      { status: 429 },
    );
  }
  const { id } = await ctx.params;
  const cycle = await db.rsiCycle.findUnique({ where: { id } });
  if (!cycle) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "no such cycle" } },
      { status: 404 },
    );
  }

  const [events, runs, plugin, chain] = await Promise.all([
    db.rsiCycleEvent.findMany({ where: { cycleId: id }, orderBy: { seq: "asc" } }),
    db.rsiRun.findMany({ where: { cycleId: id }, orderBy: { createdAt: "desc" } }),
    cycle.pluginId ? db.rsiPlugin.findUnique({ where: { id: cycle.pluginId } }) : Promise.resolve(null),
    verifyCycleChain(id),
  ]);

  return NextResponse.json({
    ok: true,
    cycle: {
      id: cycle.id,
      name: cycle.name,
      thesis: cycle.thesis,
      techniqueRefs: cycle.techniqueRefs,
      status: cycle.status,
      stageData: cycle.stageData,
      baselineSnapshotChars: cycle.baselineSnapshot.length,
      // v38 — the full snapshot text (6.8 KB+ today, grows with lore) was
      // shipped on EVERY 10s detail poll but never rendered (chars only).
      // Strip it; the runner reads it server-side from the DB row directly.
      pluginId: cycle.pluginId,
      suiteIds: cycle.suiteIds,
      gateResults: cycle.gateResults,
      createdAt: cycle.createdAt,
      updatedAt: cycle.updatedAt,
    },
    events: events.map((e) => ({
      id: e.id,
      seq: e.seq,
      stage: e.stage,
      type: e.type,
      payload: e.payload,
      prevHash: e.prevHash.slice(0, 8),
      hash: e.hash.slice(0, 8),
      createdAt: e.createdAt,
    })),
    runs: runs.map((r) => ({
      id: r.id,
      suiteId: r.suiteId,
      variant: r.variant,
      status: r.status,
      passRate: r.passRate,
      judgeAvg: r.judgeAvg,
      abstainRate: r.abstainRate,
      latencyP50Ms: r.latencyP50Ms,
      latencyP95Ms: r.latencyP95Ms,
      costUnits: r.costUnits,
      compositeScore: r.compositeScore,
      error: r.error,
      createdAt: r.createdAt,
    })),
    plugin: plugin
      ? {
          id: plugin.id,
          name: plugin.name,
          status: plugin.status,
          payload: plugin.payload,
          description: plugin.description,
          sourceArxiv: plugin.sourceArxiv,
        }
      : null,
    chain,
  });
}
