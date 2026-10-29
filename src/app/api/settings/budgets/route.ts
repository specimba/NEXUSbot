// GET/PUT /api/settings/budgets — FR-18 per-job-type budget defaults (T-208).
//
// Budgets are NON-SECRET configuration (spec §3: "Setting — non-secret config
// only") → plain values, no masking. Stored as ONE Setting row keyed
// `budgets.defaults` with value = { [jobType]: { budgetMs?, tokenBudget?,
// costBudget? } }:
//   - budgetMs     → wall-clock default; LIVE today — consumed by POST
//                    /api/jobs defaulting and enforced loudly by the runner
//                    (budget_exceeded, NFR-05). Band mirrors the acceptance
//                    range in src/lib/jobs.ts (module-private constants there):
//                    floor 1 keeps the frozen budgetMs:1 GWT exercisable.
//   - tokenBudget  → FR-32 field, named by FR-18 ("wall-clock + tokens + cost");
//                    stored now, consumed when the M2 gateway actor lands.
//   - costBudget   → FR-32 cost ceiling in USD; stored now, consumed at M2.
//
// PUT is a full-replace of the defaults map (idempotent by construction —
// spec §11 "idempotent where a retry is meaningful"). Job-type keys are
// registry-checked against the code-frozen JOB_TYPES in src/lib/jobs.ts.
// Every failure answers the single §11 error shape.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db, ensureDbReady, withWriteRetry } from '@/lib/db'
import { requireSession } from '@/lib/auth'
import { JOB_TYPES } from '@/lib/jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BUDGETS_SETTING_KEY = 'budgets.defaults'

// Mirrors BUDGET_MIN_MS/BUDGET_MAX_MS in src/lib/jobs.ts (module-private).
const BUDGET_MIN_MS = 1
const BUDGET_MAX_MS = 600_000

// FR-32 fields: generous sanity bounds; null/absent = unset.
const TOKEN_BUDGET_MAX = 10_000_000
const COST_BUDGET_MAX = 1_000_000

interface BudgetFields {
  budgetMs?: number | null
  tokenBudget?: number | null
  costBudget?: number | null
}

type BudgetDefaults = Record<string, BudgetFields>

const budgetFieldsSchema = z.object({
  budgetMs: z.number().int().min(BUDGET_MIN_MS).max(BUDGET_MAX_MS).nullable().optional(),
  tokenBudget: z.number().int().min(0).max(TOKEN_BUDGET_MAX).nullable().optional(),
  costBudget: z.number().min(0).max(COST_BUDGET_MAX).nullable().optional(),
})

const putSchema = z.object({
  defaults: z.record(z.string(), budgetFieldsSchema),
})

function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: Array<{ field: string; issue: string }>,
): NextResponse {
  return NextResponse.json(
    { error: details ? { code, message, details } : { code, message } },
    { status },
  )
}

function validationDetails(err: z.ZodError): Array<{ field: string; issue: string }> {
  return err.issues.map((iss) => ({
    field: iss.path.length > 0 ? iss.path.join('.') : '(root)',
    issue: iss.message,
  }))
}

/** Validate the stored JSON value shape; the only writer is the validated PUT. */
function parseStoredDefaults(value: unknown): BudgetDefaults | null {
  const parsed = putSchema.safeParse({ defaults: value })
  return parsed.success ? parsed.data.defaults : null
}

/** Drop `undefined` fields so stored JSON stays compact; null = explicit unset. */
function normalizeEntry(entry: BudgetFields): BudgetFields {
  const out: BudgetFields = {}
  if (entry.budgetMs !== undefined) out.budgetMs = entry.budgetMs
  if (entry.tokenBudget !== undefined) out.tokenBudget = entry.tokenBudget
  if (entry.costBudget !== undefined) out.costBudget = entry.costBudget
  return out
}

export async function GET(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied

  try {
    await ensureDbReady()
    const row = await db.setting.findUnique({ where: { key: BUDGETS_SETTING_KEY } })
    if (row) {
      const defaults = parseStoredDefaults(row.value)
      if (defaults === null) {
        // Loud, not silent (NFR-05 spirit): a hand-edited row must not pretend
        // to be config. Fixable via PUT with the same shape.
        return errorResponse(
          500,
          'internal',
          'Stored budget defaults failed validation — rewrite them via PUT /api/settings/budgets',
        )
      }
      return NextResponse.json({
        jobTypes: JOB_TYPES,
        defaults,
        updatedAt: row.updatedAt.toISOString(),
      })
    }
    return NextResponse.json({ jobTypes: JOB_TYPES, defaults: {}, updatedAt: null })
  } catch {
    return errorResponse(500, 'internal', 'Could not read budget defaults')
  }
}

export async function PUT(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, 'validation', 'Request body is not valid JSON', [
      { field: '(root)', issue: 'must be a JSON object' },
    ])
  }

  const parsed = putSchema.safeParse(body)
  if (!parsed.success) {
    return errorResponse(
      400,
      'validation',
      'Budget defaults failed validation',
      validationDetails(parsed.error),
    )
  }

  // Registry-check the job-type keys against the frozen JOB_TYPES (code-frozen
  // registry in src/lib/jobs.ts — new types appear there first, never here).
  const unknownKeys = Object.keys(parsed.data.defaults).filter(
    (key) => !(JOB_TYPES as readonly string[]).includes(key),
  )
  if (unknownKeys.length > 0) {
    return errorResponse(400, 'validation', 'Budget defaults failed validation', [
      ...unknownKeys.map((key) => ({
        field: `defaults.${key}`,
        issue: `unknown job type — registry: ${JOB_TYPES.join(', ')}`,
      })),
    ])
  }

  const normalized: BudgetDefaults = {}
  for (const [jobType, entry] of Object.entries(parsed.data.defaults)) {
    normalized[jobType] = normalizeEntry(entry)
  }

  try {
    await ensureDbReady()
    const row = await withWriteRetry(() =>
      db.setting.upsert({
        where: { key: BUDGETS_SETTING_KEY },
        create: { key: BUDGETS_SETTING_KEY, value: normalized },
        update: { value: normalized },
      }),
    )
    return NextResponse.json({
      jobTypes: JOB_TYPES,
      defaults: normalized,
      updatedAt: row.updatedAt.toISOString(),
    })
  } catch {
    return errorResponse(500, 'internal', 'Could not save budget defaults')
  }
}
