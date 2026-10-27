// backfill-security-flags.ts — one-time migration (v34.2).
// The v34 detection shipped AFTER tonight's live attacks were already written
// with flags:"[]" — the owner's panel therefore still showed "No security
// lessons yet" even though the corpus is full of real injection attempts.
// Re-scan every unflagged row with the CURRENT detector, update flags/score,
// and fold SecurityLessons for them. Bot-own rows are skipped (lessons must
// attach to the human attacker, not the bot echoing quoted attack text).
// Usage: bun scripts/backfill-security-flags.ts [--apply]
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const apply = process.argv.includes("--apply");

// same normalization as the routes
const botHandles = new Set(["nexusspecimbabot"]);

async function main() {
  const { detectInjectionTechniques, FLAG_SEVERITY } = await import("../src/lib/brain/auth");
  const { foldSecurityLessons } = await import("../src/lib/brain/security-lesson");

  const rows = await db.interactionLog.findMany({
    where: { flags: "[]" },
    select: { id: true, username: true, message: true, response: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`scanning ${rows.length} unflagged rows (${apply ? "APPLY" : "DRY RUN"})`);

  const perUser = new Map<string, Map<string, number>>();
  let flagged = 0;
  for (const r of rows) {
    if (botHandles.has(r.username)) continue; // bot echoes are not attacker rows
    const message = r.message ?? "";
    if (!message.trim()) continue;
    const detected = detectInjectionTechniques(message);
    if (!detected.length) continue;
    flagged++;
    const score = detected.reduce((m, f) => Math.max(m, FLAG_SEVERITY[f] ?? 1), 0);
    const techniques = perUser.get(r.username) ?? new Map<string, number>();
    for (const t of detected) techniques.set(t, (techniques.get(t) ?? 0) + 1);
    perUser.set(r.username, techniques);
    console.log(
      `[${new Date(r.createdAt).toISOString()}] ${r.username} → ${detected.join(",")} (score ${score}) :: ${message.slice(0, 90)}`,
    );
    if (apply) {
      await db.interactionLog.update({
        where: { id: r.id },
        data: { flags: JSON.stringify(detected), injectionScore: score },
      });
      await foldSecurityLessons({
        username: r.username,
        message,
        response: r.response ?? "",
        techniques: detected,
      });
    }
  }

  console.log(`\nflagged rows: ${flagged}/${rows.length}`);
  for (const [user, tech] of perUser) {
    console.log(`lessons → ${user}: ${[...tech.entries()].map(([t, n]) => `${t}×${n}`).join(", ")}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
