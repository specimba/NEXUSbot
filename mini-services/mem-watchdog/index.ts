/**
 * mem-watchdog — panel OOM guard (v31.3).
 *
 * Symptom (owner report, 2026-10-27): the panel "freezes constantly" with
 * Pages-Unresponsive / OOM dialogs. Root cause measured on the sandbox:
 * next-server (Next 16 dev) RSS balloons to ~1.75 GB of the 4 GB total
 * (ZERO swap) after a few hours of dev-mode module graphs + HMR + live chat
 * traffic — the sandbox then thrashes and every page load stalls.
 *
 * Fix strategy: watch the RSS of the next-server process every 30s. Two
 * consecutive readings above THRESHOLD_MB → graceful restart of the dev
 * server (kill tree, respawn `bun run dev`, wait for :3000 to answer).
 * 10-minute cooldown prevents restart storms. All state is honest and
 * logged to watchdog.log next to this file.
 *
 * Restart cost is ~15-20s of panel downtime; that beats a frozen sandbox.
 * Sessions/cookies survive (vault + DB on disk); dev.log keeps its history.
 */

import { appendFileSync, readFileSync, statSync, truncateSync } from "node:fs";
import { spawn } from "node:child_process";

const THRESHOLD_MB = 1400; // restart zone (measured freeze ≈ 1.7-1.9 GB on 4 GB)
const CHECK_INTERVAL_MS = 30_000;
const CONSECUTIVE_REQUIRED = 2;
const COOLDOWN_MS = 10 * 60_000;
const PORT = 3000;
const PROJECT = "/home/z/my-project";
const LOG = `${import.meta.dir}/watchdog.log`;

let overCount = 0;
let lastRestartAt = 0;
let restarting = false;

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    appendFileSync(LOG, `${line}\n`);
    // Keep the log bounded (512 KB) — honest, not hoarding.
    if (statSync(LOG).size > 512 * 1024) truncateSync(LOG, 256 * 1024);
  } catch {
    /* logging must never crash the watchdog */
  }
  console.log(line);
}

/** RSS (MB) of the next-server process for our project, or 0 when absent.
 * Takes the LARGEST RSS among matched pids: the tree is the `next dev` CLI
 * wrapper (Name: node) + the actual next-server worker — the worker is the
 * one that balloons. */
function nextServerRssMb(): { mb: number; pid: number } {
  try {
    const out = Bun.spawnSync(["pgrep", "-f", "next-server|next dev -p 3000"], { cwd: PROJECT });
    const pids = out.stdout.toString().split("\n").filter(Boolean);
    let best = { mb: 0, pid: 0 };
    for (const pid of pids) {
      try {
        const status = readFileSync(`/proc/${pid.trim()}/status`, "utf8");
        const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
        if (!m) continue;
        const mb = Math.round(Number(m[1]) / 1024);
        if (mb > best.mb) best = { mb, pid: Number(pid.trim()) };
      } catch {
        /* proc entry vanished — next pid */
      }
    }
    return best;
  } catch {
    /* pgrep missing/failure — treated as "no process" */
  }
  return { mb: 0, pid: 0 };
}

function healthOk(): boolean {
  try {
    const res = Bun.spawnSync(
      ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${PORT}/`],
      { timeout: 10_000 },
    );
    return res.stdout.toString().trim().startsWith("2");
  } catch {
    return false;
  }
}

async function restartDevServer(): Promise<void> {
  if (restarting) return;
  restarting = true;
  const startedAt = Date.now();
  log(`RESTART begin (RSS over threshold)`);
  try {
    // Kill the whole next dev tree (server + postcss workers).
    Bun.spawnSync(["pkill", "-f", "next-server"]);
    Bun.spawnSync(["pkill", "-f", "next dev -p 3000"]);
    await Bun.sleep(2500);

    // Detached respawn through bash so the tree survives this process; the
    // output appends to the same dev.log the panel already uses.
    const sh = spawn(
      "bash",
      ["-lc", `cd "${PROJECT}" && nohup bun run dev >> dev.log 2>&1 &`],
      { detached: true, stdio: "ignore" },
    );
    sh.unref();
    log(`dev server respawn requested — waiting for :${PORT}`);

    for (let i = 0; i < 45; i++) {
      await Bun.sleep(2000);
      if (healthOk()) {
        log(`RESTART ok in ${Math.round((Date.now() - startedAt) / 1000)}s — :${PORT} answering`);
        return;
      }
    }
    log(`RESTART TIMEOUT — :${PORT} still not answering after 90s (will keep probing)`);
  } catch (e) {
    log(`RESTART error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    lastRestartAt = Date.now();
    restarting = false;
  }
}

async function tick(): Promise<void> {
  if (restarting) return;
  const { mb, pid } = nextServerRssMb();

  if (mb === 0) {
    // No server process at all: only intervene if the port is also dead.
    if (!healthOk()) {
      log(`next-server ABSENT and :${PORT} dead — respawning`);
      overCount = 0;
      await restartDevServer();
    }
    return;
  }

  if (mb > THRESHOLD_MB) {
    overCount += 1;
    log(`RSS ${mb} MB (pid ${pid}) — over ${THRESHOLD_MB} MB (${overCount}/${CONSECUTIVE_REQUIRED})`);
    if (overCount >= CONSECUTIVE_REQUIRED && Date.now() - lastRestartAt > COOLDOWN_MS) {
      overCount = 0;
      await restartDevServer();
    }
  } else {
    if (overCount > 0) log(`RSS back to ${mb} MB — counter reset`);
    overCount = 0;
  }
}

log(`mem-watchdog up — threshold ${THRESHOLD_MB} MB, interval ${CHECK_INTERVAL_MS / 1000}s`);
void tick();
setInterval(() => void tick(), CHECK_INTERVAL_MS);
