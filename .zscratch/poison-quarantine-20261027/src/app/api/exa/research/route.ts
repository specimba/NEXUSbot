import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { exaAgentCreate, loadExaKey } from "@/lib/connectors/exa";

/**
 * POST /api/exa/research — launch an Exa Agent deep-research run (v29.13).
 * Session-guarded. Body { query, effort?, maxCostDollars? }.
 *
 * Effort tiers carry hard cost caps (dollars): low 0.5 / medium 1 / high 3 /
 * xhigh 5 / ultra 10 — a requested maxCostDollars is clamped into [0.1, cap].
 * Duration cap: 900s (1800s for ultra). Runs are async (minutes–hours); the
 * panel polls GET /api/exa/research/[id].
 *
 * GET /api/exa/research — the 20 most recent jobs (list view).
 */

const VYCE_RESEARCH_SYSTEM_PROMPT =
  "You are VYCE, the research brain of a Turkish AI-news livestream. Research thoroughly, " +
  "prefer primary sources, and write findings in clear, neutral English unless the query is " +
  "in Turkish (then answer in Turkish). Always ground claims in sources.";

const EFFORT_CAPS: Record<string, number> = {
  low: 0.5,
  medium: 1,
  high: 3,
  xhigh: 5,
  ultra: 10,
};

function clampStr(v: unknown, n: number): string {
  return typeof v === "string" ? v.trim().slice(0, n) : "";
}

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  // Deep research costs real dollars — 5 launches per 10 minutes is plenty.
  if (!rateLimit(`exa-research:${clientKey(req)}`, 5, 600_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many research launches — slow down (5 per 10 minutes)." } },
      { status: 429 },
    );
  }

  const body = (await req.json().catch(() => null)) as {
    query?: unknown;
    effort?: unknown;
    maxCostDollars?: unknown;
  } | null;

  const query = clampStr(body?.query, 2000);
  if (query.length < 4) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_QUERY", message: "query must be 4–2000 characters" } },
      { status: 400 },
    );
  }

  const effortRaw = typeof body?.effort === "string" ? body.effort.trim() : "";
  const effort = effortRaw in EFFORT_CAPS ? effortRaw : "medium";
  const cap = EFFORT_CAPS[effort];
  let maxCostDollars = cap;
  if (typeof body?.maxCostDollars === "number" && Number.isFinite(body.maxCostDollars)) {
    maxCostDollars = Math.min(cap, Math.max(0.1, body.maxCostDollars));
  }
  const maxDurationSeconds = effort === "ultra" ? 1800 : 900;

  const loaded = await loadExaKey();
  if (!loaded.ok) {
    return NextResponse.json(
      { ok: false, error: { code: "EXA_NOT_CONFIGURED", message: "Store the Exa API key in Connectors → Exa first." } },
      { status: 400 },
    );
  }

  const run = await exaAgentCreate(loaded.key, {
    query,
    effort: effort as "low" | "medium" | "high" | "xhigh" | "ultra",
    budget: { maxCostDollars, maxDurationSeconds },
    systemPrompt: VYCE_RESEARCH_SYSTEM_PROMPT,
  });
  if (!run.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "AGENT_CREATE_FAILED",
          message: `Exa agent run could not be created: ${clampStr(run.error, 160) || "unknown upstream error"}`,
        },
      },
      { status: 502 },
    );
  }
  const exaRunId = typeof run.data?.id === "string" ? run.data.id : "";
  if (!exaRunId) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "AGENT_CREATE_FAILED", message: "Exa agent create succeeded but carried no run id" },
      },
      { status: 502 },
    );
  }

  const job = await db.researchJob.create({
    data: {
      query,
      effort,
      status: run.data.status === "running" ? "running" : "queued",
      exaRunId,
    },
  });

  return NextResponse.json({
    ok: true,
    job: {
      id: job.id,
      query: job.query,
      effort: job.effort,
      status: job.status,
      exaRunId: job.exaRunId,
      createdAt: job.createdAt.toISOString(),
      stopReason: job.stopReason,
      costDollars: job.costDollars,
      tookMs: job.tookMs,
      error: job.error,
      answerPreview: job.answer.slice(0, 300),
    },
  });
}

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const rows = await db.researchJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return NextResponse.json({
    ok: true,
    jobs: rows.map((j) => ({
      id: j.id,
      query: j.query,
      effort: j.effort,
      status: j.status,
      stopReason: j.stopReason,
      costDollars: j.costDollars,
      tookMs: j.tookMs,
      error: j.error,
      createdAt: j.createdAt.toISOString(),
      updatedAt: j.updatedAt.toISOString(),
      completedAt: j.completedAt ? j.completedAt.toISOString() : null,
      answerPreview: j.answer.slice(0, 300),
    })),
  });
}
