import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { ResearchJob } from "@prisma/client";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import {
  exaAgentGet,
  exaAgentRunCost,
  exaAgentRunCitations,
  exaAgentRunError,
  exaAgentStop,
  loadExaKey,
  recordExaUsage,
} from "@/lib/connectors/exa";

/**
 * GET    /api/exa/research/[id] — job detail + lazy poll (v29.13).
 * DELETE /api/exa/research/[id] — stop a queued/running run.
 *
 * Poll discipline: while a job is queued/running, Exa is polled only when the
 * row's updatedAt is older than 15 seconds (every poll attempt touches the
 * row, so the guard actually spaces upstream calls). Terminal transitions are
 * recorded into the usage ledger; poll network failures are ignored — the
 * current row is returned unchanged (honest, never a crash).
 */

type Ctx = { params: Promise<{ id: string }> };

const POLL_MIN_AGE_MS = 15_000;

function clampStr(v: unknown, n: number): string {
  return typeof v === "string" ? v.trim().slice(0, n) : "";
}

function err(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function parseJsonArray(raw: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object");
    }
  } catch {
    // malformed payload — degrade to empty
  }
  return [];
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // malformed payload — degrade to null
  }
  return null;
}

function toJobDetail(j: ResearchJob) {
  return {
    id: j.id,
    query: j.query,
    effort: j.effort,
    status: j.status,
    exaRunId: j.exaRunId,
    stopReason: j.stopReason,
    costDollars: j.costDollars,
    tookMs: j.tookMs,
    error: j.error,
    answer: j.answer,
    answerPreview: j.answer.slice(0, 300),
    citations: parseJsonArray(j.citations),
    structured: parseJsonObject(j.structured),
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
    completedAt: j.completedAt ? j.completedAt.toISOString() : null,
  };
}

export async function GET(req: Request, ctx: Ctx) {
  const denied = await requireSession();
  if (denied) return denied;
  const { id } = await ctx.params;

  let job = await db.researchJob.findUnique({ where: { id } });
  if (!job) return err("NOT_FOUND", "Research job not found.", 404);

  if ((job.status === "queued" || job.status === "running") && Date.now() - job.updatedAt.getTime() > POLL_MIN_AGE_MS) {
    const loaded = await loadExaKey();
    if (loaded.ok && job.exaRunId) {
      const r = await exaAgentGet(loaded.key, job.exaRunId);
      if (r.ok) {
        const run = r.data;
        const tookMs = Date.now() - job.createdAt.getTime();
        const stopReason = clampStr(typeof run.stopReason === "string" ? run.stopReason : "", 80);

        if (run.status === "completed") {
          const output = (run.output ?? {}) as { text?: unknown; structured?: unknown };
          let structuredJson = "{}";
          try {
            structuredJson = JSON.stringify(output.structured ?? {}).slice(0, 8000) || "{}";
          } catch {
            structuredJson = "{}";
          }
          const cost = exaAgentRunCost(run);
          job = await db.researchJob.update({
            where: { id: job.id },
            data: {
              status: "completed",
              answer: clampStr(typeof output.text === "string" ? output.text : "", 12_000),
              citations: JSON.stringify(exaAgentRunCitations(run)),
              structured: structuredJson,
              costDollars: cost,
              tookMs,
              completedAt: new Date(),
              stopReason,
            },
          });
          recordExaUsage("exa-agent", cost ?? 0, tookMs, true, { effort: job.effort });
        } else if (run.status === "failed") {
          const cost = exaAgentRunCost(run);
          job = await db.researchJob.update({
            where: { id: job.id },
            data: {
              status: "failed",
              error: clampStr(exaAgentRunError(run) || "agent run failed", 500),
              completedAt: new Date(),
              stopReason,
              costDollars: cost,
              tookMs,
            },
          });
          recordExaUsage("exa-agent", cost ?? 0, tookMs, false, { effort: job.effort });
        } else if (run.status === "cancelled") {
          const cost = exaAgentRunCost(run);
          job = await db.researchJob.update({
            where: { id: job.id },
            data: {
              status: "stopped",
              completedAt: new Date(),
              stopReason: stopReason || "cancelled",
              costDollars: cost,
              tookMs,
            },
          });
          recordExaUsage("exa-agent", cost ?? 0, tookMs, true, { effort: job.effort, stopped: "upstream" });
        } else {
          // Still queued/running (or unknown status) — refresh the status and
          // touch updatedAt so the 15s poll guard stays real.
          const nextStatus = run.status === "running" ? "running" : job.status;
          job = await db.researchJob.update({ where: { id: job.id }, data: { status: nextStatus } });
        }
      } else {
        // Poll failure (network/timeout/http) — ignore; touch updatedAt so the
        // next poll waits out the guard window instead of hammering Exa.
        job = await db.researchJob.update({ where: { id: job.id }, data: { status: job.status } });
      }
    }
  }

  return NextResponse.json({ ok: true, job: toJobDetail(job) });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`exa-research-stop:${clientKey(req)}`, 20, 60_000)) {
    return err("RATE_LIMITED", "Too many stop requests — slow down.", 429);
  }
  const { id } = await ctx.params;

  const job = await db.researchJob.findUnique({ where: { id } });
  if (!job) return err("NOT_FOUND", "Research job not found.", 404);

  if (job.status !== "queued" && job.status !== "running") {
    return err("NOT_STOPPABLE", `Job is ${job.status} — only queued or running jobs can be stopped.`, 400);
  }

  // Best-effort upstream stop — failures are ignored (the row is marked
  // stopped regardless; Exa drops orphaned runs at their budget limits).
  const loaded = await loadExaKey();
  if (loaded.ok && job.exaRunId) {
    const r = await exaAgentStop(loaded.key, job.exaRunId);
    if (r.ok) {
      const cost = exaAgentRunCost(r.data);
      if (cost !== null) {
        recordExaUsage("exa-agent", cost, Date.now() - job.createdAt.getTime(), true, {
          effort: job.effort,
          stopped: "panel",
        });
      }
    }
  }

  const updated = await db.researchJob.update({
    where: { id: job.id },
    data: { status: "stopped", completedAt: new Date(), stopReason: "stopped" },
  });

  return NextResponse.json({ ok: true, job: toJobDetail(updated) });
}
