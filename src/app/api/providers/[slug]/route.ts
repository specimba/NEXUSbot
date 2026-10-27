import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import {
  clearAllCustomProviderCredentials,
  isValidCustomBaseUrl,
  isValidCustomName,
  isValidCustomSlug,
  isCustomStyle,
  loadProviders,
  normalizeCustomBaseUrl,
  saveProviders,
  sanitizeCustomModels,
  type CustomProviderConfig,
} from "@/lib/ai/custom-providers";

export const dynamic = "force-dynamic";

/**
 * Task 16-b — custom AI providers: update + remove (item route).
 *
 * POST   { name?, style?, baseUrl?, models? } → partial CONFIG update; provided
 *          fields are validated with the exact same rules as creation; absent
 *          fields keep their current values. Never touches stored keys.
 * DELETE → removes the CONFIG entry AND the vault key (service "provider:<slug>").
 *          Idempotent: removing an absent provider is still a success.
 *
 * Errors → §11: 401 UNAUTHORIZED, 429 RATE_LIMITED, 400 INVALID_SLUG /
 * INVALID_NAME / INVALID_STYLE / INVALID_BASE_URL / INVALID_BODY,
 * 404 NOT_FOUND, 500 KV_WRITE_FAILED (internal detail never leaked).
 */

function badRequest(code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status: 400 });
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const denied = await requireSession();
  if (denied) return denied;

  if (!rateLimit(`custom-provider-update:${clientKey(req)}`, 30, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many provider updates — slow down." } },
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
  const raw = (body ?? {}) as {
    name?: unknown;
    style?: unknown;
    baseUrl?: unknown;
    models?: unknown;
  };

  const provided = Object.keys(raw).filter(
    (k) => k === "name" || k === "style" || k === "baseUrl" || k === "models",
  );
  if (provided.length === 0) {
    return badRequest("INVALID_BODY", "nothing to update — provide name, style, baseUrl, or models.");
  }

  // Validate PROVIDED fields with the exact creation rules.
  if ("name" in raw && !isValidCustomName(raw.name)) {
    return badRequest("INVALID_NAME", "name must be 1–64 characters.");
  }
  if ("style" in raw && !isCustomStyle(raw.style)) {
    return badRequest("INVALID_STYLE", "style must be exactly one of: openai, anthropic.");
  }
  if ("baseUrl" in raw && !isValidCustomBaseUrl(raw.baseUrl)) {
    return badRequest(
      "INVALID_BASE_URL",
      "baseUrl must be a valid https:// URL (http:// is allowed only for localhost/127.0.0.1 local runners), 8–512 chars, no embedded credentials.",
    );
  }

  try {
    const current = await loadProviders();
    const existing = current.find((p) => p.slug === slug);
    if (!existing) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "No such provider config." } },
        { status: 404 },
      );
    }

    const updated: CustomProviderConfig = {
      slug: existing.slug,
      name: "name" in raw ? (raw.name as string).trim() : existing.name,
      style: "style" in raw ? (raw.style as CustomProviderConfig["style"]) : existing.style,
      baseUrl:
        "baseUrl" in raw ? normalizeCustomBaseUrl(raw.baseUrl as string) : existing.baseUrl,
      models: "models" in raw ? sanitizeCustomModels(raw.models) : existing.models,
    };

    const next = current.map((p) => (p.slug === slug ? updated : p));
    await saveProviders(next);
    return NextResponse.json({ ok: true, provider: updated });
  } catch {
    // Never leak internals (§11 + P7).
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "KV_WRITE_FAILED",
          message: "Could not persist the provider config — try again.",
        },
      },
      { status: 500 },
    );
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const denied = await requireSession();
  if (denied) return denied;

  if (!rateLimit(`custom-provider-delete:${clientKey(req)}`, 30, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many provider deletions — slow down." } },
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
    const current = await loadProviders();
    const next = current.filter((p) => p.slug !== slug);
    await saveProviders(next);
    // Remove the vault key too — a deleted provider leaves zero rows behind.
    const removedKeys = await clearAllCustomProviderCredentials(slug);
    return NextResponse.json({
      ok: true,
      removedConfig: next.length !== current.length,
      removedKeys,
    });
  } catch {
    // Never leak internals (§11 + P7).
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "KV_WRITE_FAILED",
          message: "Could not persist the provider removal — try again.",
        },
      },
      { status: 500 },
    );
  }
}
