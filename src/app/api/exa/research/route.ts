import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { launchPanelResearch, listResearchJobs, type ResearchJobRow } from "@/lib/brain/deep-research";
import type { ExaAgentEffort } from "@/lib/connectors/exa";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Task 15-a backend (v33) — the Exa Deep Research card's engine. The card UI
 * shipped in 15-b and degraded honestly against a missing backend for days
 * (the "random wasting" complaint: a deep-research button with no engine).
 * Now backed by the MEASURED Exa Agent API (/agent/runs) with the HyperAgent
 * browser lane as fallback; jobs live in the Setting-based ledger so the
 * panel polls them while the agent works.
 *
 *   GET  /api/exa/research          → {ok, jobs: ResearchJob[]} (newest first)
 *   POST /api/exa/research          → {ok, job} | error envelope
 *        {query, effort: low|medium|high|xhigh|ultra}
 *        5 runs / 10 min per session (the card's honest rate-limit toast).
 */

const EFFORTS: ExaAgentEffort[] = ["low", "medium", "high", "xhigh", "ultra"];

/** Map a ledger row to the frontend's ResearchJob contract (exa-api.ts). */
function toJobRow(j: ResearchJobRow) {
  return {
    id: j.id,
    query: j.query,
    effort: j.effort,
    provider: j.provider,
    status: j.status,
    stopReason: j.stopReason,
    costDollars: j.costDollars,
    tookMs: j.tookMs,
    error: j.error,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    completedAt: j.completedAt,
    answerPreview: j.answer ? j.answer.slice(0, 160) : undefined,
  };
}

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  const jobs = await listResearchJobs();
  return NextResponse.json({ ok: true, jobs: jobs.map(toJobRow) });
}

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`exa-research:${clientKey(req)}`, 5, 10 * 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "5 runs per 10 minutes — wait a moment." } },
      { status: 429 },
    );
  }
  const body = (await req.json().catch(() => null)) as { query?: unknown; effort?: unknown } | null;
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  const effort = EFFORTS.includes(body?.effort as ExaAgentEffort) ? (body!.effort as ExaAgentEffort) : "medium";
  if (query.length < 3) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_QUERY", message: "query must be at least 3 chars" } },
      { status: 400 },
    );
  }
  const launched = await launchPanelResearch({ query, effort });
  if (!launched.ok) {
    const status = launched.code === "EXA_NOT_CONFIGURED" ? 400 : launched.code === "EXA_BUDGET_EXHAUSTED" ? 429 : 400;
    return NextResponse.json(
      { ok: false, error: { code: launched.code, message: launched.message } },
      { status },
    );
  }
  return NextResponse.json({ ok: true, job: toJobRow(launched.job) });
}
