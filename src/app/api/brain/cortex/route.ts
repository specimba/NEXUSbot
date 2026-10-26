import { NextResponse } from "next/server";
import { hasBrainAccess, clampStr, isRosterAdmin } from "@/lib/brain/auth";
import {
  cortexEchoLookup,
  cortexEchoRemember,
  cortexRateAllows,
  runCortex,
} from "@/lib/brain/cortex";

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

  // Echo guard FIRST (2026-10-26 double-fire incident): the same Kick message
  // can arrive from two independent widget mounts (OBS overlay + panel
  // preview — per-page localStorage locks cannot dedupe across origins).
  // A duplicate is the same viewer's same message — it must get the SAME
  // answer, never a rate-limit rejection and never a second model spend.
  const echo = cortexEchoLookup(sender, prompt);
  if (echo) {
    return NextResponse.json(echo, { status: 200 });
  }

  if (!cortexRateAllows(sender, rosterAdmin)) {
    return NextResponse.json(
      {
        ok: true,
        intent: "CHAT",
        reply: "Hız limiti — birkaç saniye nefes al, sıra sende. 🎛",
        // v29.19 label truth: this line is spoken by the PANEL's rate guard,
        // not by Vyce — same principle as the v29.17 STATIC floor fix.
        modelLabel: "PANEL // RATE_GUARD",
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
  cortexEchoRemember(sender, prompt, result);

  return NextResponse.json(result, { status: 200 });
}
