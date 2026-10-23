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

  // Issue the token ONCE: it goes into the cookie (same-site flow, unchanged)
  // AND into the response body. The caller just proved password knowledge, so
  // handing back their own session token is same-trust — and it is the only
  // cookie-free lifeline inside cookie-blocking iframes (preview panel).
  const token = issueSessionToken();
  const res = NextResponse.json({ ok: true, token });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
