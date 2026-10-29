import { db } from "@/lib/db";
import { clampStr } from "@/lib/brain/auth";
import { exaSearch, pushWebhookItem } from "@/lib/connectors/exa";

/**
 * NEXUS OS — Exa LOCAL monitors (v34): scheduled research done in-process.
 *
 * WHY LOCAL-FIRST: Exa's native POST /monitors REQUIRES a public https
 * webhook URL (no redirects — MEASURED error "webhook url required"). This
 * sandbox panel origin is http behind the preview gateway and not a stable
 * public endpoint Exa's servers can reach, so native monitor creation always
 * failed with "Monitor failed: webhook url required". Owner intent for
 * monitors is simple: scheduled searches whose fresh results surface in the
 * panel and land in the webhook inbox — nothing about that needs Exa's
 * webhook infrastructure. So:
 *
 *   - DEFAULT (transport "local"): monitors live in SQLite (Setting), an
 *     in-process scheduler fires them on their interval, each run goes
 *     through the SAME exaSearch pipeline (budgets + usage ledger honest),
 *     results are URL-deduped against the previous run and pushed into the
 *     existing webhook inbox (kind "local.run.completed") so every existing
 *     surface (Pipeline "last webhook at", panel inbox) just works.
 *   - Native Exa monitors (transport "exa") are still created when an
 *     explicit PUBLIC https webhook URL exists (EXA_WEBHOOK_URL env or an
 *     owner-provided URL) — e.g. a Supabase function relay.
 *
 * Credit discipline: max 5 local monitors, min interval 15 min, searches
 * share the daily exa search budget, run history capped at 40 rows.
 */

export const EXA_LOCAL_MONITORS_SETTING = "exa.monitors.local";
export const EXA_MONITOR_RUNS_SETTING = "exa.monitor.runs";

export type ExaLocalMonitor = {
  id: string;
  query: string;
  numResults: number;
  periodMs: number;
  periodLabel: string;
  createdAt: string;
  paused: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: "never" | "ok" | "error";
  lastError: string;
  lastItemCount: number;
  runCount: number;
};

export type ExaMonitorRun = {
  id: string;
  monitorId: string;
  query: string;
  at: string;
  ok: boolean;
  itemCount: number;
  newCount: number;
  error: string;
  tookMs: number;
  top: Array<{ title: string; url: string; source: string; date: string }>;
};

/** Allowed intervals (local can go lower than Exa-native's 1h minimum). */
export const LOCAL_PERIODS: Record<string, number> = {
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "6h": 6 * 3_600_000,
  "12h": 12 * 3_600_000,
  "1d": 86_400_000,
  "7d": 7 * 86_400_000,
};
export const MAX_LOCAL_MONITORS = 5;
const MAX_RUNS = 40;
/** First check lands ~1 min after creation so the owner sees a live run
 * immediately instead of staring at an empty history for an hour. */
const FIRST_RUN_DELAY_MS = 60_000;

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  const row = await db.setting.findUnique({ where: { key } }).catch(() => null);
  if (!row?.value) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await db.setting
    .upsert({
      where: { key },
      create: { key, value: JSON.stringify(value) },
      update: { value: JSON.stringify(value) },
    })
    .catch(() => {});
}

export async function listLocalMonitors(): Promise<ExaLocalMonitor[]> {
  return readJson<ExaLocalMonitor[]>(EXA_LOCAL_MONITORS_SETTING, []);
}

async function saveMonitors(monitors: ExaLocalMonitor[]): Promise<void> {
  await writeJson(EXA_LOCAL_MONITORS_SETTING, monitors);
}

export async function listMonitorRuns(limit = 12): Promise<ExaMonitorRun[]> {
  const runs = await readJson<ExaMonitorRun[]>(EXA_MONITOR_RUNS_SETTING, []);
  return runs.slice(0, Math.max(1, Math.min(40, limit)));
}

export type CreateLocalMonitorInput = {
  query: string;
  numResults?: number;
  period?: string;
};

export async function createLocalMonitor(
  input: CreateLocalMonitorInput,
): Promise<{ ok: true; monitor: ExaLocalMonitor } | { ok: false; error: string }> {
  const query = clampStr(input.query, 300).trim();
  if (!query) return { ok: false, error: "query required" };
  const periodLabel = input.period && LOCAL_PERIODS[input.period] ? input.period : "1d";
  const periodMs = LOCAL_PERIODS[periodLabel];

  const monitors = await listLocalMonitors();
  if (monitors.length >= MAX_LOCAL_MONITORS) {
    return { ok: false, error: `local monitor limit reached (${MAX_LOCAL_MONITORS}) — delete one first` };
  }
  if (monitors.some((m) => m.query.toLowerCase() === query.toLowerCase())) {
    return { ok: false, error: "a monitor with this query already exists" };
  }

  const monitor: ExaLocalMonitor = {
    id: `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    query,
    numResults: Math.min(10, Math.max(1, Math.round(input.numResults ?? 8))),
    periodMs,
    periodLabel,
    createdAt: new Date().toISOString(),
    paused: false,
    lastRunAt: null,
    nextRunAt: new Date(Date.now() + FIRST_RUN_DELAY_MS).toISOString(),
    lastStatus: "never",
    lastError: "",
    lastItemCount: 0,
    runCount: 0,
  };
  monitors.push(monitor);
  await saveMonitors(monitors);
  return { ok: true, monitor };
}

export async function deleteLocalMonitor(id: string): Promise<boolean> {
  const monitors = await listLocalMonitors();
  const next = monitors.filter((m) => m.id !== id);
  if (next.length === monitors.length) return false;
  await saveMonitors(next);
  return true;
}

export async function setLocalMonitorPaused(id: string, paused: boolean): Promise<ExaLocalMonitor | null> {
  const monitors = await listLocalMonitors();
  const m = monitors.find((x) => x.id === id);
  if (!m) return null;
  m.paused = paused;
  if (paused) {
    // Freeze the schedule while paused; resume pushes the next run a full
    // period out so unpausing never bursts missed cycles.
    m.nextRunAt = null;
  } else {
    m.nextRunAt = new Date(Date.now() + LOCAL_PERIODS[m.periodLabel]).toISOString();
  }
  await saveMonitors(monitors);
  return m;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** Per-monitor single-flight so a slow search can never stack runs. */
const inFlight = new Set<string>();

export async function runLocalMonitor(monitor: ExaLocalMonitor): Promise<ExaMonitorRun | null> {
  if (inFlight.has(monitor.id)) return null;
  inFlight.add(monitor.id);
  const startedAt = Date.now();
  try {
    const search = await exaSearch({
      query: monitor.query,
      numResults: monitor.numResults,
      recencyDays: 2,
      type: "auto",
    });

    const runs = await readJson<ExaMonitorRun[]>(EXA_MONITOR_RUNS_SETTING, []);
    // URL-dedupe against THIS monitor's most recent run (Exa-Monitor spirit).
    const prevUrls = new Set<string>(
      runs.find((r) => r.monitorId === monitor.id && r.ok)?.top.map((t) => t.url) ?? [],
    );

    const top: ExaMonitorRun["top"] = [];
    let newCount = 0;
    if (search.ok) {
      for (const r of search.results) {
        if (r.url && !prevUrls.has(r.url)) newCount += 1;
        top.push({
          title: clampStr(r.title, 140),
          url: clampStr(r.url, 300),
          source: hostOf(r.url),
          date: r.publishedDate ? r.publishedDate.slice(0, 10) : "",
        });
      }
    }

    const run: ExaMonitorRun = {
      id: `${monitor.id}_${startedAt.toString(36)}`,
      monitorId: monitor.id,
      query: monitor.query,
      at: new Date(startedAt).toISOString(),
      ok: search.ok,
      itemCount: search.ok ? search.results.length : 0,
      newCount,
      error: search.ok ? "" : clampStr(search.error, 200),
      tookMs: search.tookMs,
      top: top.slice(0, 8),
    };

    runs.unshift(run);
    await writeJson(EXA_MONITOR_RUNS_SETTING, runs.slice(0, MAX_RUNS));

    // Same inbox native monitors feed — panel + Pipeline surfaces light up.
    if (search.ok) {
      await pushWebhookItem({
        receivedAt: run.at,
        monitorId: `local:${monitor.id}`,
        kind: "local.run.completed",
        payload: {
          query: monitor.query,
          itemCount: run.itemCount,
          newCount: run.newCount,
          top: run.top.slice(0, 5),
        },
      });
      await db.setting
        .upsert({
          where: { key: "exa.webhook.last" },
          create: { key: "exa.webhook.last", value: run.at },
          update: { value: run.at },
        })
        .catch(() => {});
    }

    // Persist the new schedule REGARDLESS of run outcome (a failing monitor
    // must not spin — next attempt is one full period away).
    const monitors = await listLocalMonitors();
    const m = monitors.find((x) => x.id === monitor.id);
    if (m) {
      m.lastRunAt = run.at;
      m.lastStatus = run.ok ? "ok" : "error";
      m.lastError = run.error;
      m.lastItemCount = run.itemCount;
      m.runCount += 1;
      m.nextRunAt = new Date(Date.now() + m.periodMs).toISOString();
      await saveMonitors(monitors);
    }
    return run;
  } catch (e) {
    // Record the crash as an error run — never let the scheduler die silently.
    const monitors = await listLocalMonitors();
    const m = monitors.find((x) => x.id === monitor.id);
    if (m) {
      m.lastRunAt = new Date(startedAt).toISOString();
      m.lastStatus = "error";
      m.lastError = clampStr(e instanceof Error ? e.message : "run failed", 200);
      m.nextRunAt = new Date(Date.now() + m.periodMs).toISOString();
      await saveMonitors(monitors);
    }
    return null;
  } finally {
    inFlight.delete(monitor.id);
  }
}

export async function runLocalMonitorNow(id: string): Promise<ExaMonitorRun | null> {
  const monitors = await listLocalMonitors();
  const m = monitors.find((x) => x.id === id);
  if (!m) return null;
  return runLocalMonitor(m);
}

// ---------------------------------------------------------------------------
// Scheduler (in-process cron; survives via globalThis across HMR)
// ---------------------------------------------------------------------------

type SchedulerState = { timer: ReturnType<typeof setInterval> | null; ticking: boolean };
const g = globalThis as unknown as { __exaMonitorScheduler?: SchedulerState };

export function ensureMonitorScheduler(): void {
  const state = (g.__exaMonitorScheduler ??= { timer: null, ticking: false });
  if (state.timer) return;
  state.timer = setInterval(() => {
    void schedulerTick();
  }, 60_000);
  // Don't hold the process open for the scheduler.
  state.timer.unref?.();
  // Early first tick so a due monitor doesn't wait a full minute.
  setTimeout(() => {
    void schedulerTick();
  }, 5_000).unref?.();
}

async function schedulerTick(): Promise<void> {
  const state = g.__exaMonitorScheduler;
  if (!state || state.ticking) return;
  state.ticking = true;
  try {
    const monitors = await listLocalMonitors();
    const now = Date.now();
    for (const m of monitors) {
      if (m.paused || !m.nextRunAt) continue;
      if (Date.parse(m.nextRunAt) <= now) {
        // Fire-and-forget per monitor; runLocalMonitor single-flights and
        // always reschedules (ok OR error), so missed cycles never burst.
        void runLocalMonitor(m).catch(() => {});
      }
    }
  } catch {
    /* tick failure is non-fatal */
  } finally {
    state.ticking = false;
  }
}
