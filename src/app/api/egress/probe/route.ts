import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { loadVyceKey } from "@/lib/connectors/vyce";
import { loadGroqKey } from "@/lib/ai/groq";
import { resolveGroqKeyFallback } from "@/lib/ai/client";
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
 *
 * [FIXED 2026-10-26] The original probe sent NO Authorization header, so every
 * auth'd gateway (vyce) answered the standard OpenAI 401 envelope and the card
 * rendered "KEY_REJECTED" — about a KEYLESS request — on every single probe,
 * while live calls with the vault key verifiably answered 200. Dishonest by
 * construction. The probe now attaches the VAULT key for vyce/groq (in-process
 * only; the response contract stays statuses/classifications ONLY — P7), so:
 *   · 200 OK            → key + transport both work (the truth users need)
 *   · 401 KEY_REJECTED  → the upstream genuinely rejected the vault key
 *   · 403 direct only    → WAF/egress block, key never reached the upstream
 *   · no key in vault    → keyless probe, and 401 then means "unauthenticated
 *                          probe answered" — rendered as UNAUTH_PROBE, not a
 *                          fake "key rejected" verdict.
 *
 * [FIXED 2026-10-26 #2] Per-target probe budgets (EGRESS_PROBE_TARGETS
 * .probeTimeoutMs): the old blanket 8s direct / 9s per-proxy timeouts
 * declared vyce UNREACHABLE while the platform answers in the ~14s class —
 * "egress routing not worked on vyce" was a measurement artifact, not a
 * routing failure. Vyce now probes with 15s budgets and 2 pool attempts
 * (30s worst case); fast targets keep 8s/3.
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

  // Vault key attachment (2026-10-26 fix): probe what the REAL calls measure.
  // The key stays in-process — headers are transport-only, and the response
  // contract below never carries header material or bodies (P7).
  // 2026-10-26 #3: Groq probes now use the FULL runtime key chain
  // (vault → Supabase edge-secret). Before, an empty Groq vault made every
  // probe keyless — the card read "401 · UNAUTH_PROBE" (a transport fact)
  // while the actual runtime problem was the edge secret being a SHA-256
  // hash. keyState/keyNote now say which key probed and WHY none could.
  const headers: Record<string, string> = { Accept: "application/json" };
  let keyless = true;
  let keyState: "vault" | "edge-secret" | "keyless" = "keyless";
  let keyNote: string | null = null;
  if (target === "vyce") {
    const k = await loadVyceKey();
    if (k.ok) {
      headers.Authorization = `Bearer ${k.key}`;
      keyless = false;
      keyState = "vault";
    }
  } else if (target === "groq") {
    const g = await loadGroqKey();
    if (g.ok) {
      headers.Authorization = `Bearer ${g.key}`;
      keyless = false;
      keyState = "vault";
    } else {
      // Same chain the brain's Groq lane resolves (client.ts) — the probe
      // must measure the key the runtime would actually send.
      const fb = await resolveGroqKeyFallback();
      if (fb.ok) {
        headers.Authorization = `Bearer ${fb.key}`;
        keyless = false;
        keyState = "edge-secret";
      } else {
        keyNote = fb.reason;
      }
    }
  }

  // --- direct (sandbox egress) -------------------------------------------------
  const direct = await directFetch(conf.url, { headers }, conf.probeTimeoutMs);
  const directStatus = "status" in direct ? direct.status : null;
  const directCls = keyless && directStatus === 401
    ? { classification: "UNAUTH_PROBE" as const, reachable: true }
    : classifyEgress(directStatus);
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
    // Slow-but-alive upstreams (vyce ~14s) get 2 attempts so an honest 15s
    // budget per attempt still answers inside a reasonable window.
    const maxAttempts = target === "vyce" ? 2 : MAX_PROXY_ATTEMPTS;
    const candidates = pickProxies(poolLoad.pool, maxAttempts);
    let success: EgressHttpResponse | null = null;
    let lastFailure: { code: string; message: string } | null = null;

    for (const proxy of candidates) {
      attempts.push(attempts.length + 1); // count-only marker — never the proxy identity (P7)
      const res = await proxiedFetch(conf.url, { headers }, { proxy, timeoutMs: conf.probeTimeoutMs });
      if ("status" in res) {
        success = res;
        break;
      }
      lastFailure = { code: res.code, message: res.message };
    }

    if (success) {
      const cls = keyless && success.status === 401
        ? { classification: "UNAUTH_PROBE" as const, reachable: true }
        : classifyEgress(success.status);
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
    keyState,
    keyNote,
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
