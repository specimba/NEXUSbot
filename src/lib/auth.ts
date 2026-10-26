import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";

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

/** Setting key that holds the durable sha256(password) — survives sandbox .env resets. */
export const PANEL_PASSWORD_SETTING = "panel.passwordHash";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Timing-safe panel password check with TWO credential channels:
 *  1. Durable DB hash (Setting panel.passwordHash) — survives sandbox cold boots
 *     that regenerate .env with a fresh random password (the owner lockout bug).
 *  2. .env PANEL_PASSWORD — recovery channel; owner reads it via runbook §0.
 * Returns false when NEITHER channel is configured.
 */
export async function checkPanelPassword(input: unknown): Promise<boolean> {
  if (typeof input !== "string" || input.length === 0 || input.length > 256) return false;
  const digest = createHash("sha256").update(input).digest();

  const row = await db.setting
    .findUnique({ where: { key: PANEL_PASSWORD_SETTING } })
    .catch(() => null);
  if (row?.value) {
    const stored = Buffer.from(row.value, "hex");
    if (stored.length === digest.length && timingSafeEqual(stored, digest)) return true;
  }

  const expected = process.env.PANEL_PASSWORD;
  if (expected) {
    const envDigest = createHash("sha256").update(expected).digest();
    if (timingSafeEqual(envDigest, digest)) return true;
  }
  return false;
}

/**
 * Make the just-used password durable: when the owner logs in with the .env
 * recovery password and no DB hash exists yet, persist its hash so the next
 * sandbox reset cannot lock them out again. Idempotent; never overwrites an
 * existing DB credential (that would let a leaked .env value take over).
 */
export async function seedPanelPasswordFromEnv(): Promise<void> {
  const expected = process.env.PANEL_PASSWORD;
  if (!expected) return;
  const existing = await db.setting
    .findUnique({ where: { key: PANEL_PASSWORD_SETTING } })
    .catch(() => null);
  if (existing?.value) return;
  await db.setting
    .upsert({
      where: { key: PANEL_PASSWORD_SETTING },
      create: { key: PANEL_PASSWORD_SETTING, value: sha256Hex(expected) },
      update: {},
    })
    .catch(() => {});
}

/** Owner-initiated rotation: write the durable DB hash (used by Settings + scripts). */
export async function setPanelPassword(input: string): Promise<boolean> {
  if (typeof input !== "string" || input.length < 8 || input.length > 256) return false;
  await db.setting.upsert({
    where: { key: PANEL_PASSWORD_SETTING },
    create: { key: PANEL_PASSWORD_SETTING, value: sha256Hex(input) },
    update: { value: sha256Hex(input) },
  });
  return true;
}

export function panelPasswordConfigured(): boolean {
  return Boolean(process.env.PANEL_PASSWORD);
}

/**
 * Guard for protected API routes.
 * Accepts BOTH auth channels:
 *  1. nexus_session cookie (top-level browsing),
 *  2. Authorization: Bearer <token> (embedded preview / third-party-cookie-blocked
 *     contexts where browsers silently drop SameSite=Lax cookies).
 * Returns a 401 NextResponse when the caller has no valid session; null when OK.
 */
export async function requireSession(): Promise<NextResponse | null> {
  if (await isAuthenticated()) return null;
  return NextResponse.json(
    {
      ok: false,
      error: { code: "UNAUTHORIZED", message: "Panel sign-in required" },
    },
    { status: 401 },
  );
}

/** True when the current request carries a valid session via cookie OR Bearer. */
export async function isAuthenticated(): Promise<boolean> {
  const h = await headers();
  const auth = h.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    if (verifySessionToken(auth.slice(7).trim())) return true;
  }
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

/**
 * Cookie options tuned per transport. Over HTTPS (the public preview gateway sets
 * x-forwarded-proto) we upgrade to SameSite=None;Secure so the cookie also works
 * inside cross-site preview iframes. Plain HTTP keeps SameSite=Lax.
 */
export function sessionCookieOptions(https = false) {
  return https
    ? ({
        httpOnly: true,
        sameSite: "none" as const,
        path: "/",
        maxAge: 7 * 24 * 60 * 60,
        secure: true,
      } as const)
    : ({
        httpOnly: true,
        sameSite: "lax" as const,
        path: "/",
        maxAge: 7 * 24 * 60 * 60,
        secure: false,
      } as const);
}
