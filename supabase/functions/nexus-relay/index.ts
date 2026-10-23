/**
 * NEXUS OS — nexus-relay Edge Function (task 17-a).
 *
 * Purpose: the ONLY trusted place where the harness project's EF secret values
 * (VYCE_API_KEY / GROQ_API_KEY) are ever readable is inside an Edge Function
 * runtime via Deno.env. The Mgmt API GET /v1/projects/{ref}/secrets returns
 * SHA256 HEX DIGESTS, never plaintext [MEASURED, worklog 17-a context] — the
 * panel's old "read EF secret values" fallback therefore sent sha256(key) to
 * Vyce → eternal 401. This tiny relay proxies LLM calls using the runtime env
 * keys, authenticated by a relay secret provisioned on both sides (vault
 * service "supabase" / label "relay-secret" ⇄ EF secret NEXUS_PANEL_RELAY_SECRET).
 *
 * Contract (invoke at https://<ref>.supabase.co/functions/v1/nexus-relay):
 *
 *   GET  /health                        → 200 {"ok":true,"upstream":{"vyce":<bool>,"groq":<bool>}}
 *                                         NO auth; bools are !!Deno.env presence ONLY — never values.
 *   GET  /vyce/v1/models                → GET  {vyceRoot}/models                    (auth)
 *   POST /vyce/v1/chat/completions      → POST {vyceRoot}/chat/completions           (auth)
 *   POST /vyce/v1/images/generations    → POST {vyceRoot}/images/generations         (auth)
 *   GET  /groq/openai/v1/models         → GET  {groqRoot}/models                     (auth)
 *   POST /groq/openai/v1/chat/completions → POST {groqRoot}/chat/completions          (auth)
 *
 *   Anything else (or wrong method) → 404 {"error":{"code":"NOT_FOUND","message":"unknown relay route"}}.
 *
 * - vyceRoot = env VYCE_BASE_URL when it parses as an https URL with a host,
 *   else "https://vyceai.com/v1" (a garbage VYCE_BASE_URL — e.g. the 64-hex
 *   string measured in R16 — falls back to the default). groqRoot is fixed:
 *   "https://api.groq.com/openai/v1".
 * - Auth (proxy routes only): header `Authorization: Bearer <secret>` must
 *   constant-time-equal env NEXUS_PANEL_RELAY_SECRET (manual byte-wise compare,
 *   zero deps). Missing/mismatch/not-configured → 401
 *   {"error":{"code":"UNAUTHORIZED","message":"relay auth failed"}}.
 * - Upstream key: env VYCE_API_KEY / GROQ_API_KEY. Absent → 502
 *   {"error":{"code":"NO_UPSTREAM_KEY","message":"<KEY> is not configured on the
 *   harness project"}} — static strings only.
 * - Pass-through: method/body forwarded verbatim (caller's Authorization header
 *   is stripped and replaced with the upstream env key); upstream status + body
 *   stream straight through (chat/SSE is NEVER buffered); Content-Type passes
 *   through upstream's (default application/json).
 * - Timeouts: 15s for GET models, 120s for POST chat/images. Transport
 *   failures/timeout → 502 {"error":{"code":"UPSTREAM_UNREACHABLE", ...}} (static).
 * - CORS: permissive (OPTIONS → 200; allow-headers include authorization +
 *   content-type), matching the old cortex function posture. verify_jwt is
 *   false (deployed with verify_jwt:false — the relay-secret header IS the auth).
 *
 * P7 notes: this function NEVER returns, logs, or echoes secret material — no
 * PAT, no relay secret, no upstream key values. Only booleans (key presence),
 * static error strings, statuses, and verbatim upstream bodies produced by the
 * upstream itself ever cross this boundary. The relay secret and upstream keys
 * live only in the runtime env (Deno.env) and the outbound Authorization header.
 *
 * Deps: none (Deno globals only).
 */

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

/** Constant-time byte-wise string equality (length-independent, no deps). */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  const n = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < n; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/** VYCE_BASE_URL when it parses as https + host; else the measured default. */
function vyceRoot(): string {
  const raw = Deno.env.get("VYCE_BASE_URL");
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length > 0) {
    try {
      const u = new URL(trimmed);
      if (u.protocol === "https:" && u.host.length > 0) {
        return trimmed.replace(/\/+$/, "");
      }
    } catch {
      // not a URL — fall through to default (R16: env holds a 64-hex string)
    }
  }
  return "https://vyceai.com/v1";
}

const GROQ_ROOT = "https://api.groq.com/openai/v1";

type Upstream = "vyce" | "groq";

type AllowEntry = { upstream: Upstream; method: "GET" | "POST"; path: string };

/** Exact allowlist — anything outside it answers 404, auth or not. */
const ALLOWLIST: Record<string, AllowEntry> = {
  "/vyce/v1/models": { upstream: "vyce", method: "GET", path: "/models" },
  "/vyce/v1/chat/completions": { upstream: "vyce", method: "POST", path: "/chat/completions" },
  "/vyce/v1/images/generations": { upstream: "vyce", method: "POST", path: "/images/generations" },
  "/groq/openai/v1/models": { upstream: "groq", method: "GET", path: "/models" },
  "/groq/openai/v1/chat/completions": { upstream: "groq", method: "POST", path: "/chat/completions" },
};

/** Path after the /functions/v1/nexus-relay prefix ("" → "/"). */
function relayRoute(reqUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(reqUrl).pathname;
  } catch {
    return "/";
  }
  const marker = "/nexus-relay";
  const idx = pathname.indexOf(marker);
  const rest = idx >= 0 ? pathname.slice(idx + marker.length) : pathname;
  if (rest.length === 0) return "/";
  return rest.startsWith("/") ? rest : `/${rest}`;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: CORS_HEADERS });
  }

  const route = relayRoute(req.url);

  // Health: unauthenticated, boolean presence only.
  if (route === "/health" && req.method === "GET") {
    return json(200, {
      ok: true,
      upstream: {
        vyce: !!Deno.env.get("VYCE_API_KEY"),
        groq: !!Deno.env.get("GROQ_API_KEY"),
      },
    });
  }

  const entry = ALLOWLIST[route];
  if (!entry || req.method !== entry.method) {
    return json(404, { error: { code: "NOT_FOUND", message: "unknown relay route" } });
  }

  // Relay auth — constant-time compare against the runtime relay secret.
  const expected = Deno.env.get("NEXUS_PANEL_RELAY_SECRET") ?? "";
  const header = req.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (expected.length === 0 || !constantTimeEqual(provided, expected)) {
    return json(401, { error: { code: "UNAUTHORIZED", message: "relay auth failed" } });
  }

  // Upstream key presence — static message, never any value.
  const envKey = entry.upstream === "vyce" ? "VYCE_API_KEY" : "GROQ_API_KEY";
  const upstreamKey = Deno.env.get(envKey) ?? "";
  if (upstreamKey.length === 0) {
    return json(502, {
      error: {
        code: "NO_UPSTREAM_KEY",
        message: `${envKey} is not configured on the harness project`,
      },
    });
  }

  const root = entry.upstream === "vyce" ? vyceRoot() : GROQ_ROOT;
  const targetUrl = `${root}${entry.path}`;
  const timeoutMs = entry.method === "GET" ? 15_000 : 120_000;

  // Caller's Authorization is dropped; the runtime env key goes upstream.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${upstreamKey}`,
    Accept: req.headers.get("accept") ?? "application/json",
  };
  const contentType = req.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;

  let bodyBytes: ArrayBuffer | undefined;
  if (entry.method === "POST") {
    bodyBytes = await req.arrayBuffer(); // verbatim request body
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(targetUrl, {
      method: entry.method,
      headers,
      body: bodyBytes && bodyBytes.byteLength > 0 ? bodyBytes : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return json(502, {
      error: {
        code: "UPSTREAM_UNREACHABLE",
        message: "upstream did not answer (timeout or network error)",
      },
    });
  }

  const resHeaders: Record<string, string> = { ...CORS_HEADERS };
  resHeaders["Content-Type"] = upstreamRes.headers.get("content-type") ?? "application/json";
  const cacheControl = upstreamRes.headers.get("cache-control");
  if (cacheControl) resHeaders["Cache-Control"] = cacheControl;

  // Response body passes straight through — SSE streams are never buffered.
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: resHeaders,
  });
});
