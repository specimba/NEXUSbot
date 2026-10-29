// Outbox + consumer loop — T-103. Implements FR-05 (at-least-once fan-out via
// Outbox rows, per-(topic,consumer) offsets, retry with backoff → visible
// `failed` DLQ state, never dropped) and the §3 topic mapping / dispatch
// ownership: this loop NEVER creates jobs; the `jobs` topic consumer in M1 is
// the audit logger only. Job creation belongs exclusively to POST /api/jobs.
//
// M1 consumer registry (frozen): {audit} on all four topics. Handler effects
// are structured log lines (plan §3 — observability inside the substrate).
// Payload fragments are NEVER logged (RT-13); the single exception is
// `system.log` level+message, which IS the substrate's own telemetry.

import type { Event as EventRow } from '@prisma/client'
import { db, ensureDbReady } from '@/lib/db'
// withWriteRetry + topicOf live in events.ts (topicOf = frozen type→topic map).
import { topicOf, withWriteRetry, type EventType } from '@/lib/events'

export type Topic = 'viewer' | 'ai' | 'jobs' | 'system'

export interface DeliveryContext {
  topic: Topic
  consumerName: string
}

export type ConsumerHandler = (
  event: EventRow,
  ctx: DeliveryContext,
) => void | Promise<void>

interface Consumer {
  name: string
  handler: ConsumerHandler
}

// ---------------------------------------------------------------------------
// Consumer registry
// ---------------------------------------------------------------------------

const globalForOutbox = globalThis as unknown as {
  __nexusOutboxRegistry: Map<Topic, Consumer[]> | undefined
  __nexusOutboxStarted: boolean | undefined
  __nexusOutboxTicking: boolean | undefined
  __nexusOutboxTickCount: number | undefined
}

const consumers: Map<Topic, Consumer[]> =
  globalForOutbox.__nexusOutboxRegistry ?? new Map()
globalForOutbox.__nexusOutboxRegistry = consumers

/** Register a consumer on a topic. Duplicate (topic, name) replaces the handler. */
export function registerConsumer(
  topic: Topic,
  name: string,
  handler: ConsumerHandler,
): void {
  const list = consumers.get(topic) ?? []
  const existing = list.findIndex((c) => c.name === name)
  if (existing >= 0) list[existing] = { name, handler }
  else list.push({ name, handler })
  consumers.set(topic, list)
}

function consumersFor(topic: string): Consumer[] {
  return consumers.get(topic as Topic) ?? []
}

// ---------------------------------------------------------------------------
// M1 consumer: audit (registered on ALL topics at module load)
// ---------------------------------------------------------------------------

function systemLogFields(
  payload: unknown,
): { level?: string; message?: string } {
  if (typeof payload !== 'object' || payload === null) return {}
  const p = payload as Record<string, unknown>
  const fields: { level?: string; message?: string } = {}
  if (typeof p.level === 'string') fields.level = p.level
  if (typeof p.message === 'string') fields.message = p.message
  return fields
}

registerConsumer('viewer', 'audit', (event, ctx) => {
  console.log(
    JSON.stringify({
      layer: 'L0',
      component: 'outbox.audit',
      task_id: 'T-103',
      topic: ctx.topic,
      eventId: event.id,
      type: event.type,
      ts: new Date().toISOString(),
    }),
  )
})

registerConsumer('ai', 'audit', (event, ctx) => {
  console.log(
    JSON.stringify({
      layer: 'L0',
      component: 'outbox.audit',
      task_id: 'T-103',
      topic: ctx.topic,
      eventId: event.id,
      type: event.type,
      ts: new Date().toISOString(),
    }),
  )
})

registerConsumer('jobs', 'audit', (event, ctx) => {
  console.log(
    JSON.stringify({
      layer: 'L0',
      component: 'outbox.audit',
      task_id: 'T-103',
      topic: ctx.topic,
      eventId: event.id,
      type: event.type,
      ts: new Date().toISOString(),
    }),
  )
})

registerConsumer('system', 'audit', (event, ctx) => {
  // system.log is the substrate's own telemetry (plan §3): level + message are
  // observability fields, not payload fragments. Nothing else is logged.
  const { level, message } = systemLogFields(event.payload)
  console.log(
    JSON.stringify({
      layer: 'L0',
      component: 'outbox.audit',
      task_id: 'T-103',
      topic: ctx.topic,
      eventId: event.id,
      type: event.type,
      ts: new Date().toISOString(),
      level,
      message,
    }),
  )
})

// ---------------------------------------------------------------------------
// Delivery loop (FR-05)
// ---------------------------------------------------------------------------

const TICK_INTERVAL_MS = 1_000
const BATCH_SIZE = 20
const MAX_ATTEMPTS = 5
const MAX_BACKOFF_MS = 60_000
const LAST_ERROR_MAX = 500

function truncateError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.length > LAST_ERROR_MAX ? msg.slice(0, LAST_ERROR_MAX) : msg
}

async function loadClaimedBatch(): Promise<OutboxRow[]> {
  return withWriteRetry(() =>
    db.outbox.findMany({
      where: {
        status: 'pending',
        nextAttemptAt: { lte: new Date() },
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
    }),
  )
}

type OutboxRow = Awaited<ReturnType<typeof loadClaimedBatch>>[number]

/**
 * Deliver one outbox row to every consumer on its topic, honoring offsets.
 * Handler errors mutate the OUTBOX row (backoff / DLQ), never the offsets —
 * consumers already delivered keep their offset and are skipped on redelivery.
 */
async function deliverRow(row: OutboxRow): Promise<void> {
  try {
    const event = await db.event.findUnique({ where: { id: row.eventId } })
    if (!event) {
      // Retention removes outbox rows before events (schema contract); a
      // dangling row is corruption → route it to the visible DLQ, never drop.
      throw new Error(`event ${row.eventId} missing for outbox row ${row.id}`)
    }

    for (const consumer of consumersFor(row.topic)) {
      const offset = await withWriteRetry(() =>
        db.consumerOffset.findUnique({
          where: { topic_consumer: { topic: row.topic, consumer: consumer.name } },
        }),
      )
      if (offset && offset.lastEventId >= event.id) continue // already delivered

      await consumer.handler(event, {
        topic: row.topic as Topic,
        consumerName: consumer.name,
      })

      // Offset written AFTER the durable handler effect (at-least-once).
      await withWriteRetry(() =>
        db.consumerOffset.upsert({
          where: {
            topic_consumer: { topic: row.topic, consumer: consumer.name },
          },
          create: {
            topic: row.topic,
            consumer: consumer.name,
            lastEventId: event.id,
          },
          update: { lastEventId: event.id },
        }),
      )
    }

    await withWriteRetry(() =>
      db.outbox.update({ where: { id: row.id }, data: { status: 'done' } }),
    )
  } catch (err) {
    // Failure path: retry semantics live on the OUTBOX row.
    const attempts = row.attempts + 1
    const backoffMs = Math.min(2 ** attempts * 1000, MAX_BACKOFF_MS)
    const failed = attempts >= MAX_ATTEMPTS
    await withWriteRetry(() =>
      db.outbox.update({
        where: { id: row.id },
        data: {
          attempts,
          lastError: truncateError(err),
          nextAttemptAt: new Date(Date.now() + backoffMs),
          ...(failed ? { status: 'failed' } : {}),
        },
      }),
    )
  }
}

async function tick(): Promise<void> {
  if (globalForOutbox.__nexusOutboxTicking) return // single in-flight tick; overlap skipped, not queued
  globalForOutbox.__nexusOutboxTicking = true
  try {
    globalForOutbox.__nexusOutboxTickCount =
      (globalForOutbox.__nexusOutboxTickCount ?? 0) + 1
    const tickNo = globalForOutbox.__nexusOutboxTickCount
    // Heartbeat on the first tick and every 30th — proves the timer fires
    // without flooding the log (NFR-06 structured line).
    if (tickNo === 1 || tickNo % 30 === 0) {
      console.log(
        JSON.stringify({
          layer: 'L0',
          component: 'outbox.loop',
          task_id: 'T-103',
          event: 'tick',
          tickNo,
          ts: new Date().toISOString(),
        }),
      )
    }
    const batch = await loadClaimedBatch()
    if (batch.length > 0) {
      console.log(
        JSON.stringify({
          layer: 'L0',
          component: 'outbox.loop',
          task_id: 'T-103',
          event: 'claimed',
          rows: batch.length,
          ts: new Date().toISOString(),
        }),
      )
    }
    for (const row of batch) {
      await deliverRow(row)
    }
  } catch (err) {
    // Claim-level failure (e.g. persistent busy): leave rows untouched; the
    // next tick retries. Never crash the loop — but never fail silently
    // either (NFR-05: no silent drops).
    console.error(
      JSON.stringify({
        layer: 'L0',
        component: 'outbox.loop',
        task_id: 'T-103',
        event: 'tick_error',
        message: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      }),
    )
  } finally {
    globalForOutbox.__nexusOutboxTicking = false
  }
}

/**
 * Start the delivery loop. Idempotent (globalThis guard survives HMR);
 * inert outside the Node.js server runtime; timer unref'd so it never
 * blocks process exit.
 */
export function startOutbox(): void {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (globalForOutbox.__nexusOutboxStarted) return
  globalForOutbox.__nexusOutboxStarted = true
  const timer = setInterval(() => {
    void tick()
  }, TICK_INTERVAL_MS) as unknown as { unref?: () => void }
  timer.unref?.()
  console.log(
    JSON.stringify({
      layer: 'L0',
      component: 'outbox.loop',
      task_id: 'T-103',
      event: 'started',
      intervalMs: TICK_INTERVAL_MS,
      runtime: process.env.NEXT_RUNTIME,
      consumers: [...consumers.entries()].map(([topic, list]) => ({
        topic,
        names: list.map((c) => c.name),
      })),
      ts: new Date().toISOString(),
    }),
  )
}

/** Convenience export for route modules (import side effect is standard here). */
export function ensureOutboxRunning(): void {
  startOutbox()
}

// ---------------------------------------------------------------------------
// Replay (FR-30, T-106) — sandbox-namespace consumer redrive
// ---------------------------------------------------------------------------

/**
 * Re-deliver every event in [fromEventId..toEventId] to all registered
 * consumers on its topic, tracked under ConsumerOffset rows keyed
 * (topic, `${namespace}@${consumerName}`) — the sandbox offset namespace
 * (FR-30). Idempotent by offset: a consumer whose replay offset already
 * covers an event is skipped. Reuses the SAME registry/handler effects as
 * live delivery (offset upsert happens AFTER the handler effect —
 * at-least-once). Never touches outbox rows and never creates jobs
 * (dispatch ownership, spec §3).
 */
export async function replayEventsToConsumers(
  fromEventId: number,
  toEventId: number,
  namespace: string,
): Promise<{ delivered: number; skipped: number }> {
  await ensureDbReady()

  const events = await db.event.findMany({
    where: { id: { gte: fromEventId, lte: toEventId } },
    orderBy: { id: 'asc' },
  })

  let delivered = 0
  let skipped = 0
  for (const event of events) {
    const topic = topicOf(event.type as EventType)
    for (const consumer of consumersFor(topic)) {
      const replayConsumerName = `${namespace}@${consumer.name}`
      const offset = await withWriteRetry(() =>
        db.consumerOffset.findUnique({
          where: {
            topic_consumer: { topic, consumer: replayConsumerName },
          },
        }),
      )
      if (offset && offset.lastEventId >= event.id) {
        skipped += 1
        continue
      }

      await consumer.handler(event, {
        topic,
        consumerName: replayConsumerName,
      })

      // Offset AFTER the durable handler effect (at-least-once).
      await withWriteRetry(() =>
        db.consumerOffset.upsert({
          where: {
            topic_consumer: { topic, consumer: replayConsumerName },
          },
          create: {
            topic,
            consumer: replayConsumerName,
            lastEventId: event.id,
          },
          update: { lastEventId: event.id },
        }),
      )
      delivered += 1
    }
  }
  return { delivered, skipped }
}
