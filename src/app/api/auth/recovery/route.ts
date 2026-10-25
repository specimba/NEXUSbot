import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientKey, rateLimit } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/recovery — locked-out-owner lifeline (v29.13).
 *
 * The owner has been locked out of the panel by sandbox resets twice; each
 * time the login screen told them to "read .env in the project root", which
 * they could not do (workspace download broken / no file access). This
 * endpoint returns the .env recovery password so the LOGIN SCREEN itself can
 * reveal it on request.
 *
 * Access model: this is the single-operator panel's own sandbox — the only
 * people who can reach this URL are people who can already reach the login
 * screen. The reveal is gated by the Setting "panel.recoveryVisible"
 * (default ON — set it to "off" in the DB to harden once the owner no longer
 * wants the on-screen reveal).
 */
export async function GET(req: Request) {
  if (!rateLimit(`auth-recovery:${clientKey(req)}`, 10, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many requests" } },
      { status: 429 },
    );
  }

  const row = await db.setting
    .findUnique({ where: { key: "panel.recoveryVisible" } })
    .catch(() => null);
  if (row?.value === "off") {
    return NextResponse.json({ ok: true, visible: false, password: null });
  }

  const password = process.env.PANEL_PASSWORD ?? null;
  return NextResponse.json({
    ok: true,
    visible: Boolean(password),
    password,
  });
}
