/**
 * NEXUS OS — backup-cadence mini service (port 3011).
 *
 * Periodically runs scripts/snapshot-backup.sh so workspace durability does not
 * depend on anyone remembering to click the panel button. The script itself is
 * idempotent (content-unchanged → SKIP), fail-closed (secret scan aborts the
 * push), fast-forward-only behind a remote-divergence pre-check (exit 5 →
 * "diverged"; never force-pushes, §8), and self-throttled (30-min minimum gap
 * between SUCCESSFUL pushes, skipped honestly via "SKIP: throttled").
 *
 * Throttle / bypass policy (12-d, 10-b review): ONLY this service's own cadence
 * timer (boot + 6h interval) sets NEXUS_BACKUP_FORCE=1 to bypass the script's
 * 30-min push throttle — a 6h timer must stay authoritative even when a manual
 * run happened minutes earlier. The panel button (POST /api/backup/run → Next.js
 * route → script) and this service's POST /run run the script UNFORCED: they go
 * through the throttle like anyone else. A forced run is still content-gated
 * (unchanged tree → SKIP) — the bypass never skips the dedupe or the scan.
 *
 * Cadence: every 6 hours, first run 90 s after boot. A 30-minute minimum gap is
 * enforced between runs here as an extra in-process guard against overlapping
 * invocations. State: .zscripts/backup-cadence.log (append-only; the backup log
 * never contains secrets, P7).
 */

const PORT = 3011;
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_DELAY_MS = 90 * 1000;
const MIN_GAP_MS = 30 * 60 * 1000;

const PROJECT_ROOT = "/home/z/my-project";
const SCRIPT = `${PROJECT_ROOT}/scripts/snapshot-backup.sh`;

type CadenceResult = "ok" | "failed" | "skipped" | "diverged" | null;

let lastRunAt = 0;
let lastResult: CadenceResult = null;
let running = false;

async function appendLog(line: string): Promise<void> {
  const path = `${PROJECT_ROOT}/.zscripts/backup-cadence.log`;
  const existing = await Bun.file(path).text().catch(() => "");
  await Bun.write(path, existing + line + "\n");
}

/**
 * Run the snapshot script. Returns false (and logs honestly) when the run was
 * dropped by the in-process guards (already running / 30-min min-gap). The
 * script's own throttle, scan and divergence pre-check always apply on top.
 */
async function runBackup(trigger: string, force: boolean): Promise<boolean> {
  if (running) {
    const line = `[cadence ${new Date().toISOString()}] trigger=${trigger} dropped=run-in-progress`;
    console.log(line);
    void appendLog(line);
    return false;
  }
  const now = Date.now();
  if (now - lastRunAt < MIN_GAP_MS) {
    const line = `[cadence ${new Date().toISOString()}] trigger=${trigger} dropped=min-gap (${Math.round((MIN_GAP_MS - (now - lastRunAt)) / 1000)}s left)`;
    console.log(line);
    void appendLog(line);
    return false;
  }
  running = true;
  lastRunAt = now;
  const started = new Date().toISOString();
  try {
    // NEXUS_BACKUP_FORCE is the script's throttle bypass — set here ONLY for the
    // cadence timer (boot/interval). The token is NOT in process.env: the script
    // reads ops/vault/github.token via its askpass helper itself (P7).
    const env = force ? { ...process.env, NEXUS_BACKUP_FORCE: "1" } : process.env;
    const proc = Bun.spawn(["bash", SCRIPT], {
      cwd: PROJECT_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const timer = setTimeout(() => proc.kill(), 150_000);
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    clearTimeout(timer);
    if (exitCode === 0) lastResult = /SKIP:/.test(stdout) ? "skipped" : "ok";
    else if (exitCode === 5) lastResult = "diverged";
    else lastResult = "failed";
    const line = `[cadence ${started}] trigger=${trigger}${force ? " force=1" : ""} exit=${exitCode === null ? "killed" : exitCode} result=${lastResult}`;
    console.log(line, stderr.trim() ? `stderr=${stderr.trim().slice(-200)}` : "");
    await appendLog(line);
    return true;
  } catch (err) {
    lastResult = "failed";
    console.error(`[cadence] ${started} spawn error:`, err instanceof Error ? err.message : err);
    await appendLog(`[cadence ${started}] trigger=${trigger} spawn-error`);
    return true;
  } finally {
    running = false;
  }
}

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "backup-cadence",
        intervalMs: INTERVAL_MS,
        minGapMs: MIN_GAP_MS,
        lastResult,
        lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
        running,
      });
    }
    if (url.pathname === "/run" && req.method === "POST") {
      // Unforced on purpose: /run is a manual trigger and goes through the
      // script's 30-min throttle like the panel button. Awaited so the response
      // is honest about whether the run actually happened.
      return runBackup("http", false).then((accepted) =>
        Response.json({
          ok: true,
          accepted,
          reason: accepted ? undefined : "dropped: run in progress or 30-min min-gap",
        }),
      );
    }
    return new Response("backup-cadence: see /health", { status: 404 });
  },
});

console.log(
  `[backup-cadence] listening on :${PORT} — every ${INTERVAL_MS / 3600000}h, first run in ${FIRST_DELAY_MS / 1000}s (min-gap ${MIN_GAP_MS / 60000}m; timer runs force=1, /run unforced)`,
);

setTimeout(() => void runBackup("boot", true), FIRST_DELAY_MS);
setInterval(() => void runBackup("interval", true), INTERVAL_MS);
