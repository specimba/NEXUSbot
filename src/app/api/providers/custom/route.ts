import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import {
  CUSTOM_PROTOCOLS,
  isCustomProtocol,
  isPlausibleProviderKey,
  isValidCustomBaseUrl,
  listCustomProviders,
  normalizeCustomBaseUrl,
  probeCustomProvider,
  storeProviderKey,
} from "@/lib/connectors/custom-provider";

/**
 * Custom brain providers (owner-defined, beyond Vyce/Groq).
 *
 * GET   → list with masked key previews only (P7 — cipher never leaves).
 * POST  → create { name, protocol, baseUrl, model?, apiKey? } with an optional
 *         immediate live probe. A failing probe does NOT block creation — the
 *         row stores the honest verdict and the card surfaces it.
 */

function err(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`custom-providers:${clientKey(req)}`, 60, 60_000)) {
    return err("RATE_LIMITED", "Too many requests — slow down.", 429);
  }
  const providers = await listCustomProviders();
  return NextResponse.json({ ok: true, providers });
}

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`custom-providers:${clientKey(req)}`, 20, 60_000)) {
    return err("RATE_LIMITED", "Too many provider updates — slow down.", 429);
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (name.length < 1 || name.length > 80) {
    return err("BAD_NAME", "name must be 1–80 characters.", 400);
  }
  if (!isCustomProtocol(body?.protocol)) {
    return err("BAD_PROTOCOL", `protocol must be one of: ${CUSTOM_PROTOCOLS.join(", ")}.`, 400);
  }
  const protocol = body?.protocol as string;
  if (!isValidCustomBaseUrl(body?.baseUrl)) {
    return err("BAD_BASE_URL", "baseUrl must be a valid https:// URL without credentials.", 400);
  }
  const baseUrl = normalizeCustomBaseUrl(body?.baseUrl as string);
  const model = typeof body?.model === "string" ? body.model.trim().slice(0, 128) : "";
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  if (apiKey.length > 0 && !isPlausibleProviderKey(apiKey)) {
    return err("BAD_KEY", "apiKey must be 8–4096 characters when provided.", 400);
  }

  const created = await db.customProvider.create({
    data: {
      name,
      protocol,
      baseUrl,
      model,
    },
  });

  if (apiKey.length > 0) {
    await storeProviderKey(created.id, apiKey);
  }

  // MEASURED verdict right away (never blocks the row's existence).
  const probe = await probeCustomProvider(created.id).catch(() => ({
    ok: false,
    code: "PROBE_ERROR",
    detail: "Probe failed unexpectedly.",
  }));

  return NextResponse.json({ ok: true, id: created.id, probe }, { status: 201 });
}
