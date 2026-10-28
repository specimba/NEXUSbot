import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { serializeWidgetVariables, type WidgetVariable } from "./runtime";

/**
 * Seed widget sync (v35.1 — the "first-run only" blind spot closed).
 *
 * HISTORY: this used to seed the owner's "Specimba Cyber AI Counter" exactly
 * once and never touch it again, so owner edits were never overwritten. The
 * blind spot: the seed file kept evolving in the repo (v29.13 → v34.3) while
 * the LIVE widget row stayed frozen at its 2026-10-26 state — the 2026-10-28
 * stream proved it: every "!ai çiz" attempt 502'd on the paid provider AND the
 * v29.22 free z-ai fallback (/api/imagine) never fired because the running
 * OBS overlay predates it. Code shipped in the repo is code the owner wants
 * live; the only thing worth protecting is the owner's VARIABLES (API keys,
 * colors, trigger — edited via the panel).
 *
 * Sync protocol (tamper-evident, owner-edit-safe):
 *   - Every sync writes a Setting row `widget.seedSync.<widgetId>` =
 *     { jsHash: <sha256 of the seed JS at sync time>, at: <ISO> }.
 *   - On boot (ensureSeedWidgets): if the stored JS hash still equals the
 *     LAST SYNCED seed hash, the live code is untouched since we wrote it →
 *     a newer seed file is safe to auto-sync (variables/width/height/enabled
 *     preserved; html/css/js replaced; an Event row records the change).
 *   - If the stored JS hash diverges from the record, the owner edited the
 *     code in the panel → auto-sync SKIPS (honest event row) and only the
 *     explicit force action (POST /api/widgets/[id]/sync-seed) can overwrite.
 *   - First adoption (no record yet): the pre-sync-era live code is treated
 *     as the seed baseline — if it differs from the current seed, it syncs
 *     once with mode "adopt" so the live overlay finally gains every fix.
 *     Owner VARIABLES are still preserved in every path.
 */

const SEED_NAME = "Specimba Cyber AI Counter";
const SEED_DIR = path.join(process.cwd(), "src", "lib", "widgets", "seeds");
const SEED_SYNC_PREFIX = "widget.seedSync.";

// Dump fidelity used to carry the Kickbot-era "nexus_shared_secret" variable,
// but the widget JS NEVER reads it and the v29.7 security review baked into the
// code forbids shared secrets living in browser/OBS code (anyone can open the
// exported HTML in DevTools). It only ever produced a false "empty secrets"
// export warning. Dropped from the seed meta; this list self-heals widget rows
// seeded before the fix (idempotent, owner edits to other variables preserved).
const DEPRECATED_SEED_VARS = ["nexus_shared_secret"];

let seedAttempted = false;

type SeedMeta = {
  name: string;
  width: number;
  height: number;
  description: string;
  variables: Array<WidgetVariable & { notes?: string }>;
};

type SeedSyncRecord = { jsHash: string; at: string };

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Best-effort audit row — never breaks seeding over a logging failure. */
async function logSeedEvent(
  type: string,
  payload: Record<string, unknown>,
  level: "info" | "warn" = "info",
): Promise<void> {
  try {
    await db.event.create({
      data: {
        source: "widget",
        type,
        level,
        actor: "panel",
        payload: JSON.stringify(payload).slice(0, 2048),
      },
    });
  } catch {
    // telemetry only
  }
}

/** Reads the seed files; null = honest no-op (never fake a sync). */
function readSeedFiles(): {
  meta: SeedMeta;
  html: string;
  css: string;
  js: string;
} | null {
  try {
    const meta = JSON.parse(
      fs.readFileSync(path.join(SEED_DIR, "cyber-ai-counter.meta.json"), "utf8"),
    ) as SeedMeta;
    const html = fs.readFileSync(path.join(SEED_DIR, "cyber-ai-counter.html"), "utf8");
    const css = fs.readFileSync(path.join(SEED_DIR, "cyber-ai-counter.css"), "utf8");
    const js = fs.readFileSync(path.join(SEED_DIR, "cyber-ai-counter.js"), "utf8");
    return { meta, html, css, js };
  } catch {
    return null;
  }
}

/** Strip meta-only "notes" from the seed variables before persisting. */
function seedVariables(meta: SeedMeta): WidgetVariable[] {
  return (meta.variables ?? []).map((v) => ({
    name: v.name,
    label: v.label,
    type: v.type,
    value: v.value,
    secret: v.secret === true,
  }));
}

async function stripDeprecatedSeedVariables(id: string, rawVariables: string): Promise<void> {
  try {
    const vars = JSON.parse(rawVariables) as WidgetVariable[];
    if (!Array.isArray(vars)) return;
    const cleaned = vars.filter((v) => !DEPRECATED_SEED_VARS.includes(v.name));
    if (cleaned.length === vars.length) return;
    await db.widget.update({
      where: { id },
      data: { variables: serializeWidgetVariables(cleaned) },
    });
  } catch {
    // Never crash seeding/cleanup over a malformed variables blob.
  }
}

async function readSyncRecord(id: string): Promise<SeedSyncRecord | null> {
  try {
    const row = await db.setting.findUnique({ where: { key: `${SEED_SYNC_PREFIX}${id}` } });
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as Partial<SeedSyncRecord>;
    if (typeof parsed.jsHash !== "string" || !parsed.jsHash) return null;
    return { jsHash: parsed.jsHash, at: typeof parsed.at === "string" ? parsed.at : "" };
  } catch {
    return null;
  }
}

async function writeSyncRecord(id: string, jsHash: string): Promise<void> {
  const record: SeedSyncRecord = { jsHash, at: new Date().toISOString() };
  await db.setting.upsert({
    where: { key: `${SEED_SYNC_PREFIX}${id}` },
    create: { key: `${SEED_SYNC_PREFIX}${id}`, value: JSON.stringify(record) },
    update: { value: JSON.stringify(record) },
  });
}

/** Replace the widget's html/css/js from the seed. Variables/geometry/enabled preserved. */
async function applySeedCode(id: string, files: { html: string; css: string; js: string }): Promise<void> {
  await db.widget.update({
    where: { id },
    data: { html: files.html, css: files.css, js: files.js },
  });
}

/**
 * Version-aware sync decision for the existing seeded widget. Exported so the
 * explicit force action (/api/widgets/[id]/sync-seed) reuses the same write path.
 */
export async function syncSeedWidget(
  widgetId: string,
  opts: { force: boolean },
): Promise<{ ok: boolean; mode: string; jsHash: string; detail: string }> {
  const files = readSeedFiles();
  if (!files) {
    return { ok: false, mode: "no-seed", jsHash: "", detail: "Seed files unreadable — honest no-op." };
  }
  const seedJsHash = sha256(files.js);
  const widget = await db.widget.findUnique({ where: { id: widgetId } });
  if (!widget) {
    return { ok: false, mode: "no-widget", jsHash: seedJsHash, detail: "Widget not found." };
  }
  const storedJsHash = sha256(widget.js || "");
  const record = await readSyncRecord(widgetId);

  if (opts.force) {
    await applySeedCode(widgetId, files);
    await writeSyncRecord(widgetId, seedJsHash);
    await logSeedEvent("widget.seed-sync", {
      widgetId,
      mode: "force",
      fromJsHash: storedJsHash.slice(0, 8),
      toJsHash: seedJsHash.slice(0, 8),
      codeChanged: storedJsHash !== seedJsHash,
    });
    return {
      ok: true,
      mode: "force",
      jsHash: seedJsHash,
      detail:
        storedJsHash === seedJsHash
          ? "Live code already matched the seed (record refreshed)."
          : "Live code replaced from the seed; owner variables preserved. Refresh the OBS Browser Source to run the new code.",
    };
  }

  // First adoption of a pre-sync-era widget row.
  if (!record) {
    if (storedJsHash !== seedJsHash) {
      await applySeedCode(widgetId, files);
      await writeSyncRecord(widgetId, seedJsHash);
      await logSeedEvent("widget.seed-sync", {
        widgetId,
        mode: "adopt",
        fromJsHash: storedJsHash.slice(0, 8),
        toJsHash: seedJsHash.slice(0, 8),
      });
      return {
        ok: true,
        mode: "adopt",
        jsHash: seedJsHash,
        detail: "Pre-sync-era live code adopted the current seed; owner variables preserved. Refresh the OBS Browser Source once.",
      };
    }
    await writeSyncRecord(widgetId, seedJsHash);
    return { ok: true, mode: "adopt-clean", jsHash: seedJsHash, detail: "Live code already equals the seed; sync record created." };
  }

  // Owner edited the code in the panel since our last sync → hands off.
  if (storedJsHash !== record.jsHash) {
    await logSeedEvent(
      "widget.seed-sync-skipped",
      {
        widgetId,
        mode: "live-code-modified",
        storedJsHash: storedJsHash.slice(0, 8),
        syncedJsHash: record.jsHash.slice(0, 8),
        seedJsHash: seedJsHash.slice(0, 8),
      },
      "warn",
    );
    return {
      ok: false,
      mode: "live-code-modified",
      jsHash: record.jsHash,
      detail: "Live widget code was modified in the panel since the last seed sync — auto-sync skipped. Use force sync to overwrite with the seed.",
    };
  }

  // Clean state: our code, older seed → auto-update.
  if (record.jsHash !== seedJsHash) {
    await applySeedCode(widgetId, files);
    await writeSyncRecord(widgetId, seedJsHash);
    await logSeedEvent("widget.seed-sync", {
      widgetId,
      mode: "seed-update",
      fromJsHash: record.jsHash.slice(0, 8),
      toJsHash: seedJsHash.slice(0, 8),
    });
    return {
      ok: true,
      mode: "seed-update",
      jsHash: seedJsHash,
      detail: "Seed updated in the repo — live code synced; owner variables preserved. Refresh the OBS Browser Source once.",
    };
  }

  return { ok: true, mode: "current", jsHash: seedJsHash, detail: "Live code is current with the seed." };
}

export async function ensureSeedWidgets(): Promise<void> {
  if (seedAttempted) return;
  seedAttempted = true;
  try {
    const existing = await db.widget.findFirst({
      where: { name: SEED_NAME },
      select: { id: true, variables: true },
    });
    if (existing) {
      await stripDeprecatedSeedVariables(existing.id, existing.variables);
      // v35.1: version-aware code sync (variables always preserved). Honest
      // no-ops (missing files, modified live code) are recorded as events,
      // never swallowed silently.
      await syncSeedWidget(existing.id, { force: false });
      return;
    }

    const files = readSeedFiles();
    if (!files) return;
    const { meta, html, css, js } = files;
    const created = await db.widget.create({
      data: {
        name: meta.name || SEED_NAME,
        width: meta.width || 560,
        height: meta.height || 260,
        html,
        css,
        js,
        variables: serializeWidgetVariables(seedVariables(meta)),
        enabled: true,
        seeded: true,
      },
    });
    await writeSyncRecord(created.id, sha256(js));
    await logSeedEvent("widget.seed-sync", { widgetId: created.id, mode: "first-run", toJsHash: sha256(js).slice(0, 8) });
  } catch {
    // Honest no-op — the owner can still create widgets manually. Never fake
    // success, never crash the list endpoint because of a missing seed.
  }
}
