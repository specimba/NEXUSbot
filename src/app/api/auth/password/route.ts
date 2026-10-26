import { NextResponse } from "next/server";
import {
  checkPanelPassword,
  requireSession,
  setPanelPassword,
} from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";

/**
 * POST /api/auth/password — owner-initiated panel password rotation (v29.12).
 *
 * The durable credential is the DB hash (Setting panel.passwordHash); the .env
 * PANEL_PASSWORD remains a recovery channel by design (anti-lockout — the
 * sandbox regenerates .env on cold boots). Rotation writes the DB hash only,
 * so the recovery value keeps working unless the owner also rotates .env.
 *
 * Body: { currentPassword, newPassword } — current must verify; new must be
 * 8..256 chars. Session required (owner-only panel).
 */
export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`panel-password:${clientKey(req)}`, 5, 60_000)) {
    return NextResponse.json({ ok: false, error: "rate limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as {
    currentPassword?: unknown;
    newPassword?: unknown;
  } | null;

  if (!(await checkPanelPassword(body?.currentPassword))) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_CURRENT", message: "Current password is wrong" } },
      { status: 401 },
    );
  }
  const next = typeof body?.newPassword === "string" ? body.newPassword : "";
  const ok = await setPanelPassword(next);
  if (!ok) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "BAD_NEW",
          message: "New password must be 8–256 characters",
        },
      },
      { status: 400 },
    );
  }
  return NextResponse.json({
    ok: true,
    note: "Durable password updated. The .env PANEL_PASSWORD still works as the documented recovery channel.",
  });
}
