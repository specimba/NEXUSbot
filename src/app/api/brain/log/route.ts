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
import { cortexResultPeek } from "@/lib/brain/cortex";

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

  const message = clampStr(redactSecrets(String(body.message ?? "")), 2000);
  const response = clampStr(redactSecrets(String(body.response ?? "")), 2000);
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

  // v29.20 — SERVER-AUTHORITATIVE ENRICHMENT (owner: "I think still you
  // forgot some parts", 2026-10-27 ~03:1x +03). The live OBS overlay can run
  // a pre-v29.18 widget JS generation that drops tokens entirely and computes
  // webUsed from its OWN snippet-read — the column lied in both directions in
  // the same hour ("bana uniq id`ni soyle" web:true with zero searches; the
  // YouTube Exa-answer row web:false WITH citations). When THIS panel produced
  // the answer, its own result trail is the single source of truth and the
  // widget payload stays a fallback for rows the panel never saw (hop-2).
  const stored = cortexResultPeek(username, message);
  let finalPromptTokens = promptTokens;
  let finalCompletionTokens = completionTokens;
  let webUsed = body.webUsed === true;
  let memoryUsed = body.memoryUsed === true;
  let provider = clampStr(body.provider, 24).toLowerCase();
  let route = clampStr(body.route, 80);
  let finalResponse = response;
  let finalLatencyMs = latencyMs;
  if (stored) {
    const s = stored.result;
    if (typeof s.promptTokens === "number") finalPromptTokens = s.promptTokens;
    if (typeof s.completionTokens === "number") finalCompletionTokens = s.completionTokens;
    webUsed = ["exa-answer", "page-read", "web-fallback"].includes(
      s.telemetry?.webSearch ?? "none",
    );
    if (s.provider) provider = clampStr(s.provider, 24).toLowerCase();
    if (s.route) route = clampStr(`panel-cortex/${s.route}`, 80);
    if (typeof stored.memoryUsed === "boolean") memoryUsed = stored.memoryUsed;
    if (!finalResponse.trim() && s.reply) {
      finalResponse = clampStr(redactSecrets(s.reply), 2000);
    }
    if (finalLatencyMs === null && typeof s.telemetry?.latencyMs === "number") {
      finalLatencyMs = Math.min(600_000, Math.max(0, Math.round(s.telemetry.latencyMs)));
    }
  }

  const row = await db.interactionLog.create({
    data: {
      channel: clampStr(body.channel, 40).toLowerCase() || "specimba",
      username,
      displayHandle: clampStr(body.displayHandle, 60) || username,
      command: clampStr(body.command, 24).toLowerCase() || "ai",
      message,
      response: finalResponse,
      model: clampStr(body.model, 80),
      modelId: clampStr(body.modelId, 120),
      provider,
      route,
      status,
      latencyMs: finalLatencyMs,
      promptTokens: finalPromptTokens,
      completionTokens: finalCompletionTokens,
      webUsed,
      flags: JSON.stringify(uniqueFlags),
      injectionScore,
      memoryUsed,
      error: clampStr(body.error, 300),
    },
  });

  // Security memory — fold each flagged technique into a persistent lesson.
  if (uniqueFlags.length > 0) {
    const snippet = clampStr(redactSecrets(message).replace(/\s+/g, " "), 120);
    const counter = clampStr(finalResponse.replace(/\s+/g, " "), 200);
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
