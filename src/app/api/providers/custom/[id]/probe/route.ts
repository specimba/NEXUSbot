import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { probeCustomProvider } from "@/lib/connectors/custom-provider";

/**
 * POST /api/providers/custom/[id]/probe — MEASURED live probe of the gateway
 * (GET models endpoint with the stored key when present). The verdict is also
 * persisted on the row (lastProbe* fields) so the card shows the truth even
 * before the next list fetch. Static verdict strings only — never key material.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`custom-providers-probe:${clientKey(req)}`, 20, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many probes — slow down." } },
      { status: 429 },
    );
  }
  const { id } = await ctx.params;
  const probe = await probeCustomProvider(id).catch(() => ({
    ok: false,
    code: "PROBE_ERROR",
    detail: "Probe failed unexpectedly.",
  }));
  return NextResponse.json({ ok: true, probe });
}
