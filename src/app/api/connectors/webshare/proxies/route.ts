// /api/connectors/webshare/proxies — SAFE proxy-pool view (T-206, FR-16 + A9).
//
// GET — requires a stored token (else §11 `not_connected`); calls the pinned
// Webshare API v2 list endpoint (`Authorization: Token …`) through the
// connector client: 10 s timeout, conservative 60 req/min local budget,
// result cached in-memory 60 s per vault keyId. The upstream response is
// WHITELIST-MAPPED inside src/lib/connectors/webshare.ts — rows are exactly
//   { id, country, poolLabel, rotateCadence, usernameMasked }
// and proxy_address / port / password / raw username NEVER reach any
// response, log, cache, or audit row (A9 hard invariant, runtime-guarded).
//
// Success → ConnectorRun 'proxies_check' (ok + latency + counts only) and the
// non-secret pool metadata (count + country histogram + checkedAt) is
// persisted for the status route. Invalid token → typed
// `upstream_unauthorized` (401-class).
//
// Response shape (SAFE — metadata only):
//   { checkedAt, latencyMs, cached, proxyCount,
//     countries: [{code, count}], items: [WebshareProxyRow] }

import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import {
  NotConnectedError,
  UpstreamError,
  getSafePool,
  getStoredToken,
  recordRun,
  storePoolMeta,
  webshareErrorResponse,
} from '@/lib/connectors/webshare'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied

  try {
    const stored = await getStoredToken()
    if (stored === null) throw new NotConnectedError()

    const result = await getSafePool(stored.token, stored.keyId)

    if (!result.cached) {
      await recordRun('proxies_check', 'ok', {
        latencyMs: result.latencyMs,
        summary: `proxies=${result.proxyCount} countries=${result.countries.length} live`,
      })
      // Non-secret pool metadata for the status route (§3: Setting = config only).
      await storePoolMeta({
        proxyCount: result.proxyCount,
        countries: result.countries,
        checkedAt: result.checkedAt,
      })
    }

    return NextResponse.json({
      checkedAt: result.checkedAt,
      latencyMs: result.latencyMs,
      cached: result.cached,
      proxyCount: result.proxyCount,
      countries: result.countries,
      items: result.items,
    })
  } catch (err) {
    if (err instanceof UpstreamError) {
      // Audit the failed probe (metadata only — the error CODE, never a body),
      // then answer the typed error.
      await recordRun('proxies_check', 'error', { summary: err.code })
    } else if (err instanceof NotConnectedError) {
      await recordRun('proxies_check', 'error', { summary: 'not_connected' })
    }
    return webshareErrorResponse(err)
  }
}
