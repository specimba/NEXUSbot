/**
 * NEXUS OS — bench-cadence mini service (port 3012), task R18-c.
 *
 * Keeps the six owner-specified model-benchmark sources (Artificial Analysis +
 * five arena.ai leaderboards) fresh on a 6-hour cadence so model ordering in
 * the panel never rests on stale knowledge. Mirrors the backup-cadence
 * doctrine: fully decoupled from the Next build — it talks to the PANEL over
 * HTTP with an in-process login, exactly like an operator would.
 *
 * Mechanism (deliberately no src/ imports):
 *  - boot: parse PANEL_PASSWORD from /home/z/my-project/.env in-process
 *    (value NEVER logged/printed/embedded — P7), POST /api/auth/login → keep
 *    the bearer token in memory only; re-login on 401s.
 *  - cycle (first ~30 s after boot, then every 30 min):
 *      GET  /api/benchmarks            → which sources are missing/stale?
 *      POST /api/benchmarks {}         → refresh ALL stale-or-missing in ONE
 *                                        panel call (one rate-limit hit; the
 *                                        panel route's per-kind mutex dedupes
 *                                        concurrent refreshes).
 *    [MEASURED deviation from the per-kind sketch]: POST {kind}×6 in one
 *    cycle would trip the panel's 4/hour refresh rate limit at first boot;
 *    the {} body refreshes the same set in a single, contract-documented call.
 *  - per-kind min-gap 15 min (defensive: a kind this service saw refresh
 *    successfully < 15 min ago is skipped for this cycle even if still marked
 *    stale by a lagging snapshot read).
 *  - never overlaps (running flag); login failures → backoff retries; panel
 *    down → honest log, retry next cycle; bun --hot keeps it alive.
 *
 * Log: /home/z/my-project/.zscripts/bench-cadence.log — timestamps + kinds +
 * ok/via/modelCount/error-code ONLY. No tokens, no passwords, no bodies (P7).
 */

import { readFileSync } from "node:fs";

const PORT = 3012;
const PROJECT_ROOT = "/home/z/my-project";
const ENV_PATH = `${PROJECT_ROOT}/.env`;
const LOG_PATH = `${PROJECT_ROOT}/.zscripts/bench-cadence.log`;

const PANEL = "http://localhost:3000";
const FIRST_DELAY_MS = 30 * 1000;
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // staleness re-check every 30 min
const MIN_KIND_GAP_MS = 15 * 60 * 1000; // per-kind min gap (successful refresh seen)
const STALE_AFTER_HOURS = 6; // mirrors STALE_AFTER_MS in src/lib/benchmarks.ts

const GET_TIMEOUT_MS = 15_000;
const REFRESH_TIMEOUT_MS = 10 * 60 * 1000; // 6 live scrapes can take a while
const LOGIN_BACKOFF_MS = [5_000, 15_000]; // login failures → log + backoff retries

type KindResult = {
  kind: string;
  ok: boolean;
  via: string;
  modelCount: number | null;
  errorCode: string | null;
};

let token: string | null = null; // in-memory only — NEVER logged (P7)
let password: string | null = null; // in-memory only — NEVER logged (P7)
let running = false;
let lastRunAt: number | null = null;
let nextRunAt: number | null = null;
let lastResults: KindResult[] | null = null;
const lastOkSeenAt = new Map<string, number>(); // kind → ts of last successful refresh this service observed

// ---------------------------------------------------------------------------
// Logging (append-only; P7-safe lines only)
// ---------------------------------------------------------------------------

// Serialize append-only log writes: log() fires without awaiting, and a
// read-modify-write race was [MEASURED] to lose concurrent lines.
let logQueue: Promise<void> = Promise.resolve();

function log(line: string): void {
  console.log(line);
  logQueue = logQueue
    .then(async () => {
      try {
        const existing = await Bun.file(LOG_PATH).text().catch(() => "");
        await Bun.write(LOG_PATH, existing + line + "\n");
      } catch {
        // best-effort — a log write failure must never break the cadence
      }
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Panel auth (in-process; secrets never leave memory)
// ---------------------------------------------------------------------------

function loadPanelPassword(): string | null {
  // Explicit .env parse — Bun's auto-loader uses the CWD, which is this
  // service dir, so the ROOT .env is read manually. Value never printed.
  try {
    const text = readFileSync(ENV_PATH, "utf-8") as string;
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t.startsWith("PANEL_PASSWORD=")) {
        const v = t.slice("PANEL_PASSWORD=".length).trim();
        const unquoted =
          v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
            ? v.slice(1, -1)
            : v;
        return unquoted.length > 0 ? unquoted : null;
      }
    }
  } catch {
    // .env unreadable — honest failure logged by panelLogin
  }
  return null;
}

async function panelLogin(): Promise<boolean> {
  if (!password) password = loadPanelPassword();
  if (!password) {
    log(`[bench-cadence ${new Date().toISOString()}] login failed=PANEL_PASSWORD missing from ${ENV_PATH}`);
    return false;
  }
  try {
    const res = await fetch(`${PANEL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log(`[bench-cadence ${new Date().toISOString()}] login http=${res.status} (will back off and retry)`);
      return false;
    }
    const body = (await res.json().catch(() => null)) as { token?: unknown } | null;
    if (!body || typeof body.token !== "string") {
      log(`[bench-cadence ${new Date().toISOString()}] login failed=no-token-in-response`);
      return false;
    }
    token = body.token; // in-memory only (P7)
    return true;
  } catch {
    log(`[bench-cadence ${new Date().toISOString()}] login failed=panel-unreachable`);
    return false;
  }
}

async function panelFetch(
  path: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<Response | null> {
  // Up to 1 + LOGIN_BACKOFF_MS.length login rounds: a login failure backs
  // off per the table and retries; a 401 mid-request just re-logins.
  for (let round = 0; round <= LOGIN_BACKOFF_MS.length; round++) {
    if (!token) {
      const loggedIn = await panelLogin();
      if (!loggedIn) {
        if (round === LOGIN_BACKOFF_MS.length) return null;
        const waitMs = LOGIN_BACKOFF_MS[round];
        log(`[bench-cadence ${new Date().toISOString()}] login retry=${round + 1} backoff=${waitMs / 1000}s`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
    }
    try {
      const res = await fetch(`${PANEL}${path}`, {
        method: init?.method ?? "GET",
        headers: {
          ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
          Authorization: `Bearer ${token}`,
        },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(init?.timeoutMs ?? GET_TIMEOUT_MS),
      });
      if (res.status === 401) {
        token = null; // expired/invalid session — re-login on the next round
        continue;
      }
      return res;
    } catch {
      token = null;
      return null; // transport-level panel failure — retry next cycle honestly
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cadence cycle
// ---------------------------------------------------------------------------

async function runCycle(trigger: string): Promise<{ accepted: boolean; results: KindResult[] | null }> {
  if (running) {
    log(`[bench-cadence ${new Date().toISOString()}] trigger=${trigger} dropped=run-in-progress`);
    return { accepted: false, results: null };
  }
  running = true;
  const started = new Date().toISOString();
  try {
    // 1. read current board states
    const getRes = await panelFetch("/api/benchmarks");
    if (!getRes || !getRes.ok) {
      const status = getRes ? getRes.status : null;
      log(`[bench-cadence ${started}] trigger=${trigger} get=/api/benchmarks failed${status !== null ? ` http=${status}` : "=panel-unreachable"}`);
      return { accepted: true, results: null };
    }
    const body = (await getRes.json().catch(() => null)) as
      | { sources?: { kind?: unknown; fetchedAt?: unknown; ageHours?: unknown }[] }
      | null;
    const sources = Array.isArray(body?.sources) ? body!.sources! : [];
    const now = Date.now();
    const staleKinds: string[] = [];
    for (const s of sources) {
      if (typeof s.kind !== "string") continue;
      const fetchedAt = typeof s.fetchedAt === "string" ? s.fetchedAt : null;
      const ageHours = typeof s.ageHours === "number" ? s.ageHours : null;
      const missing = fetchedAt === null;
      const stale = ageHours !== null && ageHours >= STALE_AFTER_HOURS;
      if (!missing && !stale) continue;
      const lastOk = lastOkSeenAt.get(s.kind) ?? 0;
      if (now - lastOk < MIN_KIND_GAP_MS) continue; // per-kind min-gap (15 min)
      staleKinds.push(s.kind);
    }

    if (staleKinds.length === 0) {
      log(`[bench-cadence ${started}] trigger=${trigger} cycle=fresh-all (nothing stale, no refresh needed)`);
      lastRunAt = Date.now();
      lastResults = [];
      return { accepted: true, results: [] };
    }

    // 2. refresh all stale-or-missing sources in ONE panel call (one
    //    rate-limit hit — see header note for the measured deviation)
    const postRes = await panelFetch("/api/benchmarks", {
      method: "POST",
      body: {},
      timeoutMs: REFRESH_TIMEOUT_MS,
    });
    if (!postRes) {
      log(`[bench-cadence ${started}] trigger=${trigger} refresh=panel-unreachable (retry next cycle)`);
      return { accepted: true, results: null };
    }
    if (postRes.status === 429) {
      log(`[bench-cadence ${started}] trigger=${trigger} refresh=rate-limited-by-panel (retry next cycle)`);
      return { accepted: true, results: null };
    }
    if (!postRes.ok) {
      log(`[bench-cadence ${started}] trigger=${trigger} refresh http=${postRes.status}`);
      return { accepted: true, results: null };
    }
    const resultBody = (await postRes.json().catch(() => null)) as
      | { results?: { kind?: unknown; ok?: unknown; via?: unknown; modelCount?: unknown; error?: { code?: unknown } | null }[] }
      | null;
    const rows = Array.isArray(resultBody?.results) ? resultBody!.results! : [];
    const results: KindResult[] = rows.map((r) => ({
      kind: typeof r.kind === "string" ? r.kind : "?",
      ok: r.ok === true,
      via: typeof r.via === "string" ? r.via : "?",
      modelCount: typeof r.modelCount === "number" ? r.modelCount : null,
      errorCode: r.error && typeof r.error.code === "string" ? r.error.code : null,
    }));

    // 3. honest per-kind log lines (kinds/counts/statuses only — P7)
    const okCount = results.filter((r) => r.ok).length;
    const refreshedSet = new Set(results.map((r) => r.kind));
    const stillStale = staleKinds.filter((k) => !refreshedSet.has(k));
    log(
      `[bench-cadence ${started}] trigger=${trigger} stale=${staleKinds.join(",") || "none"} refresh=ok:${okCount}/${results.length}` +
        (stillStale.length > 0 ? ` (skipped-by-panel-as-fresh=${stillStale.join(",")})` : ""),
    );
    for (const r of results) {
      log(
        `  kind=${r.kind} ok=${r.ok} via=${r.via}` +
          (r.ok ? ` models=${r.modelCount ?? "?"}` : ` error=${r.errorCode ?? "?"}`),
      );
      if (r.ok) lastOkSeenAt.set(r.kind, Date.now());
    }

    lastRunAt = Date.now();
    lastResults = results;
    return { accepted: true, results };
  } catch (err) {
    log(
      `[bench-cadence ${started}] trigger=${trigger} cycle-error=${err instanceof Error ? err.name : "unknown"}`,
    );
    return { accepted: true, results: null };
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "bench-cadence",
        intervalMs: CHECK_INTERVAL_MS,
        minKindGapMs: MIN_KIND_GAP_MS,
        staleAfterHours: STALE_AFTER_HOURS,
        running,
        lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
        nextRunAt: nextRunAt ? new Date(nextRunAt).toISOString() : null,
        lastResults,
      });
    }
    if (url.pathname === "/run" && req.method === "POST") {
      // Awaited so the response is honest about what actually happened.
      return runCycle("http").then((r) =>
        Response.json({
          ok: true,
          accepted: r.accepted,
          results: r.results,
          reason: r.accepted ? undefined : "dropped: a cycle is already running",
        }),
      );
    }
    return new Response("bench-cadence: see /health", { status: 404 });
  },
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

nextRunAt = Date.now() + FIRST_DELAY_MS;
log(
  `[bench-cadence ${new Date().toISOString()}] listening on :${PORT} — staleness check every ${CHECK_INTERVAL_MS / 60000} min (first in ${FIRST_DELAY_MS / 1000} s), stale after ${STALE_AFTER_HOURS} h, per-kind min-gap ${MIN_KIND_GAP_MS / 60000} min`,
);

setTimeout(async () => {
  await runCycle("boot");
  nextRunAt = Date.now() + CHECK_INTERVAL_MS;
}, FIRST_DELAY_MS);

setInterval(async () => {
  await runCycle("interval");
  nextRunAt = Date.now() + CHECK_INTERVAL_MS;
}, CHECK_INTERVAL_MS);
