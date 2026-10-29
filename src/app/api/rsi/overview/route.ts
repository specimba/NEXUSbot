import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { db } from "@/lib/db";
import { ensurePapersSeeded, ensureSuitesSeeded } from "@/lib/rsi/seed";
import { rsiBudgetState } from "@/lib/rsi/budget";
import { verifyCycleChain } from "@/lib/rsi/engine";

export const dynamic = "force-dynamic";

/**
 * GET /api/rsi/overview — the RSI Lab landing numbers. Lazy-seeds the paper
 * library + frozen suites (cheap count checks when rows exist), then returns
 * live counts only: papers, suites/tasks, cycles by status, runs today +
 * budget state, active cycles and the 10 most recent chain events across all
 * cycles (each flagged chain-verified by replaying its cycle's chain).
 */
export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`rsi-overview:${clientKey(req)}`, 60, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "slow down — 60 overview reads per minute" } },
      { status: 429 },
    );
  }

  const papersCount = await ensurePapersSeeded();
  const suitesCount = await ensureSuitesSeeded();
  const tasksCount = await db.rsiTask.count();

  const dayStart = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  const [cyclesAll, runsToday, doneRuns, errorRuns, budget, activeCycles, recentEvents] = await Promise.all([
    db.rsiCycle.findMany({ select: { status: true } }),
    db.rsiRun.count({ where: { createdAt: { gte: dayStart } } }),
    db.rsiRun.count({ where: { status: "done" } }),
    db.rsiRun.count({ where: { status: "error" } }),
    rsiBudgetState(),
    db.rsiCycle.findMany({
      where: {
        status: {
          in: ["scout", "thesis", "synthesize", "shadow-eval", "pareto-gate", "canary", "promote", "audit", "record"],
        },
      },
      select: { id: true, name: true, status: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: 6,
    }),
    db.rsiCycleEvent.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
  ]);

  const cyclesByStatus: Record<string, number> = {};
  for (const c of cyclesAll) cyclesByStatus[c.status] = (cyclesByStatus[c.status] ?? 0) + 1;

  // Chain-verify each distinct cycle that appears in the recent-events slice.
  const cycleIds = [...new Set(recentEvents.map((e) => e.cycleId))];
  const chainOkByCycle = new Map<string, boolean>();
  for (const id of cycleIds) {
    const v = await verifyCycleChain(id);
    chainOkByCycle.set(id, v.ok);
  }

  return NextResponse.json({
    ok: true,
    papers: papersCount,
    suites: suitesCount,
    tasks: tasksCount,
    cycles: cyclesByStatus,
    runs: { today: runsToday, done: doneRuns, error: errorRuns },
    budget,
    activeCycles: activeCycles.map((c) => ({ id: c.id, name: c.name, status: c.status, updatedAt: c.updatedAt })),
    recentEvents: recentEvents.map((e) => ({
      id: e.id,
      cycleId: e.cycleId,
      seq: e.seq,
      stage: e.stage,
      type: e.type,
      hash: e.hash.slice(0, 8),
      createdAt: e.createdAt,
      chainVerified: chainOkByCycle.get(e.cycleId) ?? false,
    })),
  });
}
