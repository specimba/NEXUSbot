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

let seedAttempted = false;

type SeedMeta = {
  name: string;
  width: number;
  height: number;
  description: string;
  variables: Array<WidgetVariable & { notes?: string }>;
};

export async function ensureSeedWidgets(): Promise<void> {
  if (seedAttempted) return;
  seedAttempted = true;
  try {
    const existing = await db.widget.findFirst({ where: { name: SEED_NAME }, select: { id: true } });
    if (existing) return;

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
