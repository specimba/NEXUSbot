// Job runner — T-104. Implements FR-03 (create → run → artifact), FR-07
// (restart safety via checkpoint resume) and FR-27 (lease-expiry recovery
// sweep), plus loud budget enforcement (budget_exceeded, NFR-05).
//
// Frozen contracts (spec §3):
// - Checkpoint schema {step, stepIndex, outputs:{artifactId?, hashes[]}, updatedAt}
//   — every checkpoint write happens AFTER the durable effect it records.
// - Dispatch ownership: jobs are created ONLY via createJob (POST /api/jobs
//   now, internal replay later). The outbox NEVER creates jobs and this module
//   never touches outbox rows — the lifecycle/system events it emits enqueue
//   their own outbox rows through insertEvent (expected, not a violation).
// - Lifecycle payloads {jobId:string, status, cause?} with idempotencyKey
//   `jl:<jobId>:<status>` (replayed transitions dedupe; lifecycle events are
//   best-effort observability — the Job row is the truth).

import { z } from 'zod'
import type { Event as EventRow, Job as JobRow } from '@prisma/client'
import { db, ensureDbReady, withWriteRetry } from '@/lib/db'
import { insertEvent } from '@/lib/events'
import { verifyArtifact, writeArtifact } from '@/lib/artifacts'

// ---------------------------------------------------------------------------
// Registry (code-frozen)
// ---------------------------------------------------------------------------

export const JOB_TYPES = ['sample.transform'] as const
export type JobType = (typeof JOB_TYPES)[number]

export const JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'deadletter',
] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export const sampleTransformPayloadSchema = z.object({
  eventId: z.number().int().positive(),
  replayOf: z.string().max(100).optional(), // present on replay-created jobs (FR-30)
})
export type SampleTransformPayload = z.infer<typeof sampleTransformPayloadSchema>

// M1: single registered type. Widen per-entry when the registry grows.
const PAYLOAD_SCHEMAS: Record<JobType, typeof sampleTransformPayloadSchema> = {
  'sample.transform': sampleTransformPayloadSchema,
}

export interface ValidationIssue {
  field: string
  issue: string
}

export type JobPayloadParseResult =
  | { ok: true; value: SampleTransformPayload }
  | { ok: false; message: string; details: ValidationIssue[] }

/** Validate a job type + payload against the frozen registry. */
export function parseJobPayload(type: string, payload: unknown): JobPayloadParseResult {
  const schema = (JOB_TYPES as readonly string[]).includes(type)
    ? PAYLOAD_SCHEMAS[type as JobType]
    : undefined
  if (!schema) {
    return {
      ok: false,
      message: 'Job payload failed validation',
      details: [{ field: 'type', issue: `must be one of: ${JOB_TYPES.join(', ')}` }],
    }
  }
  const result = schema.safeParse(payload)
  if (result.success) return { ok: true, value: result.data }
  return {
    ok: false,
    message: 'Job payload failed validation',
    details: result.error.issues.map((iss) => ({
      field: iss.path.length > 0 ? iss.path.join('.') : '(root)',
      issue: iss.message,
    })),
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const LAST_ERROR_MAX = 500
const LIFECYCLE_CAUSE_MAX = 200

function errorMessage(err: unknown, max = 300): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.length > max ? msg.slice(0, max) : msg
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s
}

function isP2002(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  )
}

function logLine(event: string, extra: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      layer: 'L0',
      component: 'jobs.runner',
      task_id: 'T-104',
      event,
      ts: new Date().toISOString(),
      ...extra,
    }),
  )
}

/** Fire-and-forget lifecycle emission (deduped per `jl:<jobId>:<status>`). */
function emitJobLifecycle(jobId: number, status: JobStatus, cause?: string): void {
  void insertEvent({
    type: 'job.lifecycle',
    source: 'pipeline',
    payloadVersion: 1,
    payload: {
      jobId: String(jobId),
      status,
      ...(cause !== undefined ? { cause: truncate(cause, LIFECYCLE_CAUSE_MAX) } : {}),
    },
    occurredAt: new Date().toISOString(),
    synthetic: false,
    idempotencyKey: `jl:${jobId}:${status}`,
  }).catch((err: unknown) => {
    console.error(
      JSON.stringify({
        layer: 'L0',
        component: 'jobs.runner',
        task_id: 'T-104',
        event: 'lifecycle_emit_error',
        jobId,
        status,
        message: errorMessage(err),
        ts: new Date().toISOString(),
      }),
    )
  })
}

/** FR-27 recovery telemetry: one deduped system.log per sweep action. */
function emitRecoveryLog(
  jobId: number,
  attempts: number,
  action: 'requeued' | 'deadletter',
): void {
  void insertEvent({
    type: 'system.log',
    source: 'pipeline',
    payloadVersion: 1,
    payload: {
      level: action === 'deadletter' ? 'error' : 'warn',
      component: 'jobs.recovery',
      message: `lease_expired job ${jobId} attempts=${attempts} action=${action}`,
    },
    occurredAt: new Date().toISOString(),
    synthetic: false,
    idempotencyKey: `rec:${jobId}:${attempts}`,
  }).catch((err: unknown) => {
    console.error(
      JSON.stringify({
        layer: 'L0',
        component: 'jobs.runner',
        task_id: 'T-104',
        event: 'recovery_log_emit_error',
        jobId,
        action,
        message: errorMessage(err),
        ts: new Date().toISOString(),
      }),
    )
  })
}

// ---------------------------------------------------------------------------
// createJob — the ONLY writer of Job rows (dispatch ownership, spec §3)
// ---------------------------------------------------------------------------

// FR-03 GWT (frozen) exercises budgetMs:1 and expects a loud budget failure,
// so the accepted range floor is 1 — the 100..600000 band is guidance for
// production jobs, not a hard validation floor.
const BUDGET_MIN_MS = 1
const BUDGET_MAX_MS = 600_000

const createJobInputSchema = z.object({
  type: z.string().min(1),
  payload: z.unknown(),
  idempotencyKey: z.string().max(200).optional(),
  budgetMs: z.number().int().min(BUDGET_MIN_MS).max(BUDGET_MAX_MS).optional(),
  runId: z.string().max(100).optional(),
})

export interface CreateJobInput {
  type: string
  payload: unknown
  idempotencyKey?: string
  budgetMs?: number
  runId?: string
}

export type CreateJobResult =
  | { ok: true; job: JobRow; deduped: boolean }
  | { ok: false; message: string; details: ValidationIssue[] }

/**
 * Create a queued job. Unknown type / invalid payload / out-of-range budget →
 * validation result (route maps to 400). Duplicate idempotencyKey → the
 * existing row with deduped:true (fast-path check + P2002 race rule, RT-11
 * style — never throws on duplicates).
 */
export async function createJob(input: unknown): Promise<CreateJobResult> {
  await ensureDbReady()

  const parsedInput = createJobInputSchema.safeParse(input)
  if (!parsedInput.success) {
    return {
      ok: false,
      message: 'Job request failed validation',
      details: parsedInput.error.issues.map((iss) => ({
        field: iss.path.length > 0 ? iss.path.join('.') : '(root)',
        issue: iss.message,
      })),
    }
  }
  const { type, payload, idempotencyKey, budgetMs, runId } = parsedInput.data

  const payloadResult = parseJobPayload(type, payload)
  if (!payloadResult.ok) return payloadResult

  if (idempotencyKey !== undefined) {
    const existing = await db.job.findUnique({ where: { idempotencyKey } })
    if (existing) return { ok: true, job: existing, deduped: true }
  }

  const data = {
    type,
    status: 'queued' as const,
    payload: payloadResult.value,
    ...(budgetMs !== undefined ? { budgetMs } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  }
  try {
    const job = await withWriteRetry(() => db.job.create({ data }))
    return { ok: true, job, deduped: false }
  } catch (err) {
    if (!isP2002(err) || idempotencyKey === undefined) throw err
    // Concurrent same-key create: re-fetch and report deduped.
    const existing = await db.job.findUnique({ where: { idempotencyKey } })
    if (existing) return { ok: true, job: existing, deduped: true }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Runner loop (in-process, single-writer topology — spec §12)
// ---------------------------------------------------------------------------

const TICK_MS = 1_000
const LEASE_MS = 15_000 // frozen spec §3: lease 15s, heartbeat ~5s cadence
const MAX_ATTEMPTS = 3 // FR-27: > 3 attempts → deadletter
const SWEEP_BATCH = 50

const globalForJobs = globalThis as unknown as {
  __nexusJobsStarted: boolean | undefined
  __nexusJobsTicking: boolean | undefined
}

export type CheckpointShape = {
  step: string
  stepIndex: number
  outputs: { artifactId?: number; hashes: string[] }
  updatedAt: string
}

function makeCheckpoint(
  step: string,
  stepIndex: number,
  outputs: { artifactId?: number; hashes: string[] },
): CheckpointShape {
  return { step, stepIndex, outputs, updatedAt: new Date().toISOString() }
}

function parseCheckpoint(raw: unknown): CheckpointShape | null {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown
    } catch {
      return null
    }
  }
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.step !== 'string' || typeof v.stepIndex !== 'number') return null
  if (!Number.isInteger(v.stepIndex) || v.stepIndex < 0) return null
  const rawOutputs =
    typeof v.outputs === 'object' && v.outputs !== null
      ? (v.outputs as Record<string, unknown>)
      : {}
  const outputs: CheckpointShape['outputs'] = {
    hashes: Array.isArray(rawOutputs.hashes)
      ? rawOutputs.hashes.filter((h): h is string => typeof h === 'string')
      : [],
  }
  if (typeof rawOutputs.artifactId === 'number' && Number.isInteger(rawOutputs.artifactId)) {
    outputs.artifactId = rawOutputs.artifactId
  }
  return { step: v.step, stepIndex: v.stepIndex, outputs }
}

async function heartbeat(jobId: number): Promise<void> {
  const now = new Date()
  await withWriteRetry(() =>
    db.job.update({
      where: { id: jobId },
      data: { heartbeatAt: now, leaseUntil: new Date(now.getTime() + LEASE_MS) },
    }),
  )
}

async function writeCheckpointRow(jobId: number, checkpoint: CheckpointShape): Promise<void> {
  await withWriteRetry(() => db.job.update({ where: { id: jobId }, data: { checkpoint } }))
}

/**
 * FR-27 sweep: `running` jobs with an expired lease get attempts+1 —
 * beyond MAX_ATTEMPTS → `deadletter` (loud), otherwise requeued (resumed from
 * their checkpoint on the next claim). One deduped system.log per action.
 */
async function sweepExpiredLeases(now: Date): Promise<void> {
  const expired = await db.job.findMany({
    where: { status: 'running', leaseUntil: { lt: now } },
    orderBy: { id: 'asc' },
    take: SWEEP_BATCH,
  })
  for (const job of expired) {
    const attempts = job.attempts + 1
    if (attempts > MAX_ATTEMPTS) {
      const res = await withWriteRetry(() =>
        db.job.updateMany({
          where: { id: job.id, status: 'running' },
          data: {
            status: 'deadletter',
            attempts,
            lastError: 'lease_expired',
            endedAt: now,
            leaseUntil: null,
          },
        }),
      )
      if (res.count > 0) {
        emitJobLifecycle(job.id, 'deadletter', 'lease_expired')
        emitRecoveryLog(job.id, attempts, 'deadletter')
        logLine('recovered_deadletter', { jobId: job.id, attempts })
      }
    } else {
      const res = await withWriteRetry(() =>
        db.job.updateMany({
          where: { id: job.id, status: 'running' },
          data: {
            status: 'queued',
            attempts,
            lastError: 'lease_expired',
            leaseUntil: null,
          },
        }),
      )
      if (res.count > 0) {
        emitRecoveryLog(job.id, attempts, 'requeued')
        logLine('recovered_requeue', { jobId: job.id, attempts })
      }
    }
  }
}

/**
 * Claim the oldest queued job. attempts increments ONLY on a job's first-ever
 * claim (attempts === 0); post-recovery claims continue the attempt the sweep
 * already accounted for (checkpoint-resume keeps the same attempt number).
 */
async function claimNextJob(now: Date): Promise<JobRow | null> {
  const candidate = await db.job.findFirst({
    where: { status: 'queued' },
    orderBy: { id: 'asc' },
  })
  if (!candidate) return null
  const attempts = candidate.attempts === 0 ? candidate.attempts + 1 : candidate.attempts
  const res = await withWriteRetry(() =>
    db.job.updateMany({
      where: { id: candidate.id, status: 'queued' },
      data: {
        status: 'running',
        startedAt: now,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        heartbeatAt: now,
        attempts,
      },
    }),
  )
  if (res.count === 0) return null
  emitJobLifecycle(candidate.id, 'running')
  return db.job.findUnique({ where: { id: candidate.id } })
}

/**
 * Deterministic artifact content (FR-30 determinism at the job level):
 * explicit literal key order, occurredAt from the EVENT (stable), NO
 * wall-clock fields, 2-space pretty print. Two jobs over the same event
 * produce byte-identical content → identical sha256.
 */
function buildArtifactContent(event: EventRow, payload: SampleTransformPayload): string {
  const body: Record<string, unknown> = {
    kind: 'sample.transform',
    eventId: event.id,
    eventType: event.type,
    occurredAt: event.occurredAt.toISOString(),
    payload: event.payload,
  }
  if (payload.replayOf !== undefined) body.replayOf = payload.replayOf
  return JSON.stringify(body, null, 2)
}

async function failJob(job: JobRow, cause: string): Promise<void> {
  const lastError = truncate(cause, LAST_ERROR_MAX)
  await withWriteRetry(() =>
    db.job.update({
      where: { id: job.id },
      data: { status: 'failed', lastError, endedAt: new Date(), leaseUntil: null },
    }),
  )
  emitJobLifecycle(job.id, 'failed', lastError)
  logLine('job_failed', { jobId: job.id, cause: truncate(lastError, LIFECYCLE_CAUSE_MAX) })
}

/**
 * Execute one claimed job with CHECKPOINT-AFTER-EFFECT discipline:
 * step 0 load-event (checkpoint after the load) → step 1 transform
 * (deterministic content; checkpoint captures intent) → step 2 write-artifact
 * (file first via writeArtifact, then artifactId + checkpoint in one atomic
 * Job update). Resume: a step-2 checkpoint reuses its artifact when the row
 * still exists and the file verifies; steps ≤ checkpoint.stepIndex are skipped.
 */
async function runJob(job: JobRow): Promise<void> {
  const parsed = parseJobPayload(job.type, job.payload)
  if (!parsed.ok) {
    await failJob(job, 'payload_invalid')
    return
  }
  const payload = parsed.value
  const startedMs = job.startedAt?.getTime() ?? Date.now()
  const cp = parseCheckpoint(job.checkpoint)
  const overBudget = (): boolean =>
    job.budgetMs !== null && job.budgetMs !== undefined && Date.now() - startedMs > job.budgetMs

  let artifactId: number | null = null

  await heartbeat(job.id)

  // FR-07 resume: a step-2 checkpoint proves the artifact was durably written.
  if (cp && cp.stepIndex >= 2 && typeof cp.outputs.artifactId === 'number') {
    const row = await db.artifact.findUnique({ where: { id: cp.outputs.artifactId } })
    if (row) {
      const verdict = await verifyArtifact(row) // emits integrity event if broken
      if (verdict.ok) {
        artifactId = row.id
        logLine('resumed_artifact', { jobId: job.id, artifactId: row.id })
      }
    }
  }

  if (artifactId === null) {
    // Boundary → step 0: load-event.
    if (overBudget()) {
      await failJob(job, 'budget_exceeded')
      return
    }
    const event = await db.event.findUnique({ where: { id: payload.eventId } })
    if (!event) {
      await failJob(job, 'event_not_found')
      return
    }
    if (!cp || cp.stepIndex < 0) {
      await writeCheckpointRow(job.id, makeCheckpoint('load-event', 0, { hashes: [] }))
    }
    await heartbeat(job.id)

    // Boundary → step 1: transform (deterministic rebuild is byte-identical).
    if (overBudget()) {
      await failJob(job, 'budget_exceeded')
      return
    }
    const content = buildArtifactContent(event, payload)
    if (!cp || cp.stepIndex < 1) {
      await writeCheckpointRow(job.id, makeCheckpoint('transform', 1, { hashes: [] }))
    }
    await heartbeat(job.id)

    // Boundary → step 2: write-artifact. File first (writeArtifact), then
    // artifactId + checkpoint land together in ONE atomic Job update.
    if (overBudget()) {
      await failJob(job, 'budget_exceeded')
      return
    }
    const artifactRow = await writeArtifact({ kind: 'sample.transform', content, jobId: job.id })
    const aid = artifactRow.id
    artifactId = aid
    // Checkpoint step 2 records the sha256 already persisted on the Artifact row.
    await withWriteRetry(() =>
      db.job.update({
        where: { id: job.id },
        data: {
          artifactId: aid,
          checkpoint: makeCheckpoint('write-artifact', 2, {
            artifactId: aid,
            hashes: [artifactRow.sha256],
          }),
        },
      }),
    )
    logLine('artifact_written', { jobId: job.id, artifactId: aid })
  }

  await withWriteRetry(() =>
    db.job.update({
      where: { id: job.id },
      data: {
        status: 'succeeded',
        endedAt: new Date(),
        artifactId,
        lastError: null,
        leaseUntil: null,
      },
    }),
  )
  emitJobLifecycle(job.id, 'succeeded')
  logLine('job_succeeded', { jobId: job.id, artifactId })
}

async function tick(): Promise<void> {
  if (globalForJobs.__nexusJobsTicking) return // single in-flight tick; overlap skipped
  globalForJobs.__nexusJobsTicking = true
  try {
    await ensureDbReady()
    await sweepExpiredLeases(new Date())
    const job = await claimNextJob(new Date())
    if (!job) return
    logLine('claimed', { jobId: job.id, type: job.type, attempts: job.attempts })
    try {
      await runJob(job)
    } catch (err) {
      // Unexpected execution error → loud per-job failure (NFR-05); the row
      // never stays silently running.
      try {
        await failJob(job, `execution_error: ${errorMessage(err)}`)
      } catch (failErr) {
        logLine('fail_job_error', {
          jobId: job.id,
          message: errorMessage(failErr),
        })
      }
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        layer: 'L0',
        component: 'jobs.runner',
        task_id: 'T-104',
        event: 'tick_error',
        message: errorMessage(err),
        ts: new Date().toISOString(),
      }),
    )
  } finally {
    globalForJobs.__nexusJobsTicking = false
  }
}

/**
 * Start the runner loop. Idempotent (globalThis guard survives HMR); inert
 * outside the Node.js server runtime; timer unref'd so it never blocks exit.
 * The FR-27 recovery sweep runs on every tick, so boot recovery happens on
 * the first tick after a fresh process start.
 */
export function startRunner(): void {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (globalForJobs.__nexusJobsStarted) return
  globalForJobs.__nexusJobsStarted = true
  const timer = setInterval(() => {
    void tick()
  }, TICK_MS) as unknown as { unref?: () => void }
  timer.unref?.()
  logLine('started', { intervalMs: TICK_MS, leaseMs: LEASE_MS, jobTypes: [...JOB_TYPES] })
}

/** Convenience export for route modules (import side effect is standard here). */
export function ensureRunnerRunning(): void {
  startRunner()
}
