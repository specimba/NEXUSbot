import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { routeFor, readRoutingMap } from "@/lib/egress";
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
  sharpenVyceProbeWithOriginHealth,
  storeVyceBaseUrl,
  storeVyceKey,
  VYCE_PROBE_TIMEOUT_PROXY_MS,
  VYCE_TIMEOUT_MS,
  type VyceOriginVerdict,
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
 * R18-a: the paste-key probe tests the key through the SAME egress chats use
 * (routeFor("vyce", readRoutingMap()) — the live map has vyce=proxy; 12s per
 * proxied pool attempt / 8s direct) and benefits from the ORIGIN_DOWN
 * classification: an owner pasting a key during a Vyce-side outage gets
 * "origin down, cannot verify" (sharpened by the no-key origin-health probe)
 * instead of a misleading transport error. Transport failures are NEVER
 * reported as a key rejection.
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
  // R18-a: routed exactly like a chat (egress routing map), with the honest
  // ORIGIN_DOWN classification + origin sharpening so an outage reads as an
  // outage — never as "key rejected" and never as a bare transport error.
  let probe: {
    ok: boolean;
    httpStatus: number | null;
    code: string | null;
    modelCount: number | null;
    message: string | null;
    origin: VyceOriginVerdict | null;
  };
  try {
    const effectiveBase = await resolveVyceBaseUrl();
    const mode = routeFor("vyce", await readRoutingMap());
    let r = await probeVyce(key, effectiveBase, {
      timeoutMs: mode === "proxy" ? VYCE_PROBE_TIMEOUT_PROXY_MS : VYCE_TIMEOUT_MS,
      route: mode,
    });
    let origin: VyceOriginVerdict | null = null;
    if (!r.ok) {
      const sharpened = await sharpenVyceProbeWithOriginHealth(r, effectiveBase, mode);
      r = sharpened.probe;
      origin = sharpened.origin;
    }
    probe = r.ok
      ? { ok: true, httpStatus: r.httpStatus, code: null, modelCount: r.models.length, message: null, origin: null }
      : { ok: false, httpStatus: r.httpStatus, code: r.code, modelCount: null, message: r.message, origin };
  } catch {
    probe = {
      ok: false,
      httpStatus: null,
      code: "NETWORK_ERROR",
      modelCount: null,
      message: "probe could not be completed (unexpected failure before an HTTP answer)",
      origin: null,
    };
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
