// POST /api/dev/redrive — FR-31 (v1.2), SESSION-GATED. Manual DLQ re-drive:
//   kind=outbox → ONLY status='failed' rows: back to 'pending' with
//                 nextAttemptAt=now (attempts kept for audit).
//   kind=job    → ONLY status='deadletter' jobs: back to 'queued'
//                 (attempts kept for audit).
// Wrong kind → 400 validation; unknown id → 404; wrong state → 400.
// §11 error shape everywhere; never touches attempts (audit trail).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db, ensureDbReady, withWriteRetry } from '@/lib/db'
import { requireSession } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const redriveSchema = z.object({
  kind: z.enum(['outbox', 'job']),
  id: z.number().int().positive(),
})

function error(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status })
}

export async function POST(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied
  await ensureDbReady()

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return error(400, 'validation', 'Request body is not valid JSON')
  }
  const parsed = redriveSchema.safeParse(body)
  if (!parsed.success) {
    return error(400, 'validation', 'Redrive request failed validation')
  }
  const { kind, id } = parsed.data

  if (kind === 'outbox') {
    const row = await db.outbox.findUnique({ where: { id } })
    if (!row) return error(404, 'not_found', `Outbox row ${id} not found`)
    if (row.status !== 'failed') {
      return error(
        400,
        'invalid_state',
        `Outbox row ${id} has status '${row.status}'; only 'failed' rows can be redriven`,
      )
    }
    await withWriteRetry(() =>
      db.outbox.update({
        where: { id },
        data: { status: 'pending', nextAttemptAt: new Date() },
      }),
    )
    return NextResponse.json({ kind, id, status: 'pending' })
  }

  const row = await db.job.findUnique({ where: { id } })
  if (!row) return error(404, 'not_found', `Job ${id} not found`)
  if (row.status !== 'deadletter') {
    return error(
      400,
      'invalid_state',
      `Job ${id} has status '${row.status}'; only 'deadletter' jobs can be redriven`,
    )
  }
  await withWriteRetry(() =>
    db.job.update({ where: { id }, data: { status: 'queued' } }),
  )
  return NextResponse.json({ kind, id, status: 'queued' })
}
