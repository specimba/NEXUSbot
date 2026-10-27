import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { isValidCustomSlug, loadProviders, probeCustomProvider } from "@/lib/ai/custom-providers";

export const dynamic = "force-dynamic";

/**
 * Task 16-b — custom AI provider probe. Session-guarded, 10/min limit.
 *
 * POST → runs probeCustomProvider(slug) and returns 200 { ok:true, probe }.
 *
 * HONESTY CONTRACT: an upstream probe failure is DATA, not a route error —
 * the route answers 200 with the typed failure
 * ({ ok:false, code:"NETWORK_ERROR"|"UNAUTHORIZED"|"FORBIDDEN"|"RATE_LIMITED"|"BAD_RESPONSE", ... })
 * inside. Route-level errors are only §11 transport of the panel's own state:
 * 401 UNAUTHORIZED, 429 RATE_LIMITED, 400 INVALID_SLUG, 404 NOT_FOUND
 * (config missing), 500 PROBE_FAILED (defensive — probeCustomProvider itself
 * never throws in normal operation).
 *
 * R19-a circuit: the probe honors the per-provider circuit breaker
 * ("custom:<slug>") — while it is open, the route returns the typed failure
 * with circuit:"open" in `probe` WITHOUT a network call (default,
 * cached-by-circuit). The request body accepts an OPTIONAL boolean `force`:
 * {"force":true} bypasses the breaker for a deliberate live measurement
 * (manual button press); {"force":false} or no body keeps the default.
 *
 * P7: probe messages are static strings + HTTP status + host; upstream bodies
 * are truncated and scrubbed against the live key inside the lib.
 */

function badRequest(code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status: 400 });
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const denied = await requireSession();
  if (denied) return denied;

  // 10/min — the brief's explicit probe budget (upstream kindness).
  if (!rateLimit(`custom-provider-probe:${clientKey(req)}`, 10, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Probe limit reached (10/min) — wait a moment." } },
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

  // R19-a: OPTIONAL boolean force (absent body / absent field → false, the
  // cached-by-circuit default; non-boolean value → honest §11 INVALID_BODY).
  let force = false;
  const body = (await req.json().catch(() => null)) as { force?: unknown } | null;
  if (body !== null && body.force !== undefined) {
    if (typeof body.force !== "boolean") {
      return badRequest("INVALID_BODY", "force must be a boolean when provided.");
    }
    force = body.force;
  }

  try {
    const config = (await loadProviders()).find((p) => p.slug === slug);
    if (!config) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "No such provider config." } },
        { status: 404 },
      );
    }

    // Upstream failures are DATA — 200 with the typed result inside.
    const probe = await probeCustomProvider(slug, { force });
    return NextResponse.json({ ok: true, probe });
  } catch {
    // Defensive: the lib is typed non-throwing; keep the route §11-clean anyway.
    return NextResponse.json(
      { ok: false, error: { code: "PROBE_FAILED", message: "Probe could not be executed — try again." } },
      { status: 500 },
    );
  }
}
