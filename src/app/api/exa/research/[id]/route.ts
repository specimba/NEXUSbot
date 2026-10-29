import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getResearchJob, stopResearchJob } from "@/lib/brain/deep-research";

export const dynamic = "force-dynamic";

/**
 * GET    /api/exa/research/{id} → {ok, job: ResearchDetail} — the card polls
 *        this while a run is active (answer + citations + structured + REAL
 *        costDollars from the Exa API when the agent finishes).
 * DELETE /api/exa/research/{id} → owner Stop: marks the row stopped; the
 *        background runner discards the late result (the spend stays recorded
 *        honestly in the usage ledger).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireSession();
  if (denied) return denied;
  const { id } = await ctx.params;
  const job = await getResearchJob(id);
  if (!job) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "no such research run" } },
      { status: 404 },
    );
  }
  return NextResponse.json({
    ok: true,
    job: {
      id: job.id,
      provider: job.provider,
      query: job.query,
      effort: job.effort,
      status: job.status,
      stopReason: job.stopReason,
      answer: job.answer,
      keyFacts: job.keyFacts,
      citations: job.citations,
      structured: job.structured,
      costDollars: job.costDollars,
      tookMs: job.tookMs,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
    },
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireSession();
  if (denied) return denied;
  const { id } = await ctx.params;
  const job = await stopResearchJob(id);
  if (!job) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "no such research run" } },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, stopped: true, status: job.status });
}
