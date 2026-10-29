// /api/connectors/hyperbrowser/health — live Hyperbrowser API probe (T-205,
// FR-15).
//
// GET — requires a stored API key (else §11 `not_connected`); calls
// GET https://api.hyperbrowser.ai/api/v1/session/active through the connector
// client: 10 s timeout, conservative 60 req/min local budget (no documented
// upstream limit in research R3 — choice recorded), result cached in-memory
// 60 s per vault keyId. Success → ConnectorRun 'health_check' (ok + latencyMs)
// and an honest usage line: the active-session count (this endpoint exposes no
// plan-quota data). Invalid key → typed `upstream_unauthorized` (401-class);
// rate-limited → `upstream_rate_limited` (Retry-After honored).

import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import {
  NotConnectedError,
  UpstreamError,
  getStoredKey,
  healthCheck,
  hyperbrowserErrorResponse,
  recordRun,
} from '@/lib/connectors/hyperbrowser'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied

  try {
    const stored = await getStoredKey()
    if (stored === null) throw new NotConnectedError()

    const result = await healthCheck(stored.key, stored.keyId)

    if (!result.cached) {
      await recordRun('health_check', 'ok', {
        latencyMs: result.latencyMs,
        summary: `activeSessions:${result.activeSessions}`,
      })
    }

    return NextResponse.json({
      ok: true,
      activeSessions: result.activeSessions,
      checkedAt: result.checkedAt,
      latencyMs: result.latencyMs,
      cached: result.cached,
    })
  } catch (err) {
    if (err instanceof UpstreamError) {
      // Audit the failed probe (metadata only), then answer the typed error.
      await recordRun('health_check', 'error', { summary: err.code })
    } else if (err instanceof NotConnectedError) {
      await recordRun('health_check', 'error', { summary: 'not_connected' })
    }
    return hyperbrowserErrorResponse(err)
  }
}
