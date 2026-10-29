// POST /api/dev/replay — FR-30 (RT-09), SESSION-GATED. Two phases:
//   A (consumers): re-deliver every event in [from..to] to all registered
//      consumers under the sandbox offset namespace `replay:<from>-<to>`
//      (outbox.replayEventsToConsumers — idempotent by offset, no outbox
//      writes, no job creation there: dispatch ownership stays with createJob).
//   B (artifacts): one sample.transform job per viewer.sample/ai.exchange
//      event in range, idempotencyKey `replay:<from>-<to>:<eventId>` — repeat
//      replays dedupe at create time, and artifact content determinism
//      (proven in T-105) yields identical sha256 sets per range.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db, ensureDbReady } from '@/lib/db'
import { createJob } from '@/lib/jobs'
import { replayEventsToConsumers } from '@/lib/outbox'
import { requireSession } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_RANGE = 1000

const replaySchema = z
  .object({
    fromEventId: z.number().int().min(1),
    toEventId: z.number().int().min(1),
  })
  .superRefine((v, ctx) => {
    if (v.fromEventId > v.toEventId) {
      ctx.addIssue({
        code: 'custom',
        path: ['fromEventId'],
        message: 'fromEventId must be <= toEventId',
      })
    } else if (v.toEventId - v.fromEventId + 1 > MAX_RANGE) {
      ctx.addIssue({
        code: 'custom',
        path: ['toEventId'],
        message: `range must cover at most ${MAX_RANGE} events`,
      })
    }
  })

function error(
  status: number,
  code: string,
  message: string,
  details?: Array<{ field: string; issue: string }>,
) {
  return NextResponse.json(
    { error: details ? { code, message, details } : { code, message } },
    { status },
  )
}

export async function POST(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied
  await ensureDbReady()

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return error(400, 'validation', 'Request body is not valid JSON', [
      { field: '(root)', issue: 'must be a JSON object' },
    ])
  }
  const parsed = replaySchema.safeParse(body)
  if (!parsed.success) {
    return error(400, 'validation', 'Replay request failed validation',
      parsed.error.issues.map((iss) => ({
        field: iss.path.length > 0 ? iss.path.join('.') : '(root)',
        issue: iss.message,
      })),
    )
  }
  const { fromEventId, toEventId } = parsed.data
  const namespace = `replay:${fromEventId}-${toEventId}`

  // Phase A — consumer redrive into the sandbox offset namespace.
  const consumerResult = await replayEventsToConsumers(fromEventId, toEventId, namespace)

  // Phase B — artifact jobs (dedupe makes repeat replays cheap).
  const events = await db.event.findMany({
    where: {
      id: { gte: fromEventId, lte: toEventId },
      type: { in: ['viewer.sample', 'ai.exchange'] },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  let jobsQueued = 0
  let jobsDeduped = 0
  for (const e of events) {
    const res = await createJob({
      type: 'sample.transform',
      payload: { eventId: e.id, replayOf: `${fromEventId}..${toEventId}` },
      idempotencyKey: `replay:${fromEventId}-${toEventId}:${e.id}`,
    })
    if (res.ok) {
      if (res.deduped) jobsDeduped += 1
      else jobsQueued += 1
    }
  }

  return NextResponse.json({ jobsQueued, jobsDeduped, consumerResult })
}
