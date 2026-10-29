// POST /api/jobs — job creation (FR-03): registry-validated type/payload,
// idempotency dedupe (RT-11 style race rule), single error shape (§11).
// GET /api/jobs — job list: status/limit/since pagination, `{items, nextSince?}`.
//
// NOTE: no auth checks here by contract — session gating lands via middleware
// in T-107 (§11 authz matrix). The in-process runner loop starts via import
// side effect (single-writer topology, spec §12) so a fresh boot drains the
// queue without a manual kick; the outbox loop is started too so lifecycle
// events are deliverable even if /api/events was never loaded.

import { NextResponse } from 'next/server'
import { db, ensureDbReady } from '@/lib/db'
import { createJob, ensureRunnerRunning, JOB_STATUSES } from '@/lib/jobs'
import { requireSession } from '@/lib/auth'
import { ensureOutboxRunning } from '@/lib/outbox'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

ensureRunnerRunning()
ensureOutboxRunning()

interface ErrorBody {
  error: {
    code: string
    message: string
    details?: Array<{ field: string; issue: string }>
  }
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: Array<{ field: string; issue: string }>,
): NextResponse<ErrorBody> {
  const body: ErrorBody = {
    error: details ? { code, message, details } : { code, message },
  }
  return NextResponse.json(body, { status })
}

function normalizeJson(value: unknown): unknown {
  // Prisma/SQLite Json columns deserialize automatically; be defensive about
  // legacy string payloads without ever rejecting a read.
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return value
    }
  }
  return value
}

// ---------------------------------------------------------------------------
// POST — create job
// ---------------------------------------------------------------------------

export async function POST(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied
  await ensureDbReady()

  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(await req.arrayBuffer())) as unknown
  } catch {
    return errorResponse(400, 'validation', 'Request body is not valid JSON', [
      { field: '(root)', issue: 'body is not valid JSON' },
    ])
  }

  const result = await createJob(body)
  if (!result.ok) {
    return errorResponse(400, 'validation', result.message, result.details)
  }
  if (result.deduped) {
    return NextResponse.json({ jobId: result.job.id, deduped: true }, { status: 200 })
  }
  return NextResponse.json({ jobId: result.job.id }, { status: 202 })
}

// ---------------------------------------------------------------------------
// GET — job list (status transitions live only in the runner, FR-03)
// ---------------------------------------------------------------------------

export async function GET(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied
  await ensureDbReady()

  const params = new URL(req.url).searchParams

  const statusParam = params.get('status')
  if (statusParam !== null && !JOB_STATUSES.includes(statusParam as never)) {
    return errorResponse(400, 'validation', 'Invalid query parameter', [
      { field: 'status', issue: `must be one of: ${JOB_STATUSES.join(', ')}` },
    ])
  }

  const sinceRaw = params.get('since') ?? '0'
  const since = Number(sinceRaw)
  if (!Number.isInteger(since) || since < 0 || sinceRaw.trim() === '') {
    return errorResponse(400, 'validation', 'Invalid query parameter', [
      { field: 'since', issue: 'must be a non-negative integer (exclusive lower bound on id)' },
    ])
  }

  const limitRaw = params.get('limit') ?? '50'
  const limit = Number(limitRaw)
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return errorResponse(400, 'validation', 'Invalid query parameter', [
      { field: 'limit', issue: 'must be an integer between 1 and 200' },
    ])
  }

  const orderParam = params.get('order')
  if (orderParam !== null && orderParam !== 'asc' && orderParam !== 'desc') {
    return errorResponse(400, 'validation', 'Invalid query parameter', [
      { field: 'order', issue: "must be 'asc' or 'desc'" },
    ])
  }
  const order = orderParam ?? 'asc'

  let before: number | null = null
  const beforeRaw = params.get('before')
  if (beforeRaw !== null) {
    before = Number(beforeRaw)
    if (!Number.isInteger(before) || before < 0 || beforeRaw.trim() === '') {
      return errorResponse(400, 'validation', 'Invalid query parameter', [
        { field: 'before', issue: 'must be a non-negative integer (exclusive upper bound on id)' },
      ])
    }
  }

  const rows = await db.job.findMany({
    where: {
      id: { gt: since, ...(before !== null ? { lt: before } : {}) },
      ...(statusParam !== null ? { status: statusParam } : {}),
    },
    orderBy: { id: order },
    take: limit,
  })

  const items = rows.map((row) => ({
    ...row,
    payload: normalizeJson(row.payload),
    checkpoint: normalizeJson(row.checkpoint),
  }))

  // Full page → continuation cursor: ascending pages continue from the max id
  // (nextSince); descending pages continue older from the min id (nextBefore).
  const fullPage = rows.length === limit
  return NextResponse.json({
    items,
    ...(fullPage && order === 'asc' ? { nextSince: rows[rows.length - 1].id } : {}),
    ...(fullPage && order === 'desc' ? { nextBefore: rows[rows.length - 1].id } : {}),
  })
}
