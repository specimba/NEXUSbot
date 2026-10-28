// /api/connectors/upstash/stats — live data-plane stats (T-204, FR-14
// "ping/stats"). GET — requires a stored token pair (else §11 `not_connected`);
// issues DBSIZE over the REST endpoint (GET {endpoint}/dbsize, Bearer token) —
// a data-plane stat the REST token can read without pinning a stream key (the
// optional stream mirror stays OFF by default per FR-14). 10 s timeout,
// protective local budget, 60 s in-memory cache keyed by vault keyId + pair
// fingerprint. Success → ConnectorRun 'stats_check' (ok + latencyMs); failures
// → the same typed upstream_* error shape as /health.

import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import {
  NotConnectedError,
  UpstreamError,
  getStoredPair,
  recordRun,
  statsCheck,
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

    const result = await statsCheck(stored, stored.keyId)

    if (!result.cached) {
      await recordRun('stats_check', 'ok', {
        latencyMs: result.latencyMs,
        summary: `dbsize endpoint=${result.endpointHost}`,
      })
    }

    return NextResponse.json({
      ok: true,
      keys: result.keys,
      endpointHost: result.endpointHost,
      checkedAt: result.checkedAt,
      latencyMs: result.latencyMs,
      cached: result.cached,
    })
  } catch (err) {
    if (err instanceof UpstreamError) {
      // Audit the failed probe (metadata only), then answer the typed error.
      await recordRun('stats_check', 'error', { summary: err.code })
    } else if (err instanceof NotConnectedError) {
      await recordRun('stats_check', 'error', { summary: 'not_connected' })
    }
    return upstashErrorResponse(err)
  }
}
