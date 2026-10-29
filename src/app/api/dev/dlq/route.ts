// GET /api/dev/dlq — dead-letter surface for the Pipeline tab (FR-31, spec
// v1.3 clarification): failed outbox rows + deadletter jobs, metadata only
// (no payload fragments — RT-13 discipline). Pairs with POST /api/dev/redrive.
// Session-gated per the §11 authz matrix.

import { NextResponse } from 'next/server'
import { db, ensureDbReady } from '@/lib/db'
import { requireSession } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied
  await ensureDbReady()

  const [failedOutbox, deadletterJobs] = await Promise.all([
    db.outbox.findMany({
      where: { status: 'failed' },
      orderBy: { id: 'asc' },
      take: 200,
      select: {
        id: true,
        eventId: true,
        topic: true,
        attempts: true,
        lastError: true,
        createdAt: true,
        nextAttemptAt: true,
      },
    }),
    db.job.findMany({
      where: { status: 'deadletter' },
      orderBy: { id: 'asc' },
      take: 200,
      select: {
        id: true,
        type: true,
        attempts: true,
        lastError: true,
        endedAt: true,
      },
    }),
  ])

  return NextResponse.json({ outbox: failedOutbox, jobs: deadletterJobs })
}
