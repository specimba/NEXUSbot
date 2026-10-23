import { NextResponse } from "next/server";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * Task 10-c — snapshot-durability status (read-only).
 *
 * The workspace durability system is `scripts/snapshot-backup.sh` (sanitized
 * snapshot chain → github.com/specimba/NEXUSbot, fail-closed secret scan,
 * fast-forward-only pushes). The skeleton-era device-flow watcher that used to
 * live here was replaced: GET is now a pure status read — no code minting, no
 * token polling, no side effects. Runs happen explicitly via POST /api/backup/run.
 *
 * Response shape (contract):
 *   { ok, lastResult: "ok"|"failed"|"scan-failed"|"no-token"|"never",
 *     lastAt?, head?, tokenPresent, remoteConfigured, remote, recentLog[] }
 *
 * SECURITY (P7): tokenPresent is a boolean ONLY — the token itself never leaves
 * the server. recentLog is scrubbed defensively even though the log is written
 * without secrets (token travels via the script's git askpass helper only).
 */

const BACKUP_STATE = ".zscripts/backup-state.json";
const BACKUP_LOG = ".zscripts/backup-log.txt";
const SCRIPT = "scripts/snapshot-backup.sh";
const REMOTE = "https://github.com/specimba/NEXUSbot";
const TOKEN_FILE = "ops/vault/github.token";
const LOG_TAIL_LINES = 8;

/** Defensive scrub: token-shaped strings must never reach the panel (P7). */
const SECRET_PATTERN = /gh[pousr]_|sbp_|sk-/;

type BackupStateFile = { lastResult?: string; lastAt?: string; head?: string };

async function readState(): Promise<BackupStateFile | null> {
  try {
    return JSON.parse(await readFile(path.join(process.cwd(), BACKUP_STATE), "utf8")) as BackupStateFile;
  } catch {
    return null; // missing or malformed → honest "never"
  }
}

async function pathExists(rel: string): Promise<boolean> {
  try {
    await access(path.join(process.cwd(), rel));
    return true;
  } catch {
    return false;
  }
}

async function tokenPresent(): Promise<boolean> {
  try {
    return (await readFile(path.join(process.cwd(), TOKEN_FILE), "utf8")).trim().length > 0;
  } catch {
    return false;
  }
}

function scrubLine(line: string): string {
  return SECRET_PATTERN.test(line) ? "[filtered: potential secret pattern]" : line;
}

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  // Same guard pattern as the other status routes (30 polls/min is far above
  // the card's 30s refresh cadence).
  if (!rateLimit(`backup-status:${clientKey(req)}`, 30, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many status polls — slow down." } },
      { status: 429 },
    );
  }

  try {
    const state = await readState();
    const logRaw = await readFile(path.join(process.cwd(), BACKUP_LOG), "utf8").catch(() => "");
    const lines = logRaw
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .slice(-LOG_TAIL_LINES)
      .map(scrubLine);

    return NextResponse.json({
      ok: true,
      lastResult: state?.lastResult ?? "never",
      lastAt: state?.lastAt,
      head: state?.head,
      tokenPresent: await tokenPresent(),
      remoteConfigured: await pathExists(SCRIPT),
      remote: REMOTE,
      recentLog: lines,
    });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "STATUS_READ_FAILED", message: "Could not read backup durability state from disk." },
      },
      { status: 500 },
    );
  }
}
