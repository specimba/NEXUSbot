/**
 * NEXUS service spawner — launches the panel + the three mini-services as
 * DETACHED orphans so the harness's between-tool-call reaper cannot collect
 * them.
 *
 * WHY this exists: `setsid nohup bun run dev &` from an agent tool-call shell
 * dies within one tool-call boundary (measured twice, 2026-10-27: bridge,
 * backup-cadence and mem-watchdog all logged healthy startup then vanished
 * silently, while the panel spawned via bun spawn detached:true survived the
 * same window). Children re-parented to init from an already-dead spawner are
 * outside the reaper's sweep. So: spawn detached + unref + exit immediately.
 *
 * DEDUPE (2026-10-27 lesson: `pkill -f mem-watchdog` never matches the real
 * cmdline "bun index.ts" — name-based matching is unreliable): before each
 * spawn, scan /proc for a LIVE process whose cwd == the service dir and whose
 * cmdline contains the hint. If found, skip — the spawner is idempotent.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";

const SERVICES: Array<{ dir: string; cmd: string; log: string; hint: string; label: string }> = [
  {
    label: "panel",
    dir: "/home/z/my-project",
    // stdout+stderr go to /dev/null because the dev script itself pipes
    // through `tee dev.log` — the tee owns /home/z/my-project/dev.log.
    cmd: "exec env NODE_OPTIONS=--max-old-space-size=1024 bun run dev >> /dev/null 2>&1 < /dev/null",
    log: "",
    hint: "next",
  },
  {
    label: "kick-bridge",
    dir: "/home/z/my-project/mini-services/kick-bridge",
    cmd: "exec bun run dev >> /home/z/my-project/.zscripts/mini-service-kick-bridge.log 2>&1 < /dev/null",
    log: "/home/z/my-project/.zscripts/mini-service-kick-bridge.log",
    hint: "bun",
  },
  {
    label: "backup-cadence",
    dir: "/home/z/my-project/mini-services/backup-cadence",
    cmd: "exec bun run dev >> /home/z/my-project/.zscripts/mini-service-backup-cadence.log 2>&1 < /dev/null",
    log: "/home/z/my-project/.zscripts/mini-service-backup-cadence.log",
    hint: "bun",
  },
  {
    // 2026-10-29: bench-cadence (:3012, staleness checks) was missing from the
    // spawner — it ran via dev.sh boots only, so agent-side repairs skipped it.
    label: "bench-cadence",
    dir: "/home/z/my-project/mini-services/bench-cadence",
    cmd: "exec bun run dev >> /home/z/my-project/.zscripts/mini-service-bench-cadence.log 2>&1 < /dev/null",
    log: "/home/z/my-project/.zscripts/mini-service-bench-cadence.log",
    hint: "bun",
  },
  {
    label: "mem-watchdog",
    dir: "/home/z/my-project/mini-services/mem-watchdog",
    cmd: "exec bun index.ts >> /home/z/my-project/mini-services/mem-watchdog/watchdog.log 2>&1 < /dev/null",
    log: "/home/z/my-project/mini-services/mem-watchdog/watchdog.log",
    hint: "bun",
  },
  {
    // 2026-10-30 v37.3: mail-cadence (:3013) — AgentMail command-lane poll +
    // daily digest; runs scripts/mail-cadence.ts every 30 min.
    label: "mail-cadence",
    dir: "/home/z/my-project/mini-services/mail-cadence",
    cmd: "exec bun run dev >> /home/z/my-project/.zscripts/mini-service-mail-cadence.log 2>&1 < /dev/null",
    log: "/home/z/my-project/.zscripts/mini-service-mail-cadence.log",
    hint: "bun",
  },
];

/** Live process with cwd === dir and cmdHint in its cmdline, or null. */
function findRunningPid(dir: string, cmdHint: string): number | null {
  try {
    for (const ent of readdirSync("/proc")) {
      if (!/^\d+$/.test(ent)) continue;
      const pid = Number(ent);
      if (pid === process.pid) continue;
      try {
        if (readlinkSync(`/proc/${ent}/cwd`) !== dir) continue;
        const cmd = readFileSync(`/proc/${ent}/cmdline`, "utf8").replace(/\0/g, " ");
        if (cmd.includes(cmdHint)) return pid;
      } catch {
        // raced exit or unreadable — try next
      }
    }
  } catch {
    // /proc unavailable — fall through and spawn (old behavior)
  }
  return null;
}

for (const s of SERVICES) {
  const alive = findRunningPid(s.dir, s.hint);
  if (alive !== null) {
    console.log(`skipped ${s.label} — already running (pid ${alive})`);
    continue;
  }
  const child = spawn("bash", ["-lc", `cd ${s.dir} && ${s.cmd}`], {
    cwd: s.dir,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  console.log(`spawned ${s.label} (pid ${child.pid})`);
}
console.log("spawner exiting — children re-parented to init");
