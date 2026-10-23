import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";

/**
 * GET  /api/usage (session required) — usage ledger aggregates.
 *      Image credits are the ONLY per-user surfaced number (grok-imagine
 *      creations — a print shop charges per print, not per electricity).
 *      LLM usage is monitored internally only and is never surfaced as
 *      user-facing cost.
 *
 * POST /api/usage (session OR `Authorization: Bearer <ingest-token>`, mirroring
 *      /api/events) — append one counter row {kind, model, userHandle?,
 *      credits?, latencyMs?, ok?}.
 *
 * P7: this ledger stores counters ONLY. Prompt/response content must never be
 * sent to or stored by this route; `meta` is reserved for internal writers
 * (src/lib/ai/client.ts) and is not accepted from callers.
 */

const KINDS = new Set(["image", "llm"]);

function clampStr(v: unknown, n: number): string {
  return typeof v === "string" ? v.trim().slice(0, n) : "";
}

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`usage:${clientKey(req)}`, 60, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many requests — slow down." } },
      { status: 429 },
    );
  }

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  // IMAGE — the only per-user surfaced credit surface.
  const imageByUser = await db.usageEvent.groupBy({
    by: ["userHandle"],
    where: { kind: "image", userHandle: { not: null } },
    _sum: { credits: true },
    _count: { _all: true },
  });
  const imageTotal = await db.usageEvent.aggregate({
    where: { kind: "image" },
    _sum: { credits: true },
    _count: { _all: true },
  });

  // LLM — internal monitoring only.
  const [llmToday, llmModels] = await Promise.all([
    db.usageEvent.count({ where: { kind: "llm", ts: { gte: startOfToday } } }),
    db.usageEvent.groupBy({
      by: ["model"],
      where: { kind: "llm", ts: { gte: startOfToday } },
      _count: { _all: true },
    }),
  ]);

  const byUser = imageByUser
    .map((row) => ({
      userHandle: row.userHandle ?? "(unknown)",
      credits: row._sum.credits ?? 0,
      count: row._count._all,
    }))
    .sort((a, b) => b.credits - a.credits);

  const todayModels = llmModels
    .map((row) => ({ model: row.model, count: row._count._all }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  return NextResponse.json({
    ok: true,
    image: {
      byUser,
      totalCredits: imageTotal._sum.credits ?? 0,
      totalCount: imageTotal._count._all,
    },
    llm: {
      todayCalls: llmToday,
      todayModels,
      note: "LLM usage is monitored internally only — never surfaced as user-facing cost",
    },
  });
}

export async function POST(req: Request) {
  // Auth: panel session OR bearer ingest token (same contract as /api/events).
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  if (bearer) {
    const token = await db.ingestToken.findUnique({ where: { tokenHash: createHash("sha256").update(bearer).digest("hex") } });
    if (!token || token.revokedAt) {
      return NextResponse.json(
        { ok: false, error: { code: "BAD_TOKEN", message: "Invalid ingest token" } },
        { status: 401 },
      );
    }
    await db.ingestToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } });
  } else {
    const denied = await requireSession();
    if (denied) return denied;
  }

  if (!rateLimit(`usage-post:${bearer ? "token" : clientKey(req)}`, 120, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many usage writes — slow down." } },
      { status: 429 },
    );
  }

  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_BODY", message: "JSON body required" } },
      { status: 400 },
    );
  }

  const kind = clampStr(raw.kind, 16);
  if (!KINDS.has(kind)) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_KIND", message: 'kind must be "image" or "llm"' } },
      { status: 400 },
    );
  }

  const model = clampStr(raw.model, 128);
  if (!model) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_MODEL", message: "model is required (1–128 chars)" } },
      { status: 400 },
    );
  }

  const userHandleRaw = clampStr(raw.userHandle, 64);
  // Image credits are per-@username; other kinds must not carry a userHandle.
  const userHandle = kind === "image" && userHandleRaw ? (userHandleRaw.startsWith("@") ? userHandleRaw : `@${userHandleRaw}`) : null;

  let credits = 0;
  if (raw.credits !== undefined && raw.credits !== null) {
    const n = Number(raw.credits);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
      return NextResponse.json(
        { ok: false, error: { code: "BAD_CREDITS", message: "credits must be a number between 0 and 1000000" } },
        { status: 400 },
      );
    }
    credits = n;
  }

  let latencyMs: number | undefined;
  if (raw.latencyMs !== undefined && raw.latencyMs !== null) {
    const n = Number(raw.latencyMs);
    if (!Number.isInteger(n) || n < 0 || n > 3_600_000) {
      return NextResponse.json(
        { ok: false, error: { code: "BAD_LATENCY", message: "latencyMs must be an integer between 0 and 3600000" } },
        { status: 400 },
      );
    }
    latencyMs = n;
  }

  const ok = raw.ok === undefined ? true : raw.ok === true;

  const created = await db.usageEvent.create({
    data: { kind, model, userHandle, credits, ok, latencyMs, meta: "{}" },
  });

  return NextResponse.json(
    { ok: true, id: created.id, kind, model, userHandle, credits, latencyMs: latencyMs ?? null },
    { status: 201 },
  );
}
