import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  hasBrainAccess,
  clampStr,
  redactSecrets,
  FLAG_SEVERITY,
  VALID_FLAGS,
} from "@/lib/brain/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { mirrorInteraction, mirrorLesson } from "@/lib/brain/mirror";

/**
 * POST /api/brain/log — the pipeline catch (owner ask, v29.8).
 *
 * EVERY brain interaction ends here: chat replies, direct replies (model /
 * credits / imagine), refusals, fallbacks and hard failures alike. Rows feed
 * the panel Pipeline tab for evaluation + training, and abuse attempts are
 * folded into SecurityLesson so the brain keeps a consistent security memory.
 */
export async function POST(req: Request) {
  if (!rateLimit(`brain-log:${clientKey(req)}`, 240, 60_000)) {
    return NextResponse.json({ ok: false, error: "rate limited" }, { status: 429 });
  }
  if (!(await hasBrainAccess(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json body" }, { status: 400 });
  }

  const username = clampStr(body.username, 60).toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (!username) {
    return NextResponse.json({ ok: false, error: "username required" }, { status: 400 });
  }

  const flagsRaw = Array.isArray(body.flags) ? body.flags : [];
  const flags = flagsRaw
    .map((f) => clampStr(f, 40).toUpperCase())
    .filter((f) => VALID_FLAGS.has(f));
  const uniqueFlags = Array.from(new Set(flags));
  const injectionScore = uniqueFlags.reduce((max, f) => Math.max(max, FLAG_SEVERITY[f] ?? 1), 0);

  const message = clampStr(redactSecrets(body.message), 2000);
  const response = clampStr(redactSecrets(body.response), 2000);
  const status = clampStr(body.status, 24) || "ok";

  let latencyMs: number | null = null;
  if (typeof body.latencyMs === "number" && Number.isFinite(body.latencyMs)) {
    latencyMs = Math.min(600_000, Math.max(0, Math.round(body.latencyMs)));
  }
  const promptTokens =
    typeof body.promptTokens === "number" && Number.isFinite(body.promptTokens)
      ? Math.min(1_000_000, Math.max(0, Math.round(body.promptTokens)))
      : null;
  const completionTokens =
    typeof body.completionTokens === "number" && Number.isFinite(body.completionTokens)
      ? Math.min(1_000_000, Math.max(0, Math.round(body.completionTokens)))
      : null;

  const row = await db.interactionLog.create({
    data: {
      channel: clampStr(body.channel, 40).toLowerCase() || "specimba",
      username,
      displayHandle: clampStr(body.displayHandle, 60) || username,
      command: clampStr(body.command, 24).toLowerCase() || "ai",
      message,
      response,
      model: clampStr(body.model, 80),
      modelId: clampStr(body.modelId, 120),
      provider: clampStr(body.provider, 24).toLowerCase(),
      route: clampStr(body.route, 80),
      status,
      latencyMs,
      promptTokens,
      completionTokens,
      webUsed: body.webUsed === true,
      flags: JSON.stringify(uniqueFlags),
      injectionScore,
      memoryUsed: body.memoryUsed === true,
      error: clampStr(body.error, 300),
    },
  });

  // Security memory — fold each flagged technique into a persistent lesson.
  if (uniqueFlags.length > 0) {
    const snippet = clampStr(redactSecrets(message).replace(/\s+/g, " "), 120);
    const counter = clampStr(response.replace(/\s+/g, " "), 200);
    for (const technique of uniqueFlags) {
      const lesson = await db.securityLesson
        .upsert({
          where: { technique_username: { technique, username } },
          create: {
            technique,
            username,
            snippet,
            counter,
            hits: 1,
            severity: FLAG_SEVERITY[technique] ?? 1,
            lastSeenAt: new Date(),
          },
          update: {
            hits: { increment: 1 },
            lastSeenAt: new Date(),
            counter: counter || undefined,
          },
        })
        .catch(() => null);
      if (lesson) mirrorLesson(lesson);
    }
  }

  // Supabase mirror (owner ask: local-first panel DB + cloud copy) — best-effort,
  // fire-and-forget: a mirror outage must never slow the live pipeline.
  mirrorInteraction(row);

  return NextResponse.json({ ok: true, id: row.id });
}
