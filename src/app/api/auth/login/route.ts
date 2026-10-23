import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  checkPanelPassword,
  issueSessionToken,
  sessionCookieOptions,
} from "@/lib/auth";
import { clientKey, pruneRateLimits, rateLimit } from "@/lib/guard";

export async function POST(req: Request) {
  pruneRateLimits();
  if (!rateLimit(`login:${clientKey(req)}`, 10, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many attempts, wait a minute" } },
      { status: 429 },
    );
  }

  const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
  if (!checkPanelPassword(body?.password)) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_PASSWORD", message: "Wrong panel password" } },
      { status: 401 },
    );
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, issueSessionToken(), sessionCookieOptions());
  return res;
}
