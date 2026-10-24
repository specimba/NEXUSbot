import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { getUsageDb, redactSecrets } from "@/lib/ai/client";

/**
 * GET  /api/usage (session required) — usage ledger aggregates.
 *      Image credits are the ONLY per-user surfaced number (grok-imagine
 *      creations — a print shop charges per print, not per electricity).
 *      LLM usage is monitored internally only and is never surfaced as
 *      user-facing cost.
 *
 *      R18-d provenance extensions (ADDITIVE — todayCalls/todayModels/note keep
 *      their meaning; todayModels rows keep {model, count} and gain ok/failed):
 *      `todayOk`/`todayFailed` split today's llm calls on `ok`; `recent` is the
 *      last 10 kind:"llm" rows overall (any day) as {ts, model, ok, latencyMs,
 *      source, role, egress, error} — every number the card shows traces back
 *      to a timestamped, attributed UsageEvent row. Meta JSON is parsed
 *      defensively: garbage/missing/oversized or non-string fields degrade to
 *      nulls, and source strings are re-run through redactSecrets() from
 *      @/lib/ai/client (import only) as belt-and-braces before responding.
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

/** Static scalar from parsed meta JSON — null for missing/non-string/oversize. */
function metaScalar(v: unknown, n: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, n) : null;
}

function schemaNotLive() {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "SCHEMA_NOT_LIVE",
        message: "UsageEvent model is not live in this server process yet (dev-server PrismaClient predates the additive db:push) — restart pending.",
      },
    },
    { status: 503 },
  );
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

  const pdb = getUsageDb();
  if (!pdb) return schemaNotLive();

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  // IMAGE — the only per-user surfaced credit surface.
  const imageByUser = await pdb.usageEvent.groupBy({
    by: ["userHandle"],
    where: { kind: "image", userHandle: { not: null } },
    _sum: { credits: true },
    _count: { _all: true },
  });
  const imageTotal = await pdb.usageEvent.aggregate({
    where: { kind: "image" },
    _sum: { credits: true },
    _count: { _all: true },
  });

  // LLM — internal monitoring only.
  const [llmToday, llmModels, llmRecentRows] = await Promise.all([
    pdb.usageEvent.count({ where: { kind: "llm", ts: { gte: startOfToday } } }),
    pdb.usageEvent.groupBy({
      by: ["model", "ok"],
      where: { kind: "llm", ts: { gte: startOfToday } },
      _count: { _all: true },
    }),
    pdb.usageEvent.findMany({
      where: { kind: "llm" },
      orderBy: { ts: "desc" },
      take: 10,
      select: { ts: true, model: true, ok: true, latencyMs: true, meta: true },
    }),
  ]);

  const byUser = imageByUser
    .map((row) => ({
      userHandle: row.userHandle ?? "(unknown)",
      credits: row._sum.credits ?? 0,
      count: row._count._all,
    }))
    .sort((a, b) => b.credits - a.credits);

  // Merge the model×ok groups into additive per-model rows (count = ok + failed,
  // same totals as the pre-R18-d model-only grouping) plus today's ok/failed split.
  const modelAgg = new Map<string, { model: string; count: number; ok: number; failed: number }>();
  let todayOk = 0;
  let todayFailed = 0;
  for (const row of llmModels) {
    const n = row._count._all;
    const entry = modelAgg.get(row.model) ?? { model: row.model, count: 0, ok: 0, failed: 0 };
    entry.count += n;
    if (row.ok) {
      entry.ok += n;
      todayOk += n;
    } else {
      entry.failed += n;
      todayFailed += n;
    }
    modelAgg.set(row.model, entry);
  }

  const todayModels = [...modelAgg.values()].sort((a, b) => b.count - a.count).slice(0, 20);

  // recent — last 10 llm rows overall, newest first. Meta JSON is parsed
  // defensively (never trusted): garbage/missing/oversized or non-string
  // fields become nulls; source strings pass through redactSecrets before
  // leaving the route (belt-and-braces — meta is writer-internal, P7).
  const recent = llmRecentRows.map((row) => {
    let meta: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(row.meta || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch {
      // garbage meta — the row is still listed, its provenance fields stay null
    }
    const source = metaScalar(meta.source, 128);
    return {
      ts: row.ts.toISOString(),
      model: row.model,
      ok: row.ok,
      latencyMs: row.latencyMs ?? null,
      source: source === null ? null : redactSecrets(source),
      role: metaScalar(meta.role, 64),
      egress: metaScalar(meta.egress, 16),
      error: metaScalar(meta.error, 64),
    };
  });

  return NextResponse.json({
    ok: true,
    image: {
      byUser,
      totalCredits: imageTotal._sum.credits ?? 0,
      totalCount: imageTotal._count._all,
    },
    llm: {
      todayCalls: llmToday,
      todayOk,
      todayFailed,
      todayModels,
      recent,
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

  const created = await getUsageDb()?.usageEvent.create({
    data: { kind, model, userHandle, credits, ok, latencyMs, meta: "{}" },
  });
  if (!created) return schemaNotLive();

  return NextResponse.json(
    { ok: true, id: created.id, kind, model, userHandle, credits, latencyMs: latencyMs ?? null },
    { status: 201 },
  );
}
