import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { db } from "@/lib/db";
import { rsiBudgetState } from "@/lib/rsi/budget";
import { BUDGET_DAILY_SETTING } from "@/lib/rsi/constants";

export const dynamic = "force-dynamic";

/** Owner-editable daily LLM-call cap range (Setting rsi.callBudgetDaily). */
const CAP_MIN = 1;
const CAP_MAX = 4096;

/**
 * GET /api/rsi/budget — the live budget state {used, cap, remaining, ok, day}.
 * Session-gated like every RSI route. Dedicated cheap read; the overview
 * poll carries the same object inside its payload, so the tab does not need
 * this endpoint to render, but direct API consumers get a minimal contract.
 */
export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`rsi-budget-get:${clientKey(req)}`, 30, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "slow down — 30 budget reads per minute" } },
      { status: 429 },
    );
  }

  return NextResponse.json({ ok: true, budget: await rsiBudgetState() });
}

/**
 * PUT /api/rsi/budget — raise or lower the owner-editable daily cap so longer,
 * harder evaluation batteries get honest headroom. Body {cap: number}, integer
 * 1-4096. Upserts Setting `rsi.callBudgetDaily` — rsiDailyCap() reads that row
 * fresh on every gate check, so the new cap is live immediately for the G7
 * gate and every runner/synthesize/canary pre-flight. Lowering the cap below
 * today's usage is allowed and honest: the engine then fails runs loudly with
 * budget_exceeded (never a silent truncation). No number is fabricated.
 */
export async function PUT(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`rsi-budget-put:${clientKey(req)}`, 10, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "slow down — 10 cap writes per minute" } },
      { status: 429 },
    );
  }

  const body = (await req.json().catch(() => null)) as { cap?: unknown } | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_BODY", message: "JSON body {cap: number} required" } },
      { status: 400 },
    );
  }

  const cap = body.cap;
  if (typeof cap !== "number" || !Number.isInteger(cap) || cap < CAP_MIN || cap > CAP_MAX) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "BAD_CAP", message: `cap must be an integer between ${CAP_MIN} and ${CAP_MAX}` },
      },
      { status: 400 },
    );
  }

  try {
    await db.setting.upsert({
      where: { key: BUDGET_DAILY_SETTING },
      create: { key: BUDGET_DAILY_SETTING, value: String(cap) },
      update: { value: String(cap) },
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "DB_ERROR",
          message: `cap write failed: ${err instanceof Error ? err.message : "unknown database error"}`,
        },
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, budget: await rsiBudgetState() });
}
