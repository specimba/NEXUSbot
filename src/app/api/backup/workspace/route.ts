import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, cp, access } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const execFileAsync = promisify(execFile);

/**
 * GET /api/backup/workspace — the owner's working "Download workspace" (v29.13,
 * hardened v29.15).
 *
 * The sandbox platform's own workspace archive kept failing ("Failed to
 * archive workspace files" — it tries to zip everything incl. node_modules /
 * .git / upload archives, ~2.5 GB / 65k files). This route builds a CLEAN,
 * source-only export zip the owner can actually download:
 *
 *   src/ prisma/ scripts/ docs/ edge/ mini-services/ ops/ public/ + config
 *   files + RECOVERY.txt (panel password + quick-start) — NEVER .env, NEVER
 *   the db, NEVER vault files.
 *
 * v29.15 — TWO delivery channels because the embedded preview iframe can
 * silently block programmatic blob downloads (sandboxed frames without
 * allow-downloads eat <a download>.click() with no error and no toast):
 *
 *   1. Session  — plain GET with the panel cookie/Bearer (panel button flow).
 *   2. One-time URL token — POST here (session-gated) mints a single-use
 *      token; GET ?dl=<token> then serves the SAME zip to ANY browser tab
 *      with no cookie at all. The token is hashed at rest, expires in 5
 *      minutes, burns on first successful use, and only ever unlocks this
 *      one zip endpoint. Copy-paste-proof: the owner can always get the file
 *      by pasting the link into a fresh tab, even from a locked-down iframe.
 */
const INCLUDE_DIRS = ["src", "prisma", "scripts", "docs", "edge", "mini-services", "ops", "public", ".zscripts"];
const INCLUDE_FILES = [
  "package.json",
  "tsconfig.json",
  "next.config.ts",
  "postcss.config.mjs",
  "components.json",
  "Caddyfile",
  "eslint.config.mjs",
  "bun.lock",
];

const DOWNLOAD_TOKEN_TTL_MS = 5 * 60 * 1000;

/** sha256(token) → expiry. Module-scope: survives across requests, dies with
 * the process (which is fine — tokens are 5-minute single-use throwaways). */
const downloadTokens = new Map<string, number>();

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function pruneDownloadTokens(): void {
  const now = Date.now();
  for (const [hash, exp] of downloadTokens) {
    if (exp < now) downloadTokens.delete(hash);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** POST — mint a one-time download link (session required). Never rate-limited
 * hard enough to block a frustrated owner: 10 per 5 minutes. */
export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  if (!rateLimit(`workspace-token:${clientKey(req)}`, 10, 300_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many download links — wait a moment and try again." } },
      { status: 429 },
    );
  }

  pruneDownloadTokens();
  const token = `nxdl_${randomBytes(24).toString("hex")}`;
  downloadTokens.set(hashToken(token), Date.now() + DOWNLOAD_TOKEN_TTL_MS);

  const stamp = new Date().toISOString().slice(0, 10);
  return NextResponse.json(
    {
      ok: true,
      url: `/api/backup/workspace?dl=${token}`,
      filename: `NEXUS-OS-source-${stamp}.zip`,
      expiresInSec: Math.floor(DOWNLOAD_TOKEN_TTL_MS / 1000),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(req: Request) {
  // Channel 2: one-time URL token (cookie-free, iframe-proof).
  const dlToken = new URL(req.url).searchParams.get("dl")?.trim() ?? "";
  let tokenAuth = false;
  if (dlToken.startsWith("nxdl_") && dlToken.length <= 128) {
    pruneDownloadTokens();
    const hash = hashToken(dlToken);
    const exp = downloadTokens.get(hash);
    if (exp && exp > Date.now()) {
      // Burn BEFORE building — a token can never be replayed or raced.
      downloadTokens.delete(hash);
      tokenAuth = true;
    } else {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "TOKEN_EXPIRED",
            message: "This download link was already used or expired (links are single-use, 5 minutes). Press Download workspace again.",
          },
        },
        { status: 410 },
      );
    }
  }

  // Channel 1: normal panel session.
  if (!tokenAuth) {
    const denied = await requireSession();
    if (denied) return denied;

    if (!rateLimit(`workspace-export:${clientKey(req)}`, 3, 300_000)) {
      return NextResponse.json(
        { ok: false, error: { code: "RATE_LIMITED", message: "Workspace export is limited to once every 5 minutes." } },
        { status: 429 },
      );
    }
  }

  const root = process.cwd();
  const stage = await mkdtemp(path.join(tmpdir(), "nexus-export-"));
  try {
    // 1) Copy the source tree (dirs individually — nothing implicit). The
    //    ops/vault/ directory (git askpass token) is NEVER exported.
    for (const dir of INCLUDE_DIRS) {
      const src = path.join(root, dir);
      if (await exists(src)) {
        await cp(src, path.join(stage, dir), {
          recursive: true,
          filter: (s) => {
            const rel = path.relative(root, s);
            if (rel.startsWith(`ops${path.sep}vault`)) return false; // secrets — never export
            const base = path.basename(s);
            return !(base === "node_modules" || base === ".cache" || base.endsWith(".log"));
          },
        }).catch(() => {});
      }
    }
    for (const file of INCLUDE_FILES) {
      const src = path.join(root, file);
      if (await exists(src)) {
        await cp(src, path.join(stage, file)).catch(() => {});
      }
    }

    // 1.5) The sandbox seal — passphrase-encrypted STATE bundle (env keys +
    //      vault credential envelopes + widgets + settings + ingest-token
    //      hashes). PUBLIC BY DESIGN: it already rides the GitHub snapshot
    //      chain (scripts/secret-scan.sh ships an explicit seal exemption —
    //      validated ciphertext envelope, no plaintext fields), so including
    //      it here adds ZERO new exposure while making the owner's Drive
    //      archive state-carrying: drop this zip's .seal/ into a fresh
    //      workspace, unseal with the passphrase, and the vault + OBS links
    //      + widgets + settings all come back (2026-10-29 incident lesson:
    //      source-only zips cannot restore runtime state).
    const sealSrc = path.join(root, ".seal", "nexus-seal.v1.json");
    if (await exists(sealSrc)) {
      await mkdir(path.join(stage, ".seal"), { recursive: true }).catch(() => {});
      await cp(sealSrc, path.join(stage, ".seal", "nexus-seal.v1.json")).catch(() => {});
    }

    // 2) RECOVERY.txt — the thing the owner actually went looking for.
    const password = process.env.PANEL_PASSWORD ?? "(not set — the durable DB hash still accepts your rotated password)";
    const recovery = [
      "NEXUS OS — WORKSPACE EXPORT (source only)",
      "==========================================",
      "",
      `Exported: ${new Date().toISOString()}`,
      "",
      "PANEL LOGIN",
      "-----------",
      `Password (recovery copy, same as .env PANEL_PASSWORD): ${password}`,
      "The durable copy lives in the panel database (Setting panel.passwordHash) —",
      "after a sandbox reset, log in ONCE with this recovery value and the DB hash",
      "re-seeds itself. Rotate anytime in Settings -> Panel access.",
      "",
      "WHAT'S IN HERE",
      "--------------",
      "src/           Next.js panel + API routes (the whole NEXUS OS)",
      "edge/          Supabase nexus-cortex edge function (v29.14 source)",
      "mini-services/ kick-bridge (chat websocket) + backup-cadence",
      "prisma/        database schema (data itself is NOT exported)",
      "scripts/       ops scripts (deploy, verify, backfill)",
      "docs/          runbook.md (section 0 = panel access)",
      ".seal/         sandbox seal — passphrase-encrypted STATE bundle",
      "               (env keys + vault credentials + widgets + OBS tokens",
      "               + settings). Restores everything in one step.",
      "",
      "NOT in here (by design): .env, db/*.db, node_modules, upload/, vault files.",
      "(The seal carries their state ENCRYPTED — it needs only your passphrase.)",
      "",
      "QUICK START (after a reset)",
      "--------------------------",
      "1. bun install && bunx prisma db push && bun run dev",
      "2. Open the panel, sign in with the password above.",
      "3. Settings -> Sandbox seal -> Restore: paste your seal passphrase",
      "   (the .seal/nexus-seal.v1.json inside THIS zip). Vault, widgets, OBS",
      "   tokens and settings all come back in one click.",
      "4. No seal? Fallback: Widgets -> re-create the OBS Browser Source URL",
      "   (1 click) and re-enter connector keys in the Connectors tab.",
      "",
    ].join("\n");
    await writeFile(path.join(stage, "RECOVERY.txt"), recovery, "utf8");

    // 3) Zip the staged tree.
    const zipPath = path.join(stage, "..", `nexus-workspace-${Date.now()}.zip`);
    await execFileAsync("zip", ["-r", "-q", "-X", zipPath, "."], {
      cwd: stage,
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
    });

    const buf = await readFile(zipPath);
    await rm(zipPath, { force: true }).catch(() => {});

    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="NEXUS-OS-source-${stamp}.zip"`,
        "Content-Length": String(buf.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "EXPORT_FAILED",
          message: `Could not build the workspace zip: ${e instanceof Error ? e.message.slice(0, 180) : "unknown error"}`,
        },
      },
      { status: 500 },
    );
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}
