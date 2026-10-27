// Typed API client for the panel (T-108). Single error shape (§11):
//   { error: { code, message, details? } }
// Success list shape: { items, nextSince? }. All requests are same-origin
// with credentials so the nexus_session cookie flows; any 401 triggers the
// registered unauthorized handler (PanelShell: toast + router.refresh()).
//
// No payload fragments are ever logged from here (RT-13) — errors carry
// server messages only.

// ---------------------------------------------------------------------------
// Types (derived from the live route shapes — read, not invented)
// ---------------------------------------------------------------------------

export interface Health {
  ok: boolean
  db: 'up' | 'down'
  version: string
  uptimeS: number
}

export interface Metrics {
  eventsPerMin: number
  jobs: { queued: number; running: number; succeeded: number; failed: number; deadletter: number }
  outbox: { pending: number; failed: number }
  ingestLatency: { p50: number; p95: number; count: number }
  deadletterTotal: number
}

export interface EventItem {
  id: number
  type: string
  source: string
  payloadVersion: number
  payload: unknown
  occurredAt: string
  ingestedAt: string
  synthetic: boolean
  idempotencyKey: string | null
}

export interface JobItem {
  id: number
  type: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'deadletter'
  payload: unknown
  checkpoint: unknown
  budgetMs: number | null
  attempts: number
  runId: string | null
  idempotencyKey: string | null
  artifactId: number | null
  startedAt: string | null
  endedAt: string | null
  lastError: string | null
  leaseUntil: string | null
  heartbeatAt: string | null
}

export interface ArtifactItem {
  id: number
  jobId: number | null
  kind: string
  path: string
  sha256: string
  bytes: number
  createdAt: string
}

export interface DlqOutboxRow {
  id: number
  eventId: number
  topic: string
  attempts: number
  lastError: string | null
  createdAt: string
  nextAttemptAt: string | null
}

export interface DlqJobRow {
  id: number
  type: string
  attempts: number
  lastError: string | null
  endedAt: string | null
}

export interface Dlq {
  outbox: DlqOutboxRow[]
  jobs: DlqJobRow[]
}

export interface SeedResult {
  eventsCreated: number
  jobsQueued: number
}

export interface BackupResult {
  backupId: number
  bytes: number
  sha256: string
  elapsedMs: number
}

export interface RetentionResult {
  eventsDeleted: number
  artifactsDeleted: number
  backupsPruned: number
}

export interface RedriveResult {
  kind: 'outbox' | 'job'
  id: number
  status: string
}

export interface EventQuery {
  since?: number
  before?: number
  limit?: number
  type?: string
  order?: 'asc' | 'desc'
}

export interface JobQuery {
  status?: string
  since?: number
  before?: number
  limit?: number
  order?: 'asc' | 'desc'
}

export interface ArtifactQuery {
  since?: number
  before?: number
  limit?: number
  order?: 'asc' | 'desc'
}

// ---------------------------------------------------------------------------
// Error normalization
// ---------------------------------------------------------------------------

export interface ErrorDetail {
  field: string
  issue: string
}

export class ApiError extends Error {
  status: number
  code: string
  details?: ErrorDetail[]

  constructor(status: number, code: string, message: string, details?: ErrorDetail[]) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

// ---------------------------------------------------------------------------
// 401 → unauthorized handler (registered once by PanelShell; burst-guarded
// so five parallel gated queries failing together produce ONE toast).
// ---------------------------------------------------------------------------

type UnauthorizedHandler = () => void

let unauthorizedHandler: UnauthorizedHandler | null = null
let lastUnauthorizedAt = 0

export function setUnauthorizedHandler(fn: UnauthorizedHandler): void {
  unauthorizedHandler = fn
}

function fireUnauthorized(): void {
  const now = Date.now()
  if (now - lastUnauthorizedAt < 3000) return
  lastUnauthorizedAt = now
  unauthorizedHandler?.()
}

// ---------------------------------------------------------------------------
// Core request helper
// ---------------------------------------------------------------------------

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: {
        ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
  } catch {
    // Network-level failure (server down, DNS, CORS). Normalize, never leak.
    throw new ApiError(0, 'network_error', 'Network error — is the server running?')
  }

  if (res.status === 401) {
    fireUnauthorized()
    throw new ApiError(401, 'unauthorized', 'Session required')
  }

  let body: unknown = null
  const text = await res.text()
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown
    } catch {
      if (!res.ok) {
        throw new ApiError(res.status, 'bad_response', `Unexpected non-JSON response (${res.status})`)
      }
      body = null
    }
  }

  if (!res.ok) {
    const err = (body as { error?: { code?: unknown; message?: unknown; details?: ErrorDetail[] } } | null)?.error
    throw new ApiError(
      res.status,
      typeof err?.code === 'string' ? err.code : 'http_error',
      typeof err?.message === 'string' ? err.message : `Request failed (${res.status})`,
      Array.isArray(err?.details) ? err.details : undefined,
    )
  }

  return body as T
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  const s = search.toString()
  return s.length > 0 ? `?${s}` : ''
}

// ---------------------------------------------------------------------------
// Typed endpoint functions
// ---------------------------------------------------------------------------

/** GET /api/health — public (FR-09). */
export function getHealth(): Promise<Health> {
  return request<Health>('/api/health')
}

/** GET /api/metrics — session-gated (FR-06 source). */
export function getMetrics(): Promise<Metrics> {
  return request<Metrics>('/api/metrics')
}

/** GET /api/events — session-gated (FR-02); v1.3: order/before tail reads. */
export function getEvents(params: EventQuery = {}): Promise<{ items: EventItem[]; nextSince?: number; nextBefore?: number }> {
  return request(`/api/events${qs({ since: params.since, before: params.before, limit: params.limit, type: params.type, order: params.order })}`)
}

/** GET /api/jobs — session-gated (FR-03); v1.3: order/before tail reads. */
export function getJobs(params: JobQuery = {}): Promise<{ items: JobItem[]; nextSince?: number; nextBefore?: number }> {
  return request(`/api/jobs${qs({ since: params.since, before: params.before, limit: params.limit, status: params.status, order: params.order })}`)
}

/** GET /api/artifacts — session-gated (FR-04); v1.3: order/before tail reads. */
export function getArtifacts(params: ArtifactQuery = {}): Promise<{ items: ArtifactItem[]; nextSince?: number; nextBefore?: number }> {
  return request(`/api/artifacts${qs({ since: params.since, before: params.before, limit: params.limit, order: params.order })}`)
}

/** URL for the raw artifact file (FR-04) — for <a href>, opened by the operator. */
export function getArtifactUrl(id: number): string {
  return `/api/artifacts/${id}`
}

/** GET /api/dev/dlq — session-gated (FR-31): failed outbox + deadletter jobs. */
export function getDlq(): Promise<Dlq> {
  return request<Dlq>('/api/dev/dlq')
}

/** POST /api/auth/login {password} — public; sets the nexus_session cookie. */
export function login(password: string): Promise<{ ok: true }> {
  return request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  })
}

/** POST /api/auth/logout — bumps session version, clears the cookie. */
export function logout(): Promise<{ ok: true }> {
  return request('/api/auth/logout', { method: 'POST' })
}

/** POST /api/dev/seed {count} — session-gated (FR-08). */
export function seed(count: number): Promise<SeedResult> {
  return request('/api/dev/seed', { method: 'POST', body: JSON.stringify({ count }) })
}

/** POST /api/dev/backup — session-gated (FR-28). */
export function backup(): Promise<BackupResult> {
  return request('/api/dev/backup', { method: 'POST' })
}

/** POST /api/dev/retention — session-gated (FR-31). */
export function retention(): Promise<RetentionResult> {
  return request('/api/dev/retention', { method: 'POST' })
}

/** POST /api/dev/redrive {kind, id} — session-gated (FR-31 v1.2). */
export function redrive(kind: 'outbox' | 'job', id: number): Promise<RedriveResult> {
  return request('/api/dev/redrive', { method: 'POST', body: JSON.stringify({ kind, id }) })
}
