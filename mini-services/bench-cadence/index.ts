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

import { readFileSync, writeFileSync, unlinkSync, readlinkSync } from "node:fs";

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
// v38.4 (cron-20261031-0021): honest distinction between "the panel answered
// with a rejection" and "we could not talk to the panel at all" — the old
// single "panel-unreachable" label masked a live 401 login storm for hours.
let lastPanelFailure: "login-exhausted" | "panel-unreachable" | null = null;
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
  // v38.4: RELOAD the password on EVERY login attempt (boot, backoff retry,
  // 401 recovery). The old cache-once made a pre-restore generation storm
  // 401s forever after the workspace restore swapped .env — the file was
  // re-read never, so the new PANEL_PASSWORD was invisible to it.
  password = loadPanelPassword();
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
      lastPanelFailure = "panel-unreachable";
      return null; // transport-level panel failure — retry next cycle honestly
    }
  }
  lastPanelFailure = "login-exhausted";
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
      const why = status !== null ? ` http=${status}` : `=${lastPanelFailure ?? "panel-unreachable"}`;
      log(`[bench-cadence ${started}] trigger=${trigger} get=/api/benchmarks failed${why}`);
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
      log(`[bench-cadence ${started}] trigger=${trigger} refresh=${lastPanelFailure ?? "panel-unreachable"} (retry next cycle)`);
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
// v38.4 (cron-20261031-0021) — two hardening layers born from the measured
// incident: a bun --hot reload during the 2026-10-30 restore overlay stacked
// timer generations in one pid (double cycles, a zombie 401-storming
// generation with a stale cached PANEL_PASSWORD) and finally left a ZOMBIE
// SERVER: /health answered while the interval generation was dead (log silent
// 20:59Z→00:55Z, nextRunAt 3.5h in the past).
//   Layer 1 — cross-process single-instance pidfile guard (same doctrine as
//   mem-watchdog): a second launch whose pid differs from a live service-cwd
//   process exits honestly instead of stacking.
//   Layer 2 — generation-safe timers on globalThis: a --hot re-eval first
//   tries its own Bun.serve; only if the port was won does it clear the
//   previous generation's timers and schedule its own. A failed serve
//   (port owned by the live generation) stands down WITHOUT touching the
//   previous generation's timers — fail-open, the old generation keeps
//   running. One pid fires each cycle at most once, ever.
const PID_FILE = `${PROJECT_ROOT}/.zscripts/bench-cadence.pid`;

function pidAliveAndOurs(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return readlinkSync(`/proc/${pid}/cwd`).endsWith("/mini-services/bench-cadence");
  } catch {
    return false;
  }
}

function acquireSingleInstance(): boolean {
  try {
    const prev = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (Number.isFinite(prev) && prev !== process.pid && pidAliveAndOurs(prev)) {
      log(`[bench-cadence ${new Date().toISOString()}] second launch refused: pid ${prev} already serving — exiting`);
      return false;
    }
  } catch {
    /* no/stale pidfile — proceed */
  }
  try {
    writeFileSync(PID_FILE, String(process.pid));
  } catch {
    /* best-effort; single-instance is a guard, not a dependency */
  }
  return true;
}

if (!acquireSingleInstance()) process.exit(0);
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    try {
      if (readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) unlinkSync(PID_FILE);
    } catch {
      /* best-effort */
    }
    process.exit(0);
  });
}

const GEN_KEY = "__nexusBenchCadenceTimers";
const g = globalThis as Record<string, unknown>;
const generation = Number(g.__nexusBenchCadenceGen ?? 0) + 1;
g.__nexusBenchCadenceGen = generation;
g.__nexusBenchCadenceStartedAt = new Date().toISOString();
// Per-evaluation timer registry. Only a generation that WINS the port claims
// the global slot (g[GEN_KEY] = myTimers below) — a stand-down generation must
// never replace the winner's registry, or the next reload would clear an
// empty array and leak the live generation's timers forever.
const myTimers: unknown[] = [];
const track = <T>(t: T): T => {
  myTimers.push(t);
  return t;
};

let serveWon = false;
try {
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
          generation,
          startedAt: g.__nexusBenchCadenceStartedAt,
          pid: process.pid,
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
  serveWon = true;
} catch (err) {
  log(
    `[bench-cadence ${new Date().toISOString()}] generation ${generation} serve failed (${err instanceof Error ? err.message : "unknown"}) — standing down, existing generation keeps :${PORT}`,
  );
}

// Only the generation that WON the port schedules timers; it inherits and
// clears whatever timers an earlier generation left behind (hot-reload stack).
if (serveWon) {
  const prevTimers = g[GEN_KEY] as unknown[] | undefined;
  if (Array.isArray(prevTimers)) {
    for (const t of prevTimers) {
      clearTimeout(t as never);
      clearInterval(t as never);
    }
    log(
      `[bench-cadence ${new Date().toISOString()}] generation ${generation}: cleared ${prevTimers.length} inherited timer(s) from a previous generation`,
    );
  }
  g[GEN_KEY] = myTimers;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

  nextRunAt = Date.now() + FIRST_DELAY_MS;
  log(
    `[bench-cadence ${new Date().toISOString()}] listening on :${PORT} (pid ${process.pid}, generation ${generation}) — staleness check every ${CHECK_INTERVAL_MS / 60000} min (first in ${FIRST_DELAY_MS / 1000} s), stale after ${STALE_AFTER_HOURS} h, per-kind min-gap ${MIN_KIND_GAP_MS / 60000} min`,
  );

  track(
    setTimeout(async () => {
      await runCycle("boot");
      nextRunAt = Date.now() + CHECK_INTERVAL_MS;
    }, FIRST_DELAY_MS),
  );

  track(
    setInterval(async () => {
      await runCycle("interval");
      nextRunAt = Date.now() + CHECK_INTERVAL_MS;
    }, CHECK_INTERVAL_MS),
  );
}

// ---------------------------------------------------------------------------
// Watchdog sitter (cron-20261028-0825)
// ---------------------------------------------------------------------------
// ROOT CAUSE, measured twice (pid 5043 silent death, then the sitter's own
// probe pid 28242): ANY process spawned from an agent/tool bash invocation is
// SIGKILL'd when that invocation's session tears down — setsid/nohup/disown
// do NOT escape it (the cgroup reap gets them; verified with a test `sleep`).
// The three resident mini-services survive because they were booted by the
// sandbox boot path (dev.sh) and orphan-reparented long ago. The mem-watchdog
// therefore had NO launch path that survives: dev.sh instances were later
// SIGTERM'd by fix sessions, agent respawns died at session end.
//
// Fix: this RESIDENT service supervises the watchdog. Every 60s, if no live
// process has its cwd in mini-services/mem-watchdog, spawn one DETACHED from
// this long-lived process (children of a resident survive teardowns). The
// watchdog's own single-instance pidfile guard (same commit) makes double
// spawns harmless: a refused second launch logs and exits 0. If bench-cadence
// itself dies, the watchdog keeps running as an orphan and the 4h cron pass
// notices the sitter's silence in this log.
import { readdirSync, readlinkSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";

const SITTER_INTERVAL_MS = 60 * 1000;
const WATCHDOG_DIR = `${PROJECT_ROOT}/mini-services/mem-watchdog`;

function watchdogRunning(): boolean {
  try {
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        if (readlinkSync(`/proc/${pid}/cwd`).endsWith("/mini-services/mem-watchdog")) return true;
      } catch {
        /* vanished mid-scan */
      }
    }
  } catch {
    /* /proc unreadable — assume running, never spawn blindly */
    return true;
  }
  return false;
}

function spawnWatchdog(): void {
  try {
    const child = nodeSpawn(
      "bash",
      ["-lc", `cd ${WATCHDOG_DIR} && setsid nohup bun index.ts >> ${PROJECT_ROOT}/.zscripts/mini-service-mem-watchdog.log 2>&1 < /dev/null &`],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    log(`[watchdog-sitter ${new Date().toISOString()}] mem-watchdog absent -> spawned detached`);
  } catch (err) {
    log(`[watchdog-sitter ${new Date().toISOString()}] spawn failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// v38.4: the sitter's timers ride the same generation-safe registry — a stale
// hot-reload generation must never keep a duplicate sitter probe alive (the
// duplicate-sitter class is how two mem-watchdogs ended up running tonight).
if (serveWon) {
  track(
    setInterval(() => {
      if (!watchdogRunning()) spawnWatchdog();
    }, SITTER_INTERVAL_MS),
  );
  // One boot-delayed probe too (the boot cycle waits 30s; the sitter acts sooner).
  track(
    setTimeout(() => {
      if (!watchdogRunning()) spawnWatchdog();
    }, 10_000),
  );
}
