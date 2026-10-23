import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import {
  EGRESS_PROBE_TARGETS,
  EGRESS_ROUTING_KEY,
  readRoutingMap,
  type EgressMode,
} from "@/lib/egress";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Task 13-a — per-upstream egress routing registry (GET/POST).
 *
 * Purpose: the owner-facing control for the `egress.routing` Settings KV that
 * src/lib/egress.ts consumes via readRoutingMap()/routeFor(). Per-upstream
 * decisions DEFAULT to "direct" (the sandbox egress IP); "proxy" sends an
 * upstream through the owner's paid Webshare pool. Only the whitelisted probe
 * targets (Object.keys(EGRESS_PROBE_TARGETS) = groq, vyce, generic-echo) plus
 * the literal "default" fallback key are settable — everything else is refused.
 *
 * Contracts:
 *   GET  → { ok:true, routing: Record<string,"direct"|"proxy">, targets: string[] }
 *   POST { upstream, mode } → { ok:true, routing: <updated full map> }
 *   Errors → §11 { ok:false, error:{ code, message } } with honest HTTP status:
 *   401 UNAUTHORIZED, 429 RATE_LIMITED, 400 INVALID_UPSTREAM / INVALID_MODE,
 *   500 EGRESS_ROUTING_WRITE_FAILED (internal detail never leaked).
 *
 * P7: this endpoint deals ONLY in mode strings ("direct"|"proxy") and target
 * names — no secret values are accepted, stored, or returned. Proxy URLs,
 * tokens and passwords never appear anywhere in this surface. Writing a mode
 * is independent of the Webshare connector state (the routing map is a plain
 * KV; a proxied decision against an unconfigured pool honestly fails at
 * probe/use time, not here).
 */

/** Whitelist: probe targets + the "default" fallback key. */
const SETTABLE_UPSTREAMS: ReadonlySet<string> = new Set([
  ...Object.keys(EGRESS_PROBE_TARGETS),
  "default",
]);

const ROUTING_MODES: readonly EgressMode[] = ["direct", "proxy"];

function isEgressMode(v: unknown): v is EgressMode {
  return v === "direct" || v === "proxy";
}

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  // 30/min ≈ the card's 30 s refetch cadence with generous headroom.
  if (!rateLimit(`egress-routing-read:${clientKey(req)}`, 30, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many routing reads — slow down." } },
      { status: 429 },
    );
  }

  const routing = await readRoutingMap();
  return NextResponse.json({
    ok: true,
    routing,
    targets: Object.keys(EGRESS_PROBE_TARGETS),
  });
}

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  if (!rateLimit(`egress-routing-write:${clientKey(req)}`, 30, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many routing writes — slow down." } },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const raw = (body ?? {}) as { upstream?: unknown; mode?: unknown };

  if (typeof raw.upstream !== "string" || !SETTABLE_UPSTREAMS.has(raw.upstream)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INVALID_UPSTREAM",
          message: `upstream must be one of: ${[...SETTABLE_UPSTREAMS].join(", ")}.`,
        },
      },
      { status: 400 },
    );
  }
  if (!isEgressMode(raw.mode)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INVALID_MODE",
          message: `mode must be exactly one of: ${ROUTING_MODES.join(", ")}.`,
        },
      },
      { status: 400 },
    );
  }

  const upstream = raw.upstream;
  const mode: EgressMode = raw.mode;

  try {
    // Merge into the existing map (readRoutingMap → set one key → upsert).
    const current = await readRoutingMap();
    const next: Record<string, EgressMode> = { ...current, [upstream]: mode };
    const value = JSON.stringify(next);
    await db.setting.upsert({
      where: { key: EGRESS_ROUTING_KEY },
      update: { value },
      create: { key: EGRESS_ROUTING_KEY, value },
    });
    return NextResponse.json({ ok: true, routing: next });
  } catch {
    // Never leak internals (§11 + P7).
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "EGRESS_ROUTING_WRITE_FAILED",
          message: "Could not persist the egress routing decision — try again.",
        },
      },
      { status: 500 },
    );
  }
}
