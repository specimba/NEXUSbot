/**
 * One-off sync (v29.8): push the patched seed html/css/js into the live
 * "Specimba Cyber AI Counter" widget row WITHOUT touching the owner's saved
 * variable values (keys, cooldowns, colors...). Meta defaults are used only
 * for variables that don't exist in the row yet. Run: bun scripts/sync-widget-seed.ts
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const SEED_DIR = path.join(process.cwd(), "src", "lib", "widgets", "seeds");
const SEED_NAME = "Specimba Cyber AI Counter";

async function main() {
  const widget = await db.widget.findFirst({ where: { name: SEED_NAME } });
  if (!widget) {
    console.error("widget row not found — nothing to sync");
    process.exit(1);
  }

  const html = fs.readFileSync(path.join(SEED_DIR, "cyber-ai-counter.html"), "utf8");
  const css = fs.readFileSync(path.join(SEED_DIR, "cyber-ai-counter.css"), "utf8");
  const js = fs.readFileSync(path.join(SEED_DIR, "cyber-ai-counter.js"), "utf8");
  const meta = JSON.parse(
    fs.readFileSync(path.join(SEED_DIR, "cyber-ai-counter.meta.json"), "utf8"),
  ) as { variables: Array<{ name: string; label: string; type: string; value: string; secret?: boolean }> };

  let rowVars: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(widget.variables);
    if (Array.isArray(parsed)) rowVars = parsed;
  } catch {}

  const byName = new Map(rowVars.map((v) => [String(v.name), v]));
  const metaVars = meta.variables ?? [];

  // Start from the row's variables (owner values preserved), then append any
  // NEW meta variables that the row lacks.
  const merged: Array<Record<string, unknown>> = rowVars.map((v) => ({ ...v }));
  let added = 0;
  for (const mv of metaVars) {
    if (!byName.has(mv.name)) {
      merged.push({ name: mv.name, label: mv.label, type: mv.type, value: mv.value, ...(mv.secret ? { secret: true } : {}) });
      added++;
    }
  }

  await db.widget.update({
    where: { id: widget.id },
    data: {
      html,
      css,
      js,
      variables: JSON.stringify(merged),
    },
  });

  console.log(
    `synced: html ${html.length}B, css ${css.length}B, js ${js.length}B | variables ${rowVars.length} kept (+${added} new)`,
  );
  const secretNames = merged
    .filter((v) => v.secret === true)
    .map((v) => `${String(v.name)}=${String(v.value) ? "SET" : "EMPTY"}`);
  console.log("secret variables:", secretNames.join(", ") || "(none)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
