import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { serializeWidgetVariables, type WidgetVariable } from "./runtime";

/**
 * First-run seeder: imports the owner's "Specimba Cyber AI Counter" widget
 * (extracted verbatim from the Kickbot builder saved state) exactly once —
 * guarded by a name check so owner edits are NEVER overwritten afterwards.
 * If the seed files are missing/unreadable the call is an honest no-op.
 */

const SEED_NAME = "Specimba Cyber AI Counter";
const SEED_DIR = path.join(process.cwd(), "src", "lib", "widgets", "seeds");

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
      return;
    }

    const meta = JSON.parse(
      fs.readFileSync(path.join(SEED_DIR, "cyber-ai-counter.meta.json"), "utf8"),
    ) as SeedMeta;
    const html = fs.readFileSync(path.join(SEED_DIR, "cyber-ai-counter.html"), "utf8");
    const css = fs.readFileSync(path.join(SEED_DIR, "cyber-ai-counter.css"), "utf8");
    const js = fs.readFileSync(path.join(SEED_DIR, "cyber-ai-counter.js"), "utf8");

    // Strip the meta-only "notes" field from variables before persisting.
    const variables: WidgetVariable[] = (meta.variables ?? []).map((v) => ({
      name: v.name,
      label: v.label,
      type: v.type,
      value: v.value,
      secret: v.secret === true,
    }));

    await db.widget.create({
      data: {
        name: meta.name || SEED_NAME,
        width: meta.width || 560,
        height: meta.height || 260,
        html,
        css,
        js,
        variables: serializeWidgetVariables(variables),
        enabled: true,
        seeded: true,
      },
    });
  } catch {
    // Honest no-op — the owner can still create widgets manually. Never fake
    // success, never crash the list endpoint because of a missing seed.
  }
}
