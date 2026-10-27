import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { maskSecret } from "@/lib/crypto";
import {
  clearCustomProviderKey,
  isValidCustomSlug,
  loadProviders,
  normalizeCustomKeyInput,
  storeCustomProviderKey,
} from "@/lib/ai/custom-providers";

export const dynamic = "force-dynamic";

/**
 * Task 16-b — custom AI provider KEY management (vault-backed). Session-guarded.
 *
 * POST   { key } → AES-256-GCM vault upsert (service "provider:<slug>",
 *                  label "api-key"). Plausibility: trimmed length 8..4096;
 *                  one wrapping quote pair is stripped before encryption.
 *                  Requires the provider CONFIG to exist (NOT_FOUND otherwise) —
 *                  the UI creates config first, then the key.
 * DELETE → removes the stored key only. Idempotent. The config is NOT touched.
 *
 * P7: the key value is never echoed back, never logged, never stored outside
 * the vault. Only a masked preview (•••• + last 4) is returned.
 */

function badRequest(code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status: 400 });
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const denied = await requireSession();
  if (denied) return denied;

  if (!rateLimit(`custom-provider-key-write:${clientKey(req)}`, 20, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many key writes — slow down." } },
      { status: 429 },
    );
  }

  const { slug } = await params;
  if (!isValidCustomSlug(slug)) {
    return badRequest(
      "INVALID_SLUG",
      "slug must match /^[a-z0-9][a-z0-9-]{1,31}$/ (lowercase letters, digits, hyphens; 2–32 chars).",
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const raw = (body ?? {}) as { key?: unknown };
  const key = normalizeCustomKeyInput(raw.key);
  if (!key) {
    return badRequest("INVALID_KEY", "key must be 8–4096 characters (wrapping quotes are stripped).");
  }

  try {
    const config = (await loadProviders()).find((p) => p.slug === slug);
    if (!config) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "No such provider config — create it before adding a key." } },
        { status: 404 },
      );
    }

    await storeCustomProviderKey(slug, key);
    return NextResponse.json({ ok: true, masked: maskSecret(key) });
  } catch {
    // Never leak internals (§11 + P7).
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "KV_WRITE_FAILED",
          message: "Could not store the key in the vault — try again.",
        },
      },
      { status: 500 },
    );
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const denied = await requireSession();
  if (denied) return denied;

  if (!rateLimit(`custom-provider-key-delete:${clientKey(req)}`, 20, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many key deletions — slow down." } },
      { status: 429 },
    );
  }

  const { slug } = await params;
  if (!isValidCustomSlug(slug)) {
    return badRequest(
      "INVALID_SLUG",
      "slug must match /^[a-z0-9][a-z0-9-]{1,31}$/ (lowercase letters, digits, hyphens; 2–32 chars).",
    );
  }

  try {
    // Idempotent: removing an absent key is still a success.
    const removed = await clearCustomProviderKey(slug);
    return NextResponse.json({ ok: true, removed });
  } catch {
    // Never leak internals (§11 + P7).
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "KV_WRITE_FAILED",
          message: "Could not remove the key from the vault — try again.",
        },
      },
      { status: 500 },
    );
  }
}
