import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

const basePrisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // R14: 'query' logging flooded dev.log (281+ lines per short session — every
    // 30s status poll re-logged its credential lookups) and added I/O overhead.
    // errors + warns only; queries are visible via Prisma Studio when needed.
    log: ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = basePrisma

// ---------------------------------------------------------------------------
// Auto-reseal trigger (2026-10-29 incident fix — see src/lib/seal-cache.ts).
//
// After ANY successful mutation of the four seal-carried models, schedule a
// debounced seal refresh so the snapshot chain's seal tracks live vault state.
// Fire-and-forget by construction: the data path is never delayed, and the
// dynamic import can never break a mutation (failures land inside the guard).
// ---------------------------------------------------------------------------

const RESEAL_MODELS = new Set(['Credential', 'IngestToken', 'Widget', 'Setting'])
const RESEAL_ACTIONS = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
])

/**
 * lastUsedAt-only IngestToken updates are telemetry from OBS page loads (the
 * widget stream route stamps every render) — they must NOT keep the reseal
 * loop hot forever. Anything that actually changes seal material also changes
 * more than lastUsedAt and still triggers.
 */
function isTelemetryOnlyUpdate(
  model: string | undefined,
  operation: string,
  args: unknown,
): boolean {
  if (model !== 'IngestToken' || operation !== 'update') return false
  const data = (args as { data?: Record<string, unknown> } | undefined)?.data
  return (
    data !== undefined &&
    Object.keys(data).length === 1 &&
    'lastUsedAt' in data
  )
}

export const db = basePrisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, query, args }) {
        const result = await query(args)
        try {
          if (
            model !== undefined &&
            RESEAL_MODELS.has(model) &&
            RESEAL_ACTIONS.has(operation) &&
            !isTelemetryOnlyUpdate(model, operation, args)
          ) {
            const { scheduleReseal } = await import('@/lib/seal-cache')
            scheduleReseal(`${model}.${operation}`)
          }
        } catch {
          // Durability hint only — never break the data path.
        }
        return result
      },
    },
  },
})