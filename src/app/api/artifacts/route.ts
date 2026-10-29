// GET /api/artifacts — artifact index (FR-04): metadata only, NEVER file
// content. since/limit pagination, `{items, nextSince?}` shape (§11).
//
// NOTE: no auth check here by contract — session gating lands via middleware
// in T-107 (§11 authz matrix).

import { NextResponse } from 'next/server'
import { db, ensureDbReady } from '@/lib/db'
import { requireSession } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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

export async function GET(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied
  await ensureDbReady()

  const params = new URL(req.url).searchParams

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

  const rows = await db.artifact.findMany({
    where: { id: { gt: since, ...(before !== null ? { lt: before } : {}) } },
    orderBy: { id: order },
    take: limit,
    // Metadata only — file bytes are served by /api/artifacts/[id].
    select: {
      id: true,
      jobId: true,
      kind: true,
      path: true,
      sha256: true,
      bytes: true,
      createdAt: true,
    },
  })

  // Full page → continuation cursor: ascending pages continue from the max id
  // (nextSince); descending pages continue older from the min id (nextBefore).
  const fullPage = rows.length === limit
  return NextResponse.json({
    items: rows,
    ...(fullPage && order === 'asc' ? { nextSince: rows[rows.length - 1].id } : {}),
    ...(fullPage && order === 'desc' ? { nextBefore: rows[rows.length - 1].id } : {}),
  })
}
