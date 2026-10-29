// Event module — T-102. Implements spec §3 (envelope + payload registries,
// topic mapping, RT-12 server-side synthetic stamping), FR-01 dedupe (RT-11),
// and the FR-06 ingest-latency telemetry source (v1.2: rolling window).
//
// Registry is CODE-FROZEN (spec §3): unknown event types are rejected at
// validation; additions land via a PR, never via runtime data.

import { z } from 'zod'
import type { Event as EventRow } from '@prisma/client'
import { db, ensureDbReady, withWriteRetry } from '@/lib/db'

// Canonical DB init + busy-retry implementations live in @/lib/db (single
// source, T-101). Re-exported here so import sites stay stable.
export { ensureDbReady, withWriteRetry }

// ---------------------------------------------------------------------------
// Registry (frozen)
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  'viewer.sample',
  'ai.exchange',
  'job.lifecycle',
  'system.log',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export const EVENT_SOURCES = [
  'userscript',
  'panel',
  'pipeline',
  'seed',
] as const

export type EventSource = (typeof EVENT_SOURCES)[number]

const TOPIC_BY_TYPE: Record<EventType, 'viewer' | 'ai' | 'jobs' | 'system'> = {
  'viewer.sample': 'viewer',
  'ai.exchange': 'ai',
  'job.lifecycle': 'jobs',
  'system.log': 'system',
}

/** Pure type→topic mapping (frozen §3). Inverse of the outbox topic set. */
export function topicOf(type: EventType): 'viewer' | 'ai' | 'jobs' | 'system' {
  return TOPIC_BY_TYPE[type]
}

// ---------------------------------------------------------------------------
// Payload schemas (frozen, RT-06)
// ---------------------------------------------------------------------------

const viewerSamplePayload = z.object({
  viewers: z.number().int().min(0),
  channel: z.string().min(1).max(200),
})

const aiExchangePayload = z.object({
  prompt: z.string().max(2048),
  reply: z.string().max(8192),
  modelLabel: z.string().max(200),
  latencyMs: z.number().int().min(0),
  intent: z.string().max(200),
})

const jobLifecyclePayload = z.object({
  jobId: z.string().max(100),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'deadletter']),
  cause: z.string().max(200).optional(),
})

const systemLogPayload = z.object({
  level: z.enum(['info', 'warn', 'error']),
  component: z.string().max(100),
  message: z.string().max(500),
})

// ---------------------------------------------------------------------------
// Envelope schema
// ---------------------------------------------------------------------------

// ISO-8601 (date, time, optional fractional seconds, optional Z/±hh:mm offset)
// plus a real parseability check — "parseable ISO-8601" per the frozen contract.
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/

const occurredAt = z
  .string()
  .refine((s) => ISO_8601_RE.test(s) && !Number.isNaN(Date.parse(s)), {
    message: 'must be a parseable ISO-8601 timestamp',
  })

// Shared envelope fields. Zod object schemas strip unknown keys by default —
// exactly the frozen rule ("Unknown fields: strip, do not reject").
const envelopeFields = {
  source: z.enum(EVENT_SOURCES),
  payloadVersion: z.number().int().min(1).default(1), // default 1 if absent
  occurredAt,
  synthetic: z.boolean().default(false),
  idempotencyKey: z.string().max(200).optional(),
} as const

const envelopeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('viewer.sample'),
    payload: viewerSamplePayload,
    ...envelopeFields,
  }),
  z.object({
    type: z.literal('ai.exchange'),
    payload: aiExchangePayload,
    ...envelopeFields,
  }),
  z.object({
    type: z.literal('job.lifecycle'),
    payload: jobLifecyclePayload,
    ...envelopeFields,
  }),
  z.object({
    type: z.literal('system.log'),
    payload: systemLogPayload,
    ...envelopeFields,
  }),
])

export type ParsedPayload =
  | z.infer<typeof viewerSamplePayload>
  | z.infer<typeof aiExchangePayload>
  | z.infer<typeof jobLifecyclePayload>
  | z.infer<typeof systemLogPayload>

export interface ParsedEvent {
  type: EventType
  source: EventSource
  payloadVersion: number
  payload: ParsedPayload
  occurredAt: string
  synthetic: boolean
  idempotencyKey?: string
}

export interface ValidationIssue {
  field: string
  issue: string
}

export type ParseResult =
  | { ok: true; value: ParsedEvent }
  | { ok: false; message: string; details: ValidationIssue[] }

/** Validate a request body against the frozen envelope + payload registries. */
export function parseEventEnvelope(body: unknown): ParseResult {
  const result = envelopeSchema.safeParse(body)
  if (result.success) {
    const v = result.data
    return {
      ok: true,
      value: {
        type: v.type,
        source: v.source,
        payloadVersion: v.payloadVersion,
        payload: v.payload,
        occurredAt: v.occurredAt,
        synthetic: v.synthetic,
        idempotencyKey: v.idempotencyKey,
      },
    }
  }
  const details: ValidationIssue[] = result.error.issues.map((iss) => ({
    field: iss.path.length > 0 ? iss.path.join('.') : '(root)',
    issue: iss.message,
  }))
  return {
    ok: false,
    message: 'Event envelope failed validation',
    details,
  }
}

// ---------------------------------------------------------------------------
// Ingest latency telemetry (FR-06 / NFR-01; served later by /api/metrics)
// ---------------------------------------------------------------------------

const LATENCY_WINDOW_MAX = 500

const globalForTelemetry = globalThis as unknown as {
  __nexusIngestLatency: number[] | undefined
}

const latencyWindow: number[] =
  globalForTelemetry.__nexusIngestLatency ?? []
globalForTelemetry.__nexusIngestLatency = latencyWindow

/** Record one ingest latency sample (validation + insert path, ms). */
export function recordIngestLatency(ms: number): void {
  latencyWindow.push(ms)
  if (latencyWindow.length > LATENCY_WINDOW_MAX) latencyWindow.shift()
}

/** p50/p95 (nearest-rank) over the rolling window of the last 500 samples. */
export function getIngestLatencyStats(): { p50: number; p95: number; count: number } {
  const n = latencyWindow.length
  if (n === 0) return { p50: 0, p95: 0, count: 0 }
  const sorted = [...latencyWindow].sort((a, b) => a - b)
  const at = (p: number): number => sorted[Math.max(0, Math.ceil(p * n) - 1)]
  return { p50: at(0.5), p95: at(0.95), count: n }
}

// ---------------------------------------------------------------------------
// insertEvent — single transactional write path for producers
// (API route + internal emitters). Also the FR-01 dedupe implementation.
// ---------------------------------------------------------------------------

export interface InsertEventResult {
  event: EventRow
  deduped: boolean
}

function isP2002(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  )
}

async function findExistingByIdempotencyKey(
  key: string,
): Promise<EventRow | null> {
  return db.event.findUnique({ where: { idempotencyKey: key } })
}

/**
 * Persist one event + its outbox row in a single transaction.
 * Server rule RT-12: source==='seed' ⇒ synthetic=true regardless of body.
 * RT-11 race rule: on P2002 retry the insert once, then re-fetch by
 * idempotencyKey and report deduped — duplicates never throw.
 */
export async function insertEvent(parsed: ParsedEvent): Promise<InsertEventResult> {
  await ensureDbReady()

  // Fast path: key already present → dedupe without a write attempt.
  if (parsed.idempotencyKey) {
    const existing = await findExistingByIdempotencyKey(parsed.idempotencyKey)
    if (existing) return { event: existing, deduped: true }
  }

  // RT-12 server-side stamping — never trust the producer's synthetic flag.
  const synthetic = parsed.source === 'seed' ? true : parsed.synthetic
  const occurredAtDate = new Date(parsed.occurredAt)
  const data = {
    type: parsed.type,
    source: parsed.source,
    payloadVersion: parsed.payloadVersion,
    payload: parsed.payload,
    occurredAt: occurredAtDate,
    synthetic,
    ...(parsed.idempotencyKey !== undefined
      ? { idempotencyKey: parsed.idempotencyKey }
      : {}),
  }

  const runInsert = async (): Promise<EventRow> => {
    // Interactive transaction: the Outbox row needs the auto-increment eventId,
    // so both writes must share one transaction with a data dependency.
    return withWriteRetry(() =>
      db.$transaction(async (tx) => {
        const created = await tx.event.create({ data })
        await tx.outbox.create({
          data: {
            eventId: created.id,
            topic: topicOf(parsed.type),
            status: 'pending',
            nextAttemptAt: new Date(),
          },
        })
        return created
      }),
    )
  }

  try {
    const event = await runInsert()
    return { event, deduped: false }
  } catch (err) {
    if (!isP2002(err) || !parsed.idempotencyKey) throw err
    // RT-11: retry the insert exactly once before treating as deduped.
    try {
      const event = await runInsert()
      return { event, deduped: false }
    } catch (retryErr) {
      if (!isP2002(retryErr)) throw retryErr
      const existing = await findExistingByIdempotencyKey(parsed.idempotencyKey)
      if (existing) return { event: existing, deduped: true }
      throw retryErr
    }
  }
}
