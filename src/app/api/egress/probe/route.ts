import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import {
  EGRESS_PROBE_TARGETS,
  classifyEgress,
  directFetch,
  loadEgressPool,
  parseTraceCountry,
  pickProxies,
  proxiedFetch,
  readRoutingMap,
  routeFor,
  type EgressHttpResponse,
  type EgressProbeTarget,
} from "@/lib/egress";

/**
 * POST /api/egress/probe — task 12-a.
 *
 * Body: { target: "groq" | "vyce" | "generic-echo" }
 *
 * Probes the whitelisted upstream DIRECT (sandbox egress) and through a pool
 * proxy (up to 3 different pool proxies before reporting failure honestly).
 * Response contract (P7): statuses/classifications/country-codes ONLY — never a
 * response body, never an IP, never proxy identities or credentials.
 *
 *   { ok:true, target, checkedAt,
 *     direct:  { status, reachable, classification, country? },
 *     proxied: { status, reachable, classification, attempts, via?, country?, error? },
 *     egressChanged: boolean, routing: { mode }, pool: { count, validCount } }
 *
 * §11 shape on 401/429/400: { ok:false, error:{ code, message } }.
 *
 * [MEASURED 2026-10-23] groq: direct → 403 (WAF), proxied → 401 invalid_api_key
 * — egressChanged:true proves the WAF bypass WITHOUT owning a Groq key.
 */

const MAX_PROXY_ATTEMPTS = 3;

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  if (!rateLimit(`egress-probe:${clientKey(req)}`, 10, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many egress probes — slow down (10/min)." } },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const targetRaw = (body as { target?: unknown } | null)?.target;
  if (typeof targetRaw !== "string" || !Object.hasOwn(EGRESS_PROBE_TARGETS, targetRaw)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INVALID_TARGET",
          message: `target must be one of: ${Object.keys(EGRESS_PROBE_TARGETS).join(", ")}.`,
        },
      },
      { status: 400 },
    );
  }
  const target = targetRaw as EgressProbeTarget;
  const conf = EGRESS_PROBE_TARGETS[target];

  // --- direct (sandbox egress) -------------------------------------------------
  const direct = await directFetch(conf.url, { headers: { Accept: "application/json" } }, 8_000);
  const directStatus = "status" in direct ? direct.status : null;
  const directCls = classifyEgress(directStatus);
  const directCountry =
    "status" in direct && direct.status === 200 && conf.kind === "country"
      ? parseTraceCountry(direct.bodyText)
      : null;

  // --- proxied (pool) ----------------------------------------------------------
  const poolLoad = await loadEgressPool();
  const attempts: number[] = [];
  let proxied: {
    status: number | null;
    reachable: boolean;
    classification: string;
    attempts: number;
    via?: string;
    country?: string | null;
    error?: { code: string; message: string };
  };

  if (!poolLoad.ok) {
    proxied = {
      status: null,
      reachable: false,
      classification: "PROXY_POOL_FAILED",
      attempts: 0,
      error: { code: poolLoad.code, message: poolLoad.message },
    };
  } else {
    const candidates = pickProxies(poolLoad.pool, MAX_PROXY_ATTEMPTS);
    let success: EgressHttpResponse | null = null;
    let lastFailure: { code: string; message: string } | null = null;

    for (const proxy of candidates) {
      attempts.push(attempts.length + 1); // count-only marker — never the proxy identity (P7)
      const res = await proxiedFetch(conf.url, { headers: { Accept: "application/json" } }, { proxy, timeoutMs: 9_000 });
      if ("status" in res) {
        success = res;
        break;
      }
      lastFailure = { code: res.code, message: res.message };
    }

    if (success) {
      const cls = classifyEgress(success.status);
      proxied = {
        status: success.status,
        reachable: true,
        classification: cls.classification,
        attempts: attempts.length,
        via: success.via,
        ...(conf.kind === "country" && success.status === 200
          ? { country: parseTraceCountry(success.bodyText) }
          : {}),
      };
    } else {
      proxied = {
        status: null,
        reachable: false,
        classification: "PROXY_FAILED",
        attempts: attempts.length,
        error: lastFailure ?? { code: "PROXY_TRANSPORT_UNAVAILABLE", message: "pool produced no usable proxy." },
      };
    }
  }

  // egressChanged: honest definition — both sides answered AND the upstream
  // conversation differs, or direct was unreachable while the proxy path worked.
  const directAnswered = directStatus !== null;
  const proxiedAnswered = proxied.status !== null;
  const egressChanged =
    (directAnswered && proxiedAnswered && directStatus !== proxied.status) ||
    (!directAnswered && proxiedAnswered);

  const routing = await readRoutingMap();

  return NextResponse.json({
    ok: true,
    target,
    checkedAt: new Date().toISOString(),
    direct: {
      status: directStatus,
      reachable: directCls.reachable,
      classification: directCls.classification,
      ...(directCountry ? { country: directCountry } : {}),
    },
    proxied,
    egressChanged,
    routing: { mode: routeFor(target, routing) },
    pool: poolLoad.ok
      ? { count: poolLoad.count, validCount: poolLoad.pool.filter((p) => p.valid === true).length }
      : null,
  });
}
