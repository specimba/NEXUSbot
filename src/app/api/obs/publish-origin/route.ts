import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * POST /api/obs/publish-origin — keep the GitHub-hosted OBS bridge
 * (obs.html on specimba.github.io) pointed at the LIVE panel address.
 *
 * The panel origin (preview address) rotates on every sandbox session; the
 * stable OBS URL only works while public/obs-target.json on GitHub main
 * carries the CURRENT origin. This route:
 *   1. stores the origin in the panel DB (Settings obs.published-origin[-at]),
 *   2. writes public/obs-target.json (rides the next snapshot push),
 *   3. spawns scripts/snapshot-backup.sh in the background with
 *      NEXUS_BACKUP_ORIGIN_PUSH=1 — a documented TIME-THROTTLE bypass (the
 *      scan gate, content dedupe, fast-forward-only and divergence checks all
 *      still apply) so an origin rotation reaches the bridge in moments
 *      instead of waiting out the 30-minute window.
 *
 * Fired automatically on every authenticated panel load (PanelApp effect) and
 * manually from the Widgets → OBS card ("Publish current address now").
 * GET returns the last published origin (panel UI status line).
 *
 * P7: the origin is the panel's public address — not a secret; the ingest
 * token NEVER enters this route or obs-target.json.
 */

const SETTING_ORIGIN = "obs.published-origin";
const SETTING_AT = "obs.published-origin-at";
const TARGET_FILE = path.join(process.cwd(), "public", "obs-target.json");

/** Accept http(s)://host[:port] ONLY — no path, no query, no credentials. */
function normalizeOrigin(raw: unknown): { value: string | null; error?: string } {
  if (typeof raw !== "string") return { value: null, error: "origin must be a string." };
  const s = raw.trim();
  if (s.length === 0) return { value: null, error: "origin is empty." };
  if (s.length > 200) return { value: null, error: "origin too long (max 200 chars)." };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { value: null, error: "origin is not a valid URL." };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { value: null, error: "origin must start with https:// or http://." };
  }
  if (u.username || u.password) {
    return { value: null, error: "origin must not contain credentials." };
  }
  if (u.origin !== s) {
    return { value: null, error: "origin must be scheme://host[:port] only — no path or query." };
  }
  return { value: u.origin };
}

async function readPublished(): Promise<{ origin: string | null; updatedAt: string | null }> {
  const [originRow, atRow] = await Promise.all([
    db.setting.findUnique({ where: { key: SETTING_ORIGIN } }),
    db.setting.findUnique({ where: { key: SETTING_AT } }),
  ]);
  return { origin: originRow?.value ?? null, updatedAt: atRow?.value ?? null };
}

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  const pub = await readPublished();
  return NextResponse.json({ ok: true, ...pub });
}

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  if (!rateLimit(`obs-publish-origin:${clientKey(req)}`, 6, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many publish attempts — slow down (6/min)." } },
      { status: 429 },
    );
  }

  const body = (await req.json().catch(() => null)) as { origin?: unknown } | null;
  const norm = normalizeOrigin(body?.origin);
  if (!norm.value) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_ORIGIN", message: norm.error ?? "Invalid origin." } },
      { status: 400 },
    );
  }
  const origin = norm.value;

  const current = await readPublished();
  if (current.origin === origin) {
    return NextResponse.json({ ok: true, published: false, origin, updatedAt: current.updatedAt });
  }

  const now = new Date().toISOString();
  await db.setting.upsert({
    where: { key: SETTING_ORIGIN },
    create: { key: SETTING_ORIGIN, value: origin },
    update: { value: origin },
  });
  await db.setting.upsert({
    where: { key: SETTING_AT },
    create: { key: SETTING_AT, value: now },
    update: { value: now },
  });
  await writeFile(
    TARGET_FILE,
    JSON.stringify(
      {
        origin,
        updatedAt: now,
        note: "Current NEXUS OS panel origin — auto-published by the panel. Origin only, not a secret.",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  // Background snapshot push so the bridge picks up the new origin in moments.
  // Failure is non-fatal: the 6h cadence push still carries the file.
  try {
    const child = spawn("bash", ["scripts/snapshot-backup.sh"], {
      cwd: process.cwd(),
      env: { ...process.env, NEXUS_BACKUP_ORIGIN_PUSH: "1" },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    /* spawn failed — cadence push will deliver the file */
  }

  return NextResponse.json({ ok: true, published: true, origin, updatedAt: now });
}
