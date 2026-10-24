import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import {
  clearVyceBaseUrlOverride,
  deleteVyceConfig,
  isPlausibleVyceKey,
  isValidVyceBaseUrl,
  loadVyceBaseUrlOverride,
  loadVyceKey,
  maskVyceKey,
  normalizeVyceBaseUrl,
  probeVyce,
  resolveVyceBaseUrl,
  storeVyceBaseUrl,
  storeVyceKey,
} from "@/lib/connectors/vyce";

/**
 * T-207 — Vyce key management (vault-backed, session-guarded).
 *
 * PUT  { key, baseUrl? } → AES-256-GCM vault upsert (service "vyce",
 *       labels "api" + optional "base-url"), then a MEASURED live probe.
 *       A failing probe does NOT block storage — status surfaces the truth.
 *       An explicit empty-string baseUrl clears the override (back to default).
 * GET           → presence + masked preview only.
 * DELETE        → removes key + base-url override. Idempotent.
 *
 * P7: the key value is accepted once, encrypted immediately, never logged,
 * never echoed back — responses carry a masked preview (••••tail) only.
 */

function err(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function PUT(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`vyce-key:${clientKey(req)}`, 30, 60_000)) {
    return err("RATE_LIMITED", "Too many key updates — slow down.", 429);
  }

  const body = (await req.json().catch(() => null)) as { key?: unknown; baseUrl?: unknown } | null;
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  if (!isPlausibleVyceKey(key)) {
    return err("BAD_KEY", "key must be a string of 8–4096 characters (Vyce API key).", 400);
  }

  let baseUrlProvided = false;
  let clearBaseUrl = false;
  if (body?.baseUrl !== undefined && body.baseUrl !== null) {
    if (typeof body.baseUrl !== "string") {
      return err("BAD_BASE_URL", "baseUrl must be an https:// URL string when provided.", 400);
    }
    const trimmed = body.baseUrl.trim();
    if (trimmed.length === 0) {
      clearBaseUrl = true; // explicit reset to the default endpoint
    } else if (!isValidVyceBaseUrl(trimmed)) {
      return err("BAD_BASE_URL", "baseUrl must be a valid https:// URL without credentials.", 400);
    } else {
      baseUrlProvided = true;
    }
  }

  await storeVyceKey(key);
  if (baseUrlProvided && typeof body?.baseUrl === "string") {
    await storeVyceBaseUrl(normalizeVyceBaseUrl(body.baseUrl));
  }
  if (clearBaseUrl) await clearVyceBaseUrlOverride();

  // MEASURED probe with the just-stored credential (values never logged).
  let probe: { ok: boolean; httpStatus: number | null; code: string | null; modelCount: number | null };
  try {
    const effectiveBase = await resolveVyceBaseUrl();
    const r = await probeVyce(key, effectiveBase);
    probe = r.ok
      ? { ok: true, httpStatus: r.httpStatus, code: null, modelCount: r.models.length }
      : { ok: false, httpStatus: r.httpStatus, code: r.code, modelCount: null };
  } catch {
    probe = { ok: false, httpStatus: null, code: "NETWORK_ERROR", modelCount: null };
  }

  return NextResponse.json(
    { ok: true, stored: true, masked: maskVyceKey(key), probe },
    { status: 201 },
  );
}

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`vyce-key:${clientKey(req)}`, 30, 60_000)) {
    return err("RATE_LIMITED", "Too many requests — slow down.", 429);
  }

  const key = await loadVyceKey();
  const baseUrlOverride = await loadVyceBaseUrlOverride();
  return NextResponse.json({
    ok: true,
    keyPresent: key.ok,
    masked: key.ok ? key.masked : null,
    baseUrlOverridePresent: baseUrlOverride !== null,
  });
}

export async function DELETE(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`vyce-key:${clientKey(req)}`, 30, 60_000)) {
    return err("RATE_LIMITED", "Too many requests — slow down.", 429);
  }

  const removed = await deleteVyceConfig();
  // Idempotent: removing an absent config is still a success.
  return NextResponse.json({ ok: true, removed });
}
