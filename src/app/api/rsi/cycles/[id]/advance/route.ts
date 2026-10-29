import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { advanceCycle } from "@/lib/rsi/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/rsi/cycles/{id}/advance — run the next stage of the 9-stage spine.
 * Body (optional): {suiteIds?: string[], confirm?: boolean, researchJobId?: string}.
 *
 *   scout      → mine evidence (0 LLM calls)
 *   thesis     → validate the owner thesis (0 calls)
 *   synthesize → draft the plugin (1-2 z-ai calls, budget-capped)
 *   shadow-eval → kick paired runs ({pending:true} while legs are in flight)
 *   pareto-gate → grade G1/G2/G3/G5/G7 (G4/G6 recorded PENDING honestly)
 *   canary    → one live candidate-side call on the designated canary task
 *   promote   → OWNER HUMAN GATE — requires {confirm:true}; records adoption
 *               ONLY; deploy stays a manual Edge Cortex Deploy action
 *   audit     → re-hash frozen suites + replay the event chain
 *   record    → final ledger event → status adopted
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`rsi-cycle-advance:${clientKey(req)}`, 20, 10 * 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "20 advances per 10 minutes — stages are deliberate" } },
      { status: 429 },
    );
  }
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    suiteIds?: unknown;
    confirm?: unknown;
    researchJobId?: unknown;
  };
  const suiteIds = Array.isArray(body.suiteIds)
    ? (body.suiteIds as unknown[]).filter((s): s is string => typeof s === "string")
    : undefined;
  const researchJobId = typeof body.researchJobId === "string" ? body.researchJobId : undefined;

  const res = await advanceCycle(id, { suiteIds, confirm: body.confirm === true, researchJobId });
  if (!res.ok) {
    const status =
      res.code === "NOT_FOUND" ? 404 : res.code === "CYCLE_BUSY" ? 409 : res.code === "CYCLE_TERMINAL" ? 409 : 400;
    return NextResponse.json({ ok: false, error: { code: res.code, message: res.message } }, { status });
  }
  return NextResponse.json({
    ok: true,
    cycle: { id: res.cycle.id, name: res.cycle.name, status: res.cycle.status, updatedAt: res.cycle.updatedAt },
    event: res.event
      ? {
          seq: res.event.seq,
          stage: res.event.stage,
          type: res.event.type,
          hash: res.event.hash.slice(0, 8),
          createdAt: res.event.createdAt,
        }
      : undefined,
    pending: res.pending ?? undefined,
    runs: res.runs ?? undefined,
    note: res.note ?? undefined,
  });
}
