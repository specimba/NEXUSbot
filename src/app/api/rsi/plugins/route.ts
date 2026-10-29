import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET  /api/rsi/plugins — plugin ledger, NEWEST-FIRST (repo F-1 lesson).
 * POST /api/rsi/plugins {name, kind, promptDelta, description, sourceArxiv}
 *      — create a DRAFT plugin (status "draft") for manual candidate testing.
 *        Engine-synthesized plugins are status "active" on their cycle.
 */
export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`rsi-plugins-list:${clientKey(req)}`, 60, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "slow down — 60 plugin reads per minute" } },
      { status: 429 },
    );
  }
  const plugins = await db.rsiPlugin.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
  return NextResponse.json({
    ok: true,
    plugins: plugins.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      payload: p.payload,
      description: p.description,
      sourceArxiv: p.sourceArxiv,
      status: p.status,
      cycleId: p.cycleId,
      createdAt: p.createdAt,
    })),
  });
}

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`rsi-plugins-create:${clientKey(req)}`, 10, 10 * 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "10 plugin drafts per 10 minutes" } },
      { status: 429 },
    );
  }
  const body = (await req.json().catch(() => null)) as
    | { name?: unknown; kind?: unknown; promptDelta?: unknown; description?: unknown; sourceArxiv?: unknown }
    | null;
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
  const kind = body?.kind === "prompt-delta" ? "prompt-delta" : "prompt-delta";
  const promptDelta = typeof body?.promptDelta === "string" ? body.promptDelta.trim().slice(0, 4000) : "";
  const description = typeof body?.description === "string" ? body.description.trim().slice(0, 400) : "";
  const sourceArxiv = typeof body?.sourceArxiv === "string" ? body.sourceArxiv.trim().slice(0, 40) : "";
  if (name.length < 3 || promptDelta.length === 0) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_INPUT", message: "name (>=3 chars) and promptDelta are required" } },
      { status: 400 },
    );
  }
  const plugin = await db.rsiPlugin.create({
    data: {
      name,
      kind,
      payload: JSON.stringify({ promptDelta, notes: description, inspirationArxiv: sourceArxiv ? [sourceArxiv] : [] }),
      description,
      sourceArxiv,
      status: "draft",
    },
  });
  return NextResponse.json({ ok: true, plugin: { id: plugin.id, name: plugin.name, status: plugin.status } });
}
