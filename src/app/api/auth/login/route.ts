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

  const token = issueSessionToken();

  const res = NextResponse.json({ ok: true, token });
  // HTTPS (behind the preview gateway) → SameSite=None;Secure so embedded iframes
  // keep the cookie; otherwise Lax. Either way the token is also returned in the
  // body as a Bearer fallback for contexts where cookies are blocked entirely.
  const proto = (req.headers.get("x-forwarded-proto") ?? "http").split(",")[0].trim();
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(proto === "https"));
  return res;
}
