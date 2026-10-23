import { NextResponse } from "next/server";
import {
  readFile,
  writeFile,
  rm,
  mkdir,
} from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const dynamic = "force-dynamic";

/**
 * Durability status + GitHub device-flow bootstrap — serverless edition.
 *
 * The sandbox harness reaps user background processes between agent tool calls,
 * so there is no long-running watcher. Instead this route IS the watcher:
 *  - the panel tile polls it every 30s (and the agent polls it every turn);
 *  - when no valid pending flow exists, it mints a fresh device code;
 *  - each call performs at most one token poll (interval-respecting);
 *  - on authorization it stores the token chmod 600 and runs the sanitized
 *    snapshot backup immediately.
 *
 * SECURITY (P7): device_code and the token NEVER leave the server. Only the
 * short-lived user_code is returned, which is the standard device-flow UX.
 */

const CLIENT_ID = "Ov23lixdmqSCLN7KZckL"; // OAuth App "NEXUSosBOTv1" (public info)
const SCOPES = "public_repo read:user";
const STATE_DIR = ".zscripts";
const FLOW_FILE = ".zscripts/backup-flow.json";
const BACKUP_STATE = ".zscripts/backup-state.json";
const TOKEN_FILE = "ops/vault/github.token";
const REMOTE = "https://github.com/specimba/NEXUSbot";
const POLL_MIN_GAP_MS = 6_000;

interface FlowFile {
  userCode: string;
  deviceCode: string;
  verificationUri: string;
  expiresAt: string;
  lastPolledAt: number;
}
interface BackupState {
  lastResult: "ok" | "failed" | "scan-failed" | "no-token";
  lastAt: string;
  head?: string;
}

async function readJson<T>(rel: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path.join(process.cwd(), rel), "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeFlow(f: FlowFile | null): Promise<void> {
  if (!f) {
    await rm(path.join(process.cwd(), FLOW_FILE), { force: true });
    return;
  }
  await mkdir(path.join(process.cwd(), STATE_DIR), { recursive: true });
  await writeFile(path.join(process.cwd(), FLOW_FILE), JSON.stringify(f), { mode: 0o600 });
}

async function mintFlow(): Promise<FlowFile> {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPES }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`device/code → HTTP ${res.status}`);
  const j = (await res.json()) as {
    user_code: string;
    device_code: string;
    verification_uri: string;
    expires_in: number;
  };
  return {
    userCode: j.user_code,
    deviceCode: j.device_code,
    verificationUri: j.verification_uri,
    expiresAt: new Date(Date.now() + j.expires_in * 1000).toISOString(),
    lastPolledAt: 0,
  };
}

async function tokenPresent(): Promise<boolean> {
  try {
    return (await readFile(path.join(process.cwd(), TOKEN_FILE), "utf8")).trim().length > 0;
  } catch {
    return false;
  }
}

export async function GET() {
  const now = Date.now();
  let flow = await readJson<FlowFile>(FLOW_FILE);
  if (flow && (!flow.deviceCode || !flow.expiresAt)) flow = null; // legacy schema
  const haveToken = await tokenPresent();
  let note: string | undefined;

  if (!haveToken) {
    // Mint a fresh flow when none is pending/valid
    if (!flow || new Date(flow.expiresAt).getTime() < now) {
      try {
        flow = await mintFlow();
        await writeFlow(flow);
      } catch (e) {
        note = `github unreachable: ${(e as Error).message}`;
      }
    }

    // At most one token poll per call, respecting the interval
    if (flow && now - flow.lastPolledAt > POLL_MIN_GAP_MS) {
      try {
        const res = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: CLIENT_ID,
            device_code: flow.deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
          signal: AbortSignal.timeout(15_000),
        });
        const j = (await res.json()) as {
          access_token?: string;
          error?: string;
        };
        if (j.access_token) {
          await mkdir(path.join(process.cwd(), "ops/vault"), { recursive: true });
          await writeFile(
            path.join(process.cwd(), TOKEN_FILE),
            j.access_token + "\n",
            { mode: 0o600 },
          );
          await writeFlow(null);
          flow = null;
          // run the sanitized snapshot backup right away
          const r = spawnSync("bash", ["scripts/snapshot-backup.sh"], {
            cwd: process.cwd(),
            timeout: 120_000,
          });
          const backupState: BackupState = {
            lastResult:
              r.status === 0 ? "ok" : r.status === 3 ? "no-token" : "failed",
            lastAt: new Date().toISOString(),
          };
          await writeFile(
            path.join(process.cwd(), BACKUP_STATE),
            JSON.stringify(backupState),
          );
          note = "authorized — backup run started";
        } else if (j.error === "authorization_pending" || j.error === "slow_down") {
          flow.lastPolledAt = now;
          await writeFlow(flow);
        } else if (j.error === "expired_token") {
          flow = await mintFlow();
          await writeFlow(flow);
        } else if (j.error === "device_flow_disabled") {
          await writeFlow(null);
          flow = null;
          note = "device_flow_disabled — enable Device Flow on OAuth app NEXUSosBOTv1";
        } else {
          flow.lastPolledAt = now;
          await writeFlow(flow);
          if (j.error) note = `poll: ${j.error}`;
        }
      } catch (e) {
        note = `poll failed: ${(e as Error).message}`;
      }
    }
  } else if (flow) {
    await writeFlow(null);
    flow = null;
  }

  const backup = await readJson<BackupState>(BACKUP_STATE);
  const state = haveToken
    ? backup?.lastResult === "ok"
      ? "backup-ok"
      : "authorized"
    : flow
      ? "pending"
      : note
        ? "error"
        : "pending";

  return NextResponse.json({
    ok: true,
    serverTime: new Date().toISOString(),
    state,
    userCode: flow?.userCode,
    verificationUri: flow?.verificationUri ?? "https://github.com/login/device",
    expiresAt: flow?.expiresAt,
    note,
    backup,
    tokenPresent: haveToken,
    remote: REMOTE,
  });
}
