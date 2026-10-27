// /api/connectors/upstash/health — live REST PING probe (T-204, FR-14).
//
// GET — requires a stored token pair (else §11 `not_connected`); issues the
// documented REST PING pattern (GET {endpoint}/ping, Bearer token) through the
// connector client: 10 s timeout, protective local budget, result cached
// in-memory 60 s keyed by vault keyId + pair fingerprint (a re-stored pair
// always probes fresh). Success → ConnectorRun 'health_check' (ok + latencyMs).
// Invalid token → typed `upstream_unauthorized` (401-class); unreachable or
// wrong endpoint → `upstream_network`/`upstream_error`; rate-limited →
// `upstream_rate_limited` (Retry-After honored).

import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import {
  NotConnectedError,
  UpstreamError,
  getStoredPair,
  healthCheck,
  recordRun,
  upstashErrorResponse,
} from '@/lib/connectors/upstash'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied

  try {
    const stored = await getStoredPair()
    if (stored === null) throw new NotConnectedError()

    const result = await healthCheck(stored, stored.keyId)

    if (!result.cached) {
      await recordRun('health_check', 'ok', {
        latencyMs: result.latencyMs,
        summary: `ping endpoint=${result.endpointHost}`,
      })
    }

    return NextResponse.json({
      ok: true,
      endpointHost: result.endpointHost,
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
    return upstashErrorResponse(err)
  }
}
