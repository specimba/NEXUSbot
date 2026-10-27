// POST /api/dev/seed — FR-08 synthetic load generator, SESSION-GATED (RT-02:
// never public, count ≤ 500). Inserts `count` synthetic events via
// insertEvent (RT-12 stamps synthetic server-side: source='seed') — ~60%
// viewer.sample, ~40% ai.exchange — then queues sample.transform jobs over
// the FIRST seeded events. Run-scoped idempotency keys make every call fresh.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { insertEvent, type ParsedEvent } from '@/lib/events'
import { createJob } from '@/lib/jobs'
import { requireSession, runToken } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const seedSchema = z.object({ count: z.number().int().min(1).max(500) })

function error(status: number, code: string, message: string, details?: Array<{ field: string; issue: string }>) {
  return NextResponse.json(
    { error: details ? { code, message, details } : { code, message } },
    { status },
  )
}

export async function POST(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return error(400, 'validation', 'Request body is not valid JSON', [
      { field: '(root)', issue: 'must be a JSON object' },
    ])
  }
  const parsedBody = seedSchema.safeParse(body)
  if (!parsedBody.success) {
    return error(400, 'validation', 'Seed request failed validation', [
      { field: 'count', issue: 'must be an integer between 1 and 500' },
    ])
  }
  const count = parsedBody.data.count
  const token = runToken()

  // Synthetic event mix: ~60% viewer.sample, ~40% ai.exchange.
  const eventIds: number[] = []
  let eventsCreated = 0
  for (let i = 0; i < count; i++) {
    const isViewer = i % 5 < 3
    const occurredAt = new Date().toISOString()
    const base = {
      source: 'seed' as const,
      payloadVersion: 1,
      occurredAt,
      synthetic: true, // RT-12 re-stamps server-side regardless
      idempotencyKey: `seed:${token}:${i}`,
    }
    const parsed: ParsedEvent = isViewer
      ? {
          type: 'viewer.sample',
          payload: {
            viewers: 100 + Math.floor(Math.random() * 19_900),
            channel: 'speci',
          },
          ...base,
        }
      : {
          type: 'ai.exchange',
          payload: {
            prompt: `seed prompt #${i}`,
            reply: `seed reply #${i}`,
            modelLabel: 'seed-model',
            latencyMs: 50 + Math.floor(Math.random() * 850),
            intent: 'seed',
          },
          ...base,
        }
    const { event, deduped } = await insertEvent(parsed)
    if (!deduped) eventsCreated += 1
    eventIds.push(event.id)
  }

  // Sample jobs over the FIRST seeded events (dispatch ownership: createJob
  // is the only sanctioned writer of Job rows, spec §3).
  const jobCount = Math.min(Math.max(1, Math.floor(count / 50)), 10)
  let jobsQueued = 0
  for (let n = 0; n < jobCount; n++) {
    const eventId = eventIds[n]
    if (eventId === undefined) break
    const res = await createJob({
      type: 'sample.transform',
      payload: { eventId },
      idempotencyKey: `seed-job:${token}:${n}`,
    })
    if (res.ok && !res.deduped) jobsQueued += 1
  }

  return NextResponse.json({ eventsCreated, jobsQueued })
}
