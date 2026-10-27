/**
 * NEXUS mem-watchdog — guards the Next.js dev server (:3000) on the 4GB no-swap box.
 *
 * WHY: the sandbox has 4GB RAM, zero swap; next-server slowly bloats (measured
 * 1744MB RSS = 43% of the box) and the kernel OOM-killer then takes the whole
 * sandbox down, or the box thrashes into "Pages Unresponsive". A reboot kills
 * every process and the boot path (ensure-dev) does not always fire, leaving
 * the panel dead with no self-healing. This watchdog:
 *   - polls the next-server tree RSS every 30s
 *   - 2 consecutive readings > 1400MB  -> kill tree + detached respawn (10-min cooldown)
 *   - server dead (:3000 refused)      -> detached respawn (same cooldown)
 * Respawn uses the canonical .zscripts/dev.sh path (bun install/db:push are
 * no-ops when warm) with the V8 old-space cap that prevents the bloat itself.
 *
 * Never edits .env, never touches the DB, never stops the server without an
 * immediate verified respawn. Logs to watchdog.log next to this file.
 *
 * 2026-10-27 hardening: turbopack corrupted-cache awareness (pre-respawn
 * purge when dev.log carries the panic signature, one bounded post-failure
 * purge+retry) and crash-evidence preservation (dev.log snapshot to
 * .zscripts/watchdog-precrash.log BEFORE any kill — respawns truncate dev.log).
 */
import { spawn } from "node:child_process";

// WHY curl, not node:http/fetch: bun's socket layer cannot reach loopback in
// this sandbox (measured — connection refused to 127.0.0.1 from bun runtime
// while curl succeeds). A bun-based probe would false-negative EVERY tick and
// murder a healthy server. curl is the ground truth here.
import fs from "node:fs";

const PROJECT = "/home/z/my-project";
const LOG = `${import.meta.dir}/watchdog.log`;
const PORT = 3000;
const RSS_LIMIT_MB = 1400;
const STRIKES_NEEDED = 2;
const POLL_MS = 30_000;
const COOLDOWN_MS = 10 * 60_000;

// Turbopack persistent-cache corruption class (measured 2026-10-27 crash):
// a sandbox reap mid-write leaves .next/dev missing SST files; EVERY `next dev`
// boot then dies FATAL "Failed to restore task data" in a retry loop. A blind
// respawn can NEVER recover — only purging .next does. The signature is read
// from dev.log BEFORE the respawn truncates it, and the purge is bounded to
// one attempt per respawn action (no purge loops).
const DEV_LOG = `${PROJECT}/dev.log`;
const PRE_CRASH_LOG = `${PROJECT}/.zscripts/watchdog-precrash.log`;
const TURBO_PANIC = "Failed to restore task data";

function devLogHasTurboPanic(): boolean {
  try {
    return fs.readFileSync(DEV_LOG, "utf8").includes(TURBO_PANIC);
  } catch {
    return false; // dev.log unreadable/absent — no signature, no purge
  }
}

function preserveCrashLog() {
  // dev.log is truncated by every respawn (the dev script pipes through
  // `tee dev.log`), so the ONLY window to keep post-mortem evidence is BEFORE
  // the kill. Best-effort: a failed copy must never block the respawn.
  try {
    if (fs.existsSync(DEV_LOG)) fs.copyFileSync(DEV_LOG, PRE_CRASH_LOG);
  } catch {
    /* evidence is best-effort; recovery comes first */
  }
}

function purgeNextCache(reason: string): boolean {
  try {
    fs.rmSync(`${PROJECT}/.next`, { recursive: true, force: true });
    log(`${reason}: .next purged (corrupted turbopack persistent cache)`);
    return true;
  } catch (err) {
    log(`${reason}: .next purge FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function waitForPort(totalMs: number): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await portUp()) return true;
  }
  return false;
}

let strikes = 0;
let lastActionAt = 0;

function log(line: string) {
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG, `[${ts}] ${line}\n`);
}

function getRssMb(): number | null {
  // Sum RSS across the next-server process tree (bun run dev -> next dev -> next-server).
  let totalKb = 0;
  let found = false;
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let cmd = "";
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue; // process vanished
    }
    if (!cmd.includes("next dev") && !cmd.includes("next-server") && !cmd.includes(".zscripts/dev.sh"))
      continue;
    let status = "";
    try {
      status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    } catch {
      continue;
    }
    const m = status.match(/VmRSS:\s+(\d+) kB/);
    if (m) {
      totalKb += parseInt(m[1]!, 10);
      found = true;
    }
  }
  return found ? Math.round(totalKb / 1024) : null;
}

function portUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("curl", ["-s", "-o", "/dev/null", "--max-time", "4", `http://127.0.0.1:${PORT}/`]);
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function serverDead(): Promise<boolean> {
  // Double-check grace: one failed probe re-probes after 10s before we declare
  // death — protects against a boot race where the watchdog out-runs the panel.
  if (!(await portUp())) {
    await new Promise((r) => setTimeout(r, 10_000));
    if (!(await portUp())) return true;
  }
  return false;
}

function killTree() {
  // Kill every process whose cmdline belongs to the dev-server stack.
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let cmd = "";
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue;
    }
    if (cmd.includes("next dev") || cmd.includes("next-server") || cmd.includes(".zscripts/dev.sh")) {
      try {
        process.kill(parseInt(pid, 10), "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

async function respawn(reason: string) {
  const now = Date.now();
  if (now - lastActionAt < COOLDOWN_MS) {
    log(`${reason}: cooldown active, skipping respawn`);
    return;
  }
  lastActionAt = now;
  // FINAL liveness gate: an external actor (harness, human, another restart)
  // may have brought the server back during the grace window — never kill a
  // server that answers at this instant.
  if (await portUp()) {
    log(`${reason}: server came back during grace window, kill aborted`);
    return;
  }
  log(`${reason}: killing tree and respawning dev server`);
  preserveCrashLog();
  // Pre-heal: if the death certificate already carries the corrupted-cache
  // panic, a plain respawn would panic-loop (measured 2026-10-27) — purge first.
  let purged = false;
  if (devLogHasTurboPanic()) {
    purged = purgeNextCache("pre-respawn heal");
  }
  killTree();
  await new Promise((r) => setTimeout(r, 2000));
  // Respawn ONLY the panel via the canonical package.json dev script (next dev,
  // tee -> dev.log) — NOT dev.sh: dev.sh would also start mini-services and
  // fork a second watchdog instance.
  const spawnDev = () => {
    const child = spawn(
      "bash",
      ["-lc", `cd ${PROJECT} && NODE_OPTIONS=--max-old-space-size=1024 setsid nohup bun run dev >> ${PROJECT}/.zscripts/watchdog-respawn.log 2>&1 < /dev/null &`],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
  };
  spawnDev();
  // Wait up to 120s for :3000 and log the outcome.
  if (await waitForPort(120_000)) {
    log(`RESTART ok in ~${purged ? "(post-purge) " : ""}≤120s`);
    return;
  }
  // Post-failure heal: the fresh boot itself died with the panic signature
  // (corruption discovered only at restore time) — one bounded purge + retry.
  if (!purged && devLogHasTurboPanic()) {
    if (purgeNextCache("post-failure heal (boot panicked again)")) {
      purged = true;
      spawnDev();
      if (await waitForPort(120_000)) {
        log("RESTART ok after turbo-cache purge + second respawn");
        return;
      }
    }
  }
  log("RESTART FAILED: :3000 still down after 120s (post-purge state — next tick retries)");
}

async function tick() {
  const dead = await serverDead();
  if (dead) {
    strikes = 0;
    await respawn("server dead (:3000 refused, double-checked)");
    return;
  }
  const rss = getRssMb();
  if (rss === null) {
    strikes = 0;
    return; // serving process not found this pass; port is up, leave it alone
  }
  if (rss > RSS_LIMIT_MB) {
    strikes++;
    log(`RSS ${rss}MB > ${RSS_LIMIT_MB}MB (strike ${strikes}/${STRIKES_NEEDED})`);
    if (strikes >= STRIKES_NEEDED) {
      strikes = 0;
      await respawn(`RSS ${rss}MB sustained`);
    }
  } else {
    if (strikes > 0) log(`RSS ${rss}MB back under limit, strikes reset`);
    strikes = 0;
  }
}

log(`mem-watchdog started (limit ${RSS_LIMIT_MB}MB x${STRIKES_NEEDED}, poll ${POLL_MS / 1000}s, cooldown ${COOLDOWN_MS / 60000}min)`);
setInterval(tick, POLL_MS);
tick();
