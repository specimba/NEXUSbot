import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";

/**
 * Budget settings (T-208). Whitelisted keys only; values are non-negative
 * numeric strings. These gate agent/eval spend in L3–L4 phases.
 */
const BUDGET_KEYS = ["budget.daily.llmCalls", "budget.daily.evalRuns", "budget.daily.eventIngest"] as const;
const DEFAULTS: Record<string, string> = {
  "budget.daily.llmCalls": "500",
  "budget.daily.evalRuns": "20",
  "budget.daily.eventIngest": "5000",
};

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  const rows = await db.setting.findMany({ where: { key: { in: [...BUDGET_KEYS] } } });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));

  const budgets = BUDGET_KEYS.map((key) => ({
    key,
    value: Number(byKey.get(key) ?? DEFAULTS[key]),
  }));

  return NextResponse.json({ ok: true, budgets });
}

export async function PUT(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as
    | { budgets?: unknown }
    | null;

  if (!body || !Array.isArray(body.budgets)) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_BODY", message: "`budgets` array required" } },
      { status: 400 },
    );
  }

  for (const entry of body.budgets as Array<{ key?: unknown; value?: unknown }>) {
    const key = String(entry?.key ?? "");
    if (!(BUDGET_KEYS as readonly string[]).includes(key)) {
      return NextResponse.json(
        { ok: false, error: { code: "BAD_KEY", message: `unknown budget key "${key}"` } },
        { status: 400 },
      );
    }
    const n = Number(entry?.value);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
      return NextResponse.json(
        { ok: false, error: { code: "BAD_VALUE", message: `budget "${key}" must be 0–1000000` } },
        { status: 400 },
      );
    }
    await db.setting.upsert({
      where: { key },
      create: { key, value: String(Math.round(n)) },
      update: { value: String(Math.round(n)) },
    });
  }

  return NextResponse.json({ ok: true });
}
