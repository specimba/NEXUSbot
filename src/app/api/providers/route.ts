import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { decryptSecret, maskSecret } from "@/lib/crypto";
import {
  CUSTOM_PROVIDER_KEY_LABEL,
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
 * Task 16-b — custom AI providers: list + create/replace (collection route).
 *
 * GET   → { ok:true, providers:[{slug,name,style,baseUrl,models,hasKey,maskedKey,updatedAt}] }
 * POST  { slug, name, style, baseUrl, models? } → create/replace CONFIG only —
 *         never touches stored keys (a re-created provider keeps its vault key).
 *
 * Errors → §11 { ok:false, error:{ code, message } }: 401 UNAUTHORIZED,
 * 429 RATE_LIMITED, 400 INVALID_SLUG / INVALID_NAME / INVALID_STYLE /
 * INVALID_BASE_URL, 500 KV_WRITE_FAILED (internal detail never leaked).
 *
 * P7: key plaintext never leaves the vault here — only a masked preview
 * (decrypt transiently in-process → maskSecret). Host/baseUrl is config and
 * safe to display.
 */

function badRequest(code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status: 400 });
}

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  // 30/min ≈ the card's 30 s refetch cadence with headroom.
  if (!rateLimit(`custom-providers-read:${clientKey(req)}`, 30, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many provider reads — slow down." } },
      { status: 429 },
    );
  }

  const configs = await loadProviders();

  // Vault key state per provider (masked previews only — P7).
  const keyRows = await db.credential.findMany({
    where: { label: CUSTOM_PROVIDER_KEY_LABEL, service: { startsWith: "provider:" } },
    select: { service: true, cipher: true, updatedAt: true },
  });
  const keyState = new Map<string, { maskedKey: string | null; updatedAt: string | null }>();
  for (const row of keyRows) {
    const slug = row.service.slice("provider:".length);
    let maskedKey: string | null = null;
    try {
      maskedKey = maskSecret(decryptSecret(row.cipher));
    } catch {
      maskedKey = null; // unreadable vault entry — shown as no-key, honestly
    }
    keyState.set(slug, { maskedKey, updatedAt: row.updatedAt.toISOString() });
  }

  const providers = configs.map((cfg: CustomProviderConfig) => {
    const ks = keyState.get(cfg.slug);
    const hasKey = ks !== undefined && ks.maskedKey !== null;
    return {
      slug: cfg.slug,
      name: cfg.name,
      style: cfg.style,
      baseUrl: cfg.baseUrl,
      models: cfg.models,
      hasKey,
      maskedKey: hasKey ? ks!.maskedKey : null,
      updatedAt: hasKey ? ks!.updatedAt : null,
    };
  });

  return NextResponse.json({ ok: true, providers });
}

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  if (!rateLimit(`custom-providers-write:${clientKey(req)}`, 20, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many provider writes — slow down." } },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const raw = (body ?? {}) as {
    slug?: unknown;
    name?: unknown;
    style?: unknown;
    baseUrl?: unknown;
    models?: unknown;
  };

  if (!isValidCustomSlug(raw.slug)) {
    return badRequest(
      "INVALID_SLUG",
      "slug must match /^[a-z0-9][a-z0-9-]{1,31}$/ (lowercase letters, digits, hyphens; 2–32 chars).",
    );
  }
  if (!isValidCustomName(raw.name)) {
    return badRequest("INVALID_NAME", "name must be 1–64 characters.");
  }
  if (!isCustomStyle(raw.style)) {
    return badRequest("INVALID_STYLE", "style must be exactly one of: openai, anthropic.");
  }
  if (!isValidCustomBaseUrl(raw.baseUrl)) {
    return badRequest(
      "INVALID_BASE_URL",
      "baseUrl must be a valid https:// URL (http:// is allowed only for localhost/127.0.0.1 local runners), 8–512 chars, no embedded credentials.",
    );
  }

  const config: CustomProviderConfig = {
    slug: raw.slug,
    // isValidCustomName is a `value is string` guard but was applied negated
    // (early-return), which does not narrow the property — bind locally.
    name: (raw.name as string).trim(),
    style: raw.style,
    baseUrl: normalizeCustomBaseUrl(raw.baseUrl),
    models: sanitizeCustomModels(raw.models),
  };

  try {
    const current = await loadProviders();
    const next = [...current.filter((p) => p.slug !== config.slug), config];
    await saveProviders(next);
    return NextResponse.json({ ok: true, provider: config });
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
