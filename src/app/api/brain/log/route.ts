import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hasBrainAccess, clampStr, redactSecrets } from "@/lib/brain/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { mirrorInteraction } from "@/lib/brain/mirror";
import { computeSecurityFlags, foldSecurityLessons } from "@/lib/brain/security-lesson";
import { cortexResultPeek, interactionRowDuplicate } from "@/lib/brain/cortex";

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

  // v34 — SERVER-AUTHORITATIVE INJECTION DETECTION. The panel-cortex and
  // kick-webhook paths never computed flags (only the OBS overlay widget
  // did), so live [SYSTEM INSTRUCTION] / "kuralları devre dışı bırak" attacks
  // landed as unflagged rows and Security Memory stayed empty. Detection now
  // recomputes from the raw message here — caller flags still merge on top.
  // v34.1 — the fold lives in the SHARED module now: the webhook's
  // writeInteractionRow (which wins the row for live chat) uses the exact
  // same computation, so both writers cannot drift apart again.
  const uniqueFlagsAndScore = computeSecurityFlags(String(body.message ?? ""), body.flags);
  const uniqueFlags = uniqueFlagsAndScore.flags;
  const injectionScore = uniqueFlagsAndScore.injectionScore;

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
  // v31.6 — engine truth rides the same server-authoritative enrichment:
  // the widget may post a stale/empty modelId, the panel's own result trail
  // is the truth for rows it produced.
  let finalModelId = clampStr(body.modelId, 120);
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
    if (s.modelId) finalModelId = clampStr(s.modelId, 120);
    if (typeof stored.memoryUsed === "boolean") memoryUsed = stored.memoryUsed;
    if (!finalResponse.trim() && s.reply) {
      finalResponse = clampStr(redactSecrets(s.reply), 2000);
    }
    if (finalLatencyMs === null && typeof s.telemetry?.latencyMs === "number") {
      finalLatencyMs = Math.min(600_000, Math.max(0, Math.round(s.telemetry.latencyMs)));
    }
  }

  // v31.4 — one row per exchange: when the official webhook already logged
  // the coalesced answer for this identical (user, message, response), this
  // POST is the overlay mount reporting the same exchange — skip the dupe.
  if (interactionRowDuplicate(username, message, finalResponse)) {
    return NextResponse.json({ ok: true, deduped: true });
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
      modelId: finalModelId,
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

  // Security memory — fold each flagged technique into a persistent lesson
  // (shared fold, best-effort inside the module).
  if (uniqueFlags.length > 0) {
    await foldSecurityLessons({
      username,
      message,
      response: finalResponse,
      techniques: uniqueFlags,
    });
  }

  // Supabase mirror (owner ask: local-first panel DB + cloud copy) — best-effort,
  // fire-and-forget: a mirror outage must never slow the live pipeline.
  mirrorInteraction(row);

  return NextResponse.json({ ok: true, id: row.id });
}
