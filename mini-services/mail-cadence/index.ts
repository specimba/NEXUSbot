/**
 * NEXUS OS — mail-cadence mini service (port 3013).
 *
 * Periodically runs scripts/mail-cadence.ts so the AgentMail lanes do not
 * depend on the panel being open:
 *   - mail→bot command poll (pull-based, triple-gated) — every cycle
 *   - daily digest to the owner — first cycle inside the 05:00–12:00 Istanbul
 *     window; dedupe lives in the script (Setting agentmail.digest.lastDate)
 *
 * Cadence: every 30 minutes, first run 45 s after boot. A 10-minute in-process
 * guard prevents overlapping spawns. The script itself is idempotent (no new
 * mail → no-op poll; digest deduped by date). State/log:
 * .zscripts/mail-cadence.log (append-only, no secrets — P7; the *.log glob
 * keeps it out of every snapshot).
 */

const PORT = 3013;
const INTERVAL_MS = 30 * 60 * 1000;
const FIRST_DELAY_MS = 45 * 1000;
const MIN_GAP_MS = 10 * 60 * 1000;

const PROJECT_ROOT = "/home/z/my-project";
const SCRIPT = `${PROJECT_ROOT}/scripts/mail-cadence.ts`;

type CadenceResult = "ok" | "failed" | null;

let lastRunAt = 0;
let lastResult: CadenceResult = null;
let running = false;

async function appendLog(line: string): Promise<void> {
  const path = `${PROJECT_ROOT}/.zscripts/mail-cadence.log`;
  const existing = await Bun.file(path).text().catch(() => "");
  await Bun.write(path, existing + line + "\n");
}

async function runCadence(trigger: string): Promise<boolean> {
  if (running) {
    const line = `[mail-cadence ${new Date().toISOString()}] trigger=${trigger} dropped=run-in-progress`;
    console.log(line);
    void appendLog(line);
    return false;
  }
  const now = Date.now();
  if (now - lastRunAt < MIN_GAP_MS) {
    const line = `[mail-cadence ${new Date().toISOString()}] trigger=${trigger} dropped=min-gap (${Math.round((MIN_GAP_MS - (now - lastRunAt)) / 1000)}s left)`;
    console.log(line);
    void appendLog(line);
    return false;
  }
  running = true;
  lastRunAt = now;
  const started = new Date().toISOString();
  try {
    const proc = Bun.spawn(["bun", "run", SCRIPT], {
      cwd: PROJECT_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const timer = setTimeout(() => proc.kill(), 120_000);
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    clearTimeout(timer);
    lastResult = exitCode === 0 ? "ok" : "failed";
    const line = `[mail-cadence ${started}] trigger=${trigger} exit=${exitCode === null ? "killed" : exitCode} result=${lastResult}`;
    console.log(line);
    // Script stdout is the honest outcome record (COMMANDS OK/DIGEST OK/SKIP lines).
    if (stdout.trim()) console.log(stdout.trim().split("\n").map((l) => `  ${l}`).join("\n"));
    if (stderr.trim()) console.error(`  stderr=${stderr.trim().slice(-300)}`);
    await appendLog(line + (stdout.trim() ? `\n${stdout.trim().split("\n").map((l) => `  ${l}`).join("\n")}` : ""));
    return true;
  } catch (err) {
    lastResult = "failed";
    console.error(`[mail-cadence] ${started} spawn error:`, err instanceof Error ? err.message : err);
    await appendLog(`[mail-cadence ${started}] trigger=${trigger} spawn-error`);
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
        service: "mail-cadence",
        intervalMs: INTERVAL_MS,
        minGapMs: MIN_GAP_MS,
        lastResult,
        lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
        running,
      });
    }
    if (url.pathname === "/run" && req.method === "POST") {
      // Manual trigger — same idempotent script, honest acceptance answer.
      return runCadence("http").then((accepted) =>
        Response.json({
          ok: true,
          accepted,
          reason: accepted ? undefined : "dropped: run in progress or 10-min min-gap",
        }),
      );
    }
    return new Response("mail-cadence: see /health", { status: 404 });
  },
});

console.log(
  `[mail-cadence] listening on :${PORT} — every ${INTERVAL_MS / 60000}min, first run in ${FIRST_DELAY_MS / 1000}s (min-gap ${MIN_GAP_MS / 60000}m; script idempotent: command poll cursor + digest date dedupe live in the script)`,
);

setTimeout(() => void runCadence("boot"), FIRST_DELAY_MS);
setInterval(() => void runCadence("interval"), INTERVAL_MS);
