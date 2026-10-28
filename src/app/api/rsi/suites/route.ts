import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { db } from "@/lib/db";
import { ensureSuitesSeeded } from "@/lib/rsi/seed";
import { VERIFIER_LABELS } from "@/lib/rsi/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/rsi/suites — the frozen L3 suites (v1.0) with all tasks in frozen
 * order, each task carrying its verifier label from the eval-design.json
 * verifierTypes map (for UI badges) plus the frozen verifierConfig JSON.
 * Suites list newest-created-last (stable blueprint order); runs elsewhere
 * are newest-first per repo convention.
 */
export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`rsi-suites:${clientKey(req)}`, 60, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "slow down — 60 suite reads per minute" } },
      { status: 429 },
    );
  }

  await ensureSuitesSeeded();

  const suites = await db.rsiSuite.findMany({ orderBy: { createdAt: "asc" } });
  const result: Array<{
    id: string;
    key: string;
    name: string;
    category: string;
    description: string;
    grounding: string;
    version: string;
    configHash: string;
    configHashShort: string;
    frozenAt: Date;
    tasks: Array<{
      id: string;
      idx: number;
      name: string;
      prompt: string;
      verifier: string;
      verifierLabel: string;
      verifierConfig: string;
      difficulty: number;
      weight: number;
      tags: string;
    }>;
  }> = [];
  for (const s of suites) {
    const tasks = await db.rsiTask.findMany({ where: { suiteId: s.id }, orderBy: { idx: "asc" } });
    result.push({
      id: s.id,
      key: s.key,
      name: s.name,
      category: s.category,
      description: s.description,
      grounding: s.grounding,
      version: s.version,
      configHash: s.configHash,
      configHashShort: s.configHash.slice(0, 10),
      frozenAt: s.frozenAt,
      tasks: tasks.map((t) => ({
        id: t.id,
        idx: t.idx,
        name: t.name,
        prompt: t.prompt,
        verifier: t.verifier,
        verifierLabel: VERIFIER_LABELS[t.verifier] ?? t.verifier,
        verifierConfig: t.verifierConfig,
        difficulty: t.difficulty,
        weight: t.weight,
        tags: t.tags,
      })),
    });
  }
  return NextResponse.json({ ok: true, suites: result, verifierLabels: VERIFIER_LABELS });
}
