// /api/connectors/hyperbrowser/sessions — FR-15 session surface (T-205):
//   GET  — list ACTIVE cloud browser sessions (metadata allowlist only —
//          upstream wsEndpoint/connectUrl fields carry embedded auth tokens
//          and are dropped at the connector-module boundary; P7/ADR-002).
//   POST — create a session (budgeted upstream consumption; ConnectorRun
//          'session_create' with the session id — an ephemeral infra id, not
//          credential material). Response = { sessionId, status, startedAt? }.
//
// Both require a stored API key (else §11 `not_connected`). Session-gated;
// single error shape. The wss CDP transport itself stays parked (T-205 scope).

import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import {
  NotConnectedError,
  UpstreamError,
  createSession,
  getStoredKey,
  hyperbrowserErrorResponse,
  listActiveSessions,
  recordRun,
} from '@/lib/connectors/hyperbrowser'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 32_768

export async function GET(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied

  try {
    const stored = await getStoredKey()
    if (stored === null) throw new NotConnectedError()

    const sessions = await listActiveSessions(stored.key)
    return NextResponse.json({ items: sessions, masked: true })
  } catch (err) {
    if (err instanceof UpstreamError) {
      await recordRun('session_list', 'error', { summary: err.code })
    }
    return hyperbrowserErrorResponse(err)
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied

  // Body is intentionally optional/empty (default options); still size-capped
  // like every other route (32 KB) so the endpoint family stays uniform.
  const contentLength = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: { code: 'payload_too_large', message: `Request body exceeds ${MAX_BODY_BYTES} bytes` } },
      { status: 413 },
    )
  }

  try {
    const stored = await getStoredKey()
    if (stored === null) throw new NotConnectedError()

    const started = performance.now()
    const session = await createSession(stored.key)
    const latencyMs = Math.round(performance.now() - started)
    await recordRun('session_create', 'ok', {
      latencyMs,
      summary: `id:${session.id} status:${session.status || 'unknown'}`,
    })

    return NextResponse.json(
      {
        sessionId: session.id,
        status: session.status,
        ...(session.startedAt !== null ? { startedAt: session.startedAt } : {}),
        note: 'wss/CDP connect data is not returned by design — the browser endpoint stays server-side (P7)',
      },
      { status: 201 },
    )
  } catch (err) {
    if (err instanceof UpstreamError) {
      await recordRun('session_create', 'error', { summary: err.code })
    } else if (err instanceof NotConnectedError) {
      await recordRun('session_create', 'error', { summary: 'not_connected' })
    }
    return hyperbrowserErrorResponse(err)
  }
}
