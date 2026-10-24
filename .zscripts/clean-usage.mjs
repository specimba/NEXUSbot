import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const t1 = await db.usageEvent.deleteMany({ where: { userHandle: "@verify_t207" } });
const t2 = await db.usageEvent.deleteMany({ where: { kind: "llm", userHandle: null } });
console.log(JSON.stringify({ removedImageTest: t1.count, removedLlmTest: t2.count }));
await db.$disconnect();
