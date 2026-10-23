import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * NEXUS OS panel auth — single-operator, password-based bootstrap auth.
 * - PANEL_PASSWORD (from .env) is the only login credential; owner rotates it via
 *   scripts/rotate-panel-password.sh (see docs/runbook.md §0).
 * - Session = HMAC-signed token cookie (httpOnly, 7 days). No DB session needed.
 * - requireSession() is the in-route guard used by every protected API route
 *   (no middleware, per convention).
 */

export const SESSION_COOKIE = "nexus_session";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error("SESSION_SECRET missing or too short — run scripts/ensure-env.sh");
  }
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

export function issueSessionToken(): string {
  const payload = `${Date.now() + TTL_MS}.${randomBytes(12).toString("base64url")}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const i = token.lastIndexOf(".");
  if (i <= 0) return false;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const exp = Number(payload.split(".")[0]);
  return Number.isFinite(exp) && Date.now() < exp;
}

/** Timing-safe panel password check. Returns false when PANEL_PASSWORD is unset. */
export function checkPanelPassword(input: unknown): boolean {
  if (typeof input !== "string" || input.length === 0 || input.length > 256) return false;
  const expected = process.env.PANEL_PASSWORD;
  if (!expected) return false;
  const a = createHash("sha256").update(input).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function panelPasswordConfigured(): boolean {
  return Boolean(process.env.PANEL_PASSWORD);
}

/**
 * Guard for protected API routes.
 * Returns a 401 NextResponse when the caller has no valid session; null when OK.
 */
export async function requireSession(): Promise<NextResponse | null> {
  const store = await cookies();
  if (verifySessionToken(store.get(SESSION_COOKIE)?.value)) return null;
  return NextResponse.json(
    {
      ok: false,
      error: { code: "UNAUTHORIZED", message: "Panel sign-in required" },
    },
    { status: 401 },
  );
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
    secure: process.env.NODE_ENV === "production",
  };
}
