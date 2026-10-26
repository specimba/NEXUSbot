import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const execFileAsync = promisify(execFile);

/**
 * Task 10-c — run the sanitized snapshot backup on explicit owner request.
 *
 * Executes `bash scripts/snapshot-backup.sh` (cwd = project root) and returns
 * the fresh .zscripts/backup-state.json contents plus an honest exit-code
 * mapping: 0 ok (pushed, content-unchanged SKIP, or throttle SKIP) /
 * 1 scan-failed / 3 no-token / 4 push-failed / 5 diverged. A script-level
 * outcome is reported with ok:true + lastResult (the run DID execute); §11
 * {ok:false,error:{code,message}} is reserved for API-level failures (auth,
 * rate limit, timeout, spawn failure).
 *
 * 12-d hardening: the script self-throttles (30-min min-gap after the last
 * SUCCESSFUL push) and this route deliberately sets NO NEXUS_BACKUP_FORCE —
 * the panel button goes through the throttle honestly (throttled runs come
 * back as exit 0 + skipped with a throttled message; only the cadence
 * service's 6h timer may bypass). The script now also pre-checks remote
 * divergence and refuses to push (exit 5) when remote main is not an
 * ancestor-or-equal of the local chain head — no force push, ever (§8).
 *
 * G1 (2026-10-25): two honesty upgrades mirrored from snapshot-backup.sh.
 * (1) A content-unchanged skip over a non-ok lastResult now probes the stored
 * credential with `git push --dry-run` and clears the stale auth failure, so
 * the panel no longer reads "still 401" after a successful reconnect.
 * (2) Exit 4 carries TWO distinct GitHub rejections (dead token vs token
 * without push scope) — the toast message is derived from the script output
 * instead of the old blanket non-fast-forward line.
 *
 * SECURITY (P7): the GitHub token is read by the script itself from
 * ops/vault/github.token via its git askpass helper — it is never placed in
 * argv, in env, or in any response. stdout/stderr tails are scrubbed
 * defensively before leaving the server.
 */

const BACKUP_STATE = ".zscripts/backup-state.json";
const SECRET_PATTERN = /gh[pousr]_|sbp_|sk-/;
const TIMEOUT_MS = 120_000;

// G1: the two DISTINCT push rejections (mirrors snapshot-backup.sh's grep).
const AUTH_REJECTED = /invalid username or token|authentication failed|rejected the stored token/i;
const SCOPE_MISSING = /token lacks repo scope|write access to repository not granted|resource not accessible/i;

function pushFailureMessage(output: string): string {
  if (SCOPE_MISSING.test(output)) {
    return "Push failed — the connected GitHub token lacks repo scope. Reconnect GitHub in Connectors (the fresh OAuth grant must include repo/public_repo), then run again.";
  }
  if (AUTH_REJECTED.test(output)) {
    return "Push failed — GitHub rejected the stored token (expired/revoked). Reconnect GitHub in Connectors, then run again; the snapshot chain itself is healthy.";
  }
  return "Push failed (non-fast-forward). No force push per directive — resolve the remote manually.";
}

type BackupStateFile = {
  lastResult?: string;
  lastAt?: string;
  head?: string;
  tag?: string;
  lastAttemptAt?: string;
};
type ExecError = Error & {
  code?: number | string | null;
  killed?: boolean;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
};

function scrubbedTail(text: string, lines = 8): string[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(-lines)
    .map((l) => (SECRET_PATTERN.test(l) ? "[filtered: potential secret pattern]" : l));
}

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  // Owner-approved cadence: at most one backup run per minute per client.
  if (!rateLimit(`backup-run:${clientKey(req)}`, 1, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Backup can run at most once per minute." } },
      { status: 429 },
    );
  }

  let exitCode = 0;
  let output = "";
  try {
    const r = await execFileAsync("bash", ["scripts/snapshot-backup.sh"], {
      cwd: process.cwd(), // project root (/home/z/my-project) — the script resolves its own paths from here
      timeout: TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      // env is inherited unchanged: the token is NOT in process.env — the
      // script reads ops/vault/github.token via its askpass helper internally.
    });
    output = `${r.stdout ?? ""}${r.stderr ? `\n${r.stderr}` : ""}`;
  } catch (e) {
    const ce = e as ExecError;
    if (ce.killed || ce.signal) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "SCRIPT_TIMEOUT",
            message: `snapshot-backup.sh exceeded the ${TIMEOUT_MS / 1000}s timeout and was stopped.`,
          },
        },
        { status: 500 },
      );
    }
    if (typeof ce.code === "number") {
      // Script ran and exited non-zero — an honest script outcome, not an API failure.
      exitCode = ce.code;
      output = `${ce.stdout ?? ""}${ce.stderr ? `\n${ce.stderr}` : ""}`;
    } else {
      return NextResponse.json(
        { ok: false, error: { code: "RUN_FAILED", message: "Could not start snapshot-backup.sh." } },
        { status: 500 },
      );
    }
  }

  const state = await readFile(path.join(process.cwd(), BACKUP_STATE), "utf8")
    .then((s) => JSON.parse(s) as BackupStateFile)
    .catch(() => null);

  const okRun = exitCode === 0;
  const skipped = okRun && /SKIP:/.test(output);
  const throttled = skipped && /throttled/.test(output);

  // Exit-code mapping (honest messages; the state file is trusted only for a
  // clean run — on failure it may still hold the previous successful push).
  const EXIT_RESULTS: Record<number, BackupStateFile["lastResult"]> = {
    1: "scan-failed",
    3: "no-token",
    4: "failed",
    5: "diverged",
  };
  const EXIT_MESSAGES: Record<number, string> = {
    0: "Snapshot pushed to specimba/NEXUSbot (fast-forward on main).",
    1: "Secret scan found hits — push aborted fail-closed. Resolve the flagged content, then run again.",
    3: "No GitHub token at ops/vault/github.token — complete the one-time GitHub device flow first.",
    // 4 is message-derived per-rejection (pushFailureMessage) — see below.
    5: "Remote main has diverged from the local snapshot chain — push refused (fast-forward-only; no force push per directive). Resolve the remote manually, then run again.",
  };

  return NextResponse.json({
    ok: true,
    lastResult: okRun ? (state?.lastResult ?? "ok") : (EXIT_RESULTS[exitCode] ?? "failed"),
    lastAt: okRun ? state?.lastAt : undefined,
    head: okRun ? state?.head : undefined,
    tag: okRun ? state?.tag : undefined,
    lastAttemptAt: state?.lastAttemptAt,
    skipped,
    exitCode,
    message: throttled
      ? "Push throttle active — the last successful push was less than 30 minutes ago, so this run was skipped honestly (no bypass from the panel). The 6h cadence timer pushes automatically; try again later."
      : skipped
        ? "Snapshot content unchanged since the last push — nothing new to push (skip)."
        : exitCode === 4
          ? pushFailureMessage(output)
          : (EXIT_MESSAGES[exitCode] ?? `snapshot-backup.sh exited with code ${exitCode}.`),
    output: scrubbedTail(output),
  });
}
