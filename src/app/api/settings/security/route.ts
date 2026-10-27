// GET /api/settings/security — non-secret session/security policy facts
// (T-208, Settings tab). Values mirror the FROZEN contract in src/lib/auth.ts
// (SESSION_TTL_S = 604800 "7 days (frozen)", MAX_FAILURES = 5,
// FAILURE_WINDOW_MS = 15 min) and the FR-29 authz matrix. Nothing here is a
// secret value: cookie NAME + attributes and throttle policy are public
// contract facts; no env dumps, no SESSION_SECRET/PANEL_PASSWORD material.

import { NextResponse } from 'next/server'
import { requireSession, SESSION_COOKIE } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<NextResponse> {
  const denied = await requireSession()
  if (denied) return denied

  return NextResponse.json({
    session: {
      ttlDays: 7,
      cookie: SESSION_COOKIE,
      attributes: 'HttpOnly · SameSite=Lax · HMAC-SHA256 signed',
      logoutInvalidatesAll: true,
    },
    throttle: {
      maxFailures: 5,
      windowMinutes: 15,
      policy:
        '5 failed logins inside a 15-minute sliding window lock the source IP until the oldest failure exits the window',
    },
    authz: {
      public: ['GET /api/health', 'POST /api/events (rate-limited)'],
      sessionGated:
        'every other /api/* route (incl. /api/dev/*, settings, credentials, connectors)',
    },
  })
}
