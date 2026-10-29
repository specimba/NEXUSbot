// /api/connectors/hyperbrowser/sessions/[id] — FR-15 session surface (T-205):
//   GET    — session status/poll (metadata allowlist only; upstream 404 →
//            honest 404 not_found on OUR side).
//   DELETE — stop the session (ConnectorRun 'session_stop').
//
// Session ids are ephemeral infra ids (not credential material) but are
// shape-gated before use so arbitrary junk never reaches the upstream path.
// Session-gated; single error shape. wss/CDP stays parked (T-205 scope).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import {
  NotConnectedError,
  UpstreamError,
  getStoredKey,
  getSessionStatus,
  hyperbrowserErrorResponse,
  recordRun,
  stopSession,
} from '@/lib/connectors/hyperbrowser'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

interface ErrorBody {
  error: {
    code: string
    message: string
    details?: Array<{ field: string; issue: string }>
  }
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: Array<{ field: string; issue: string }>,
): NextResponse<ErrorBody> {
  const body: ErrorBody = {
    error: details ? { code, message, details } : { code, message },
  }
  return NextResponse.json(body, { status })
}

const idSchema = z.string().trim().min(1).max(128)

async function resolveId(ctx: { params: Promise<{ id: string }> }): Promise<
  { ok: true; id: string } | { ok: false; res: NextResponse }
> {
  const { id } = await ctx.params
  const parsed = idSchema.safeParse(id)
  if (!parsed.success || !ID_RE.test(parsed.data)) {
    return {
      ok: false,
      res: errorResponse(400, 'validation', 'Session id failed validation', [
        { field: 'id', issue: 'must be 1..128 chars of [A-Za-z0-9_-]' },
      ]),
    }
  }
  return { ok: true, id: parsed.data }
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireSession(req)
  if (denied) return denied

  const resolved = await resolveId(ctx)
  if (!resolved.ok) return resolved.res

  try {
    const stored = await getStoredKey()
    if (stored === null) throw new NotConnectedError()

    const session = await getSessionStatus(stored.key, resolved.id)
    if (session === null) {
      return errorResponse(404, 'not_found', 'No such session upstream (or it has already ended)')
    }
    return NextResponse.json({
      sessionId: session.id,
      status: session.status,
      ...(session.startedAt !== null ? { startedAt: session.startedAt } : {}),
      ...(session.endedAt !== null ? { endedAt: session.endedAt } : {}),
    })
  } catch (err) {
    return hyperbrowserErrorResponse(err)
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireSession(req)
  if (denied) return denied

  const resolved = await resolveId(ctx)
  if (!resolved.ok) return resolved.res

  try {
    const stored = await getStoredKey()
    if (stored === null) throw new NotConnectedError()

    const started = performance.now()
    await stopSession(stored.key, resolved.id)
    const latencyMs = Math.round(performance.now() - started)
    await recordRun('session_stop', 'ok', { latencyMs, summary: `id:${resolved.id}` })

    return NextResponse.json({ ok: true, sessionId: resolved.id, stopped: true })
  } catch (err) {
    if (err instanceof UpstreamError) {
      await recordRun('session_stop', 'error', { summary: `${err.code} id:${resolved.id}` })
    }
    return hyperbrowserErrorResponse(err)
  }
}
