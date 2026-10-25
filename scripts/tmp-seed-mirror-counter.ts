/* One-off (E1): seed the lifetime mirror counter with the MEASURED cloud truth.
 * The old status bug reset `pushed` on every restart and overwrote the
 * Setting; the real ledger is the cloud table itself (65 + 2 rows). */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const s = await db.setting.findUnique({ where: { key: "brain.mirror.status" } });
const cur = s?.value ? JSON.parse(s.value) : {};
const next = { ...cur, pushed: 67, failed: cur.failed ?? 0 };
await db.setting.upsert({
  where: { key: "brain.mirror.status" },
  create: { key: "brain.mirror.status", value: JSON.stringify(next) },
  update: { value: JSON.stringify(next) },
});
console.log("seeded lifetime pushed=67 (65 interactions + 2 lessons measured in nexus_mirror_*)");
await db.$disconnect();
