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
  looksLikeVyceFingerprint,
  maskVyceKey,
  normalizeVyceBaseUrl,
  probeVyceRouted,
  resolveVyceBaseUrl,
  storeVyceBaseUrl,
  storeVyceKey,
} from "@/lib/connectors/vyce";
import { invalidateVyceStatusCache } from "@/lib/vyce-status-cache";

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
  // Server-side parity with the card guard: a 64-hex SHA-256 fingerprint is
  // not a key — storing it again would recreate the owner's exact 401 loop.
  if (looksLikeVyceFingerprint(key)) {
    return err(
      "BAD_KEY_FINGERPRINT",
      "That value is a 64-hex SHA-256 fingerprint, not a raw API key — Vyce can never accept it (HTTP 401 invalid_api_key). Paste the raw key exactly as Vyce issued it (e.g. sk-…).",
      400,
    );
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
  // v31.4 — the status card must probe with THIS key on its next poll, not
  // serve the 90s cached verdict of the old one.
  invalidateVyceStatusCache();

  // MEASURED probe with the just-stored credential, through the SAME egress
  // route the runtime uses (a key stored while routing sends Vyce through the
  // pool must be validated through the pool — a direct probe would report a
  // transport verdict about a proxied runtime).
  let probe: { ok: boolean; httpStatus: number | null; code: string | null; modelCount: number | null; route: "direct" | "proxy" | null };
  try {
    const effectiveBase = await resolveVyceBaseUrl();
    const r = await probeVyceRouted(key, effectiveBase);
    probe = r.ok
      ? { ok: true, httpStatus: r.httpStatus, code: null, modelCount: r.models.length, route: r.route }
      : { ok: false, httpStatus: r.httpStatus, code: r.code, modelCount: null, route: r.route };
  } catch {
    probe = { ok: false, httpStatus: null, code: "NETWORK_ERROR", modelCount: null, route: null };
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
    // True when the stored value is hash-shaped (poisoned) — callers surface it.
    fingerprint: key.ok ? key.fingerprint : false,
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
  // v31.4 — same rule on delete: the next status poll re-probes honestly.
  invalidateVyceStatusCache();
  // Idempotent: removing an absent config is still a success.
  return NextResponse.json({ ok: true, removed });
}
