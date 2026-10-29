// GET /api/metrics — FR-06 source (v1.2), SESSION-GATED. All numbers are
// server-computed from live tables — never fake (US-01):
//   eventsPerMin   = count(Event.ingestedAt > now-60s)
//   jobs/outbox    = live groupBy status (DLQ visible: failed + deadletter)
//   ingestLatency  = rolling window from @/lib/events (FR-06 v1.2 source)
// Module top fires the FR-31 boot retention sweep once per process (guarded,
// fire-and-forget — never blocks the first request).

import { NextResponse } from 'next/server'
import { db, ensureDbReady } from '@/lib/db'
import { getIngestLatencyStats } from '@/lib/events'
import { requireSession } from '@/lib/auth'
import { runRetentionSweep } from '@/lib/retention'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// FR-31 boot sweep — once per process, guarded by globalThis (HMR-safe).
const globalForBoot = globalThis as unknown as {
  __nexusBootRetentionSwept: boolean | undefined
}
if (!globalForBoot.__nexusBootRetentionSwept) {
  globalForBoot.__nexusBootRetentionSwept = true
  void runRetentionSweep().catch((err: unknown) => {
    console.error(
      JSON.stringify({
        layer: 'L0',
        component: 'retention.sweep',
        task_id: 'T-106',
        event: 'boot_sweep_error',
        message: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      }),
    )
  })
}

export async function GET(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied
  await ensureDbReady()

  const minuteAgo = new Date(Date.now() - 60_000)
  const [eventsPerMin, jobGroups, outboxGroups] = await Promise.all([
    db.event.count({ where: { ingestedAt: { gt: minuteAgo } } }),
    db.job.groupBy({ by: ['status'], _count: { _all: true } }),
    db.outbox.groupBy({
      by: ['status'],
      _count: { _all: true },
      where: { status: { in: ['pending', 'failed'] } },
    }),
  ])

  const jobs = { queued: 0, running: 0, succeeded: 0, failed: 0, deadletter: 0 }
  for (const g of jobGroups) {
    if (g.status in jobs) jobs[g.status as keyof typeof jobs] = g._count._all
  }

  const outbox = { pending: 0, failed: 0 }
  for (const g of outboxGroups) {
    if (g.status in outbox) outbox[g.status as keyof typeof outbox] = g._count._all
  }

  return NextResponse.json({
    eventsPerMin,
    jobs,
    outbox,
    ingestLatency: getIngestLatencyStats(), // {p50, p95, count}
    deadletterTotal: jobs.deadletter,
  })
}
