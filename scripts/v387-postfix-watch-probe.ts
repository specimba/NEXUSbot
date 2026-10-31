/**
 * Post-v38.7 watch probe (readonly) — new relevance-drop / zero-model /
 * slow (>15s) / edge-win rows since ship (2026-10-31T01:58Z). Zero writes, zero sends.
 */
import { db } from "../src/lib/db";

const SHIP = new Date("2026-10-31T01:58:00Z");

async function main() {
  console.log("=== A. research.relevance-drop events since ship ===");
  const drops = await db.event.findMany({
    where: { type: "research.relevance-drop", createdAt: { gte: SHIP } },
    orderBy: { createdAt: "asc" },
  });
  if (!drops.length) console.log("NONE");
  for (const d of drops) console.log(`- ${d.createdAt?.toISOString()} :: ${String(d.payload).slice(0, 220)}`);

  console.log("=== B. research.zero-model-grounded events since ship ===");
  const zm = await db.event.findMany({ where: { type: "research.zero-model-grounded", createdAt: { gte: SHIP } } });
  if (!zm.length) console.log("NONE");
  for (const z of zm) console.log(`- ${z.createdAt?.toISOString()} :: ${String(z.payload).slice(0, 220)}`);

  console.log("=== C. Interaction rows since ship ===");
  const rows = await db.interactionLog.findMany({
    where: { createdAt: { gte: SHIP } },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true, username: true, command: true, model: true, modelId: true, status: true, webUsed: true, flags: true, error: true },
  });
  if (!rows.length) console.log("NONE");
  let slow = 0;
  for (const r of rows) {
    const flags = String(r.flags ?? "");
    const msMatch = flags.match(/(\d{4,6})ms/);
    const ms = msMatch ? parseInt(msMatch[1]) : null;
    if (ms && ms > 15000) { slow++; console.log(`- SLOW ${ms}ms model=${r.model} modelId=${r.modelId} :: ${String(r.command ?? "").slice(0, 80)}`); }
  }
  console.log(`total=${rows.length} slow(>15s)=${slow}`);
  for (const r of rows.slice(-8)) {
    console.log(`- ${r.createdAt?.toISOString()} user=${r.username} model=${r.model} modelId=${r.modelId} status=${r.status} web=${r.webUsed} :: ${String(r.command ?? "").slice(0, 60)} | flags=${String(r.flags ?? "").slice(0, 80)}`);
  }
  await db.$disconnect();
}

main();
