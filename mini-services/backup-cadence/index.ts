/**
 * NEXUS OS — backup-cadence mini service (port 3011).
 *
 * Periodically runs scripts/snapshot-backup.sh so workspace durability does not
 * depend on anyone remembering to click the panel button. The script itself is
 * idempotent (content-unchanged → SKIP), fail-closed (secret scan aborts the
 * push), and fast-forward-only (never force-pushes, §8).
 *
 * Cadence: every 6 hours, first run 90 s after boot. A 30-minute minimum gap is
 * enforced between runs as an extra guard against overlapping invocations.
 * State: .zscripts/backup-cadence.log (append-only; the backup log never
 * contains secrets, P7).
 */

const PORT = 3011;
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_DELAY_MS = 90 * 1000;
const MIN_GAP_MS = 30 * 60 * 1000;

const PROJECT_ROOT = "/home/z/my-project";
const SCRIPT = `${PROJECT_ROOT}/scripts/snapshot-backup.sh`;

let lastRunAt = 0;
let lastResult: "ok" | "failed" | "skipped" | null = null;
let running = false;

async function appendLog(line: string): Promise<void> {
  const path = `${PROJECT_ROOT}/.zscripts/backup-cadence.log`;
  const existing = await Bun.file(path).text().catch(() => "");
  await Bun.write(path, existing + line + "\n");
}

async function runBackup(trigger: string): Promise<void> {
  if (running) return;
  const now = Date.now();
  if (now - lastRunAt < MIN_GAP_MS) return;
  running = true;
  lastRunAt = now;
  const started = new Date().toISOString();
  try {
    const proc = Bun.spawn(["bash", SCRIPT], {
      cwd: PROJECT_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 150_000);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    if (exitCode === 0) lastResult = "ok";
    else lastResult = "failed";
    const line = `[cadence ${started}] trigger=${trigger} exit=${exitCode} result=${lastResult}`;
    console.log(line);
    await appendLog(line);
  } catch (err) {
    lastResult = "failed";
    console.error(`[cadence] ${started} spawn error:`, err instanceof Error ? err.message : err);
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
        lastResult,
        lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
        running,
      });
    }
    if (url.pathname === "/run" && req.method === "POST") {
      void runBackup("http");
      return Response.json({ ok: true, accepted: true });
    }
    return new Response("backup-cadence: see /health", { status: 404 });
  },
});

console.log(
  `[backup-cadence] listening on :${PORT} — every ${INTERVAL_MS / 3600000}h, first run in ${FIRST_DELAY_MS / 1000}s`,
);

setTimeout(() => void runBackup("boot"), FIRST_DELAY_MS);
setInterval(() => void runBackup("interval"), INTERVAL_MS);
