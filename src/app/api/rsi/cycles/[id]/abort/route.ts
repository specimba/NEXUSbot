import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { abortCycle } from "@/lib/rsi/engine";

export const dynamic = "force-dynamic";

/**
 * POST /api/rsi/cycles/{id}/abort — owner Abort: any live stage → "aborted"
 * with a chain event; an active (non-gate-passed) plugin from this cycle is
 * demoted to "rejected". Terminal cycles refuse honestly.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`rsi-cycle-abort:${clientKey(req)}`, 10, 10 * 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "10 aborts per 10 minutes" } },
      { status: 429 },
    );
  }
  const { id } = await ctx.params;
  const res = await abortCycle(id);
  if (!res.ok) {
    const status = res.code === "NOT_FOUND" ? 404 : res.code === "CYCLE_TERMINAL" ? 409 : 400;
    return NextResponse.json({ ok: false, error: { code: res.code, message: res.message } }, { status });
  }
  return NextResponse.json({
    ok: true,
    cycle: { id: res.cycle.id, status: res.cycle.status },
    note: res.note ?? "cycle aborted — negative evidence preserved on the chain",
  });
}
