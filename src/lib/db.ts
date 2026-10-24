import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // R14: 'query' logging flooded dev.log (281+ lines per short session — every
    // 30s status poll re-logged its credential lookups) and added I/O overhead.
    // errors + warns only; queries are visible via Prisma Studio when needed.
    log: ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db