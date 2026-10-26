import { NextResponse } from "next/server";
import { hasBrainAccess, clampStr, isRosterAdmin } from "@/lib/brain/auth";
import { runCortex, cortexRateAllows } from "@/lib/brain/cortex";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/brain/cortex — the panel-side brain (v29.13).
 *
 * The widget's FIRST brain hop (same origin in OBS, x-nexus-token auth).
 * Every intent either answers or reports exactly what it is doing — the
 * "Modeller meşgul" dead-air era is over by construction: the model race
 * inside runCortex has a guaranteed final tier.
 *
 * Body: { sender, prompt, streamerName?, channel?, memoryTurns?[],
 *         roomTranscript?, isResearchHint? }
 * Reply: { ok, intent, reply, modelLabel, provider, route, drawSubject?,
 *          sources?, telemetry }
 */
export async function POST(req: Request) {
  if (!(await hasBrainAccess(req))) {
    return NextResponse.json(
      { ok: false, error: { code: "UNAUTHORIZED", message: "Brain access denied" } },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_INPUT", message: "Body must be JSON" } },
      { status: 400 },
    );
  }

  const sender = clampStr(body.sender, 60);
  const prompt = clampStr(body.prompt, 800);
  if (!sender || !prompt.trim()) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_INPUT", message: "sender and prompt are required" } },
      { status: 400 },
    );
  }

  const rosterAdmin = isRosterAdmin(sender);
  if (!cortexRateAllows(sender, rosterAdmin)) {
    return NextResponse.json(
      {
        ok: true,
        intent: "CHAT",
        reply: "Hız limiti — birkaç saniye nefes al, sıra sende. 🎛",
        modelLabel: "VYCE // RATE_GUARD",
        provider: "tool",
        route: "cortex-rate",
        telemetry: { latencyMs: 0, webSearch: "none" as const, intentMs: 0 },
      },
      { status: 200 },
    );
  }

  const memoryTurns = Array.isArray(body.memoryTurns)
    ? (body.memoryTurns as Array<Record<string, unknown>>)
        .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
        .slice(-10)
        .map((t) => ({ role: String(t.role), content: clampStr(t.content, 600) }))
    : [];

  const result = await runCortex({
    sender,
    prompt,
    streamerName: clampStr(body.streamerName, 60) || "specimba",
    channel: clampStr(body.channel, 40).toLowerCase() || "specimba",
    memoryTurns,
    roomTranscript: clampStr(body.roomTranscript, 1_200),
    isResearchHint: body.isResearchHint === true,
  });

  return NextResponse.json(result, { status: 200 });
}
