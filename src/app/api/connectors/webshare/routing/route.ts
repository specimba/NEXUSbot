// /api/connectors/webshare/routing — STATIC honest routing-state endpoint
// (T-206, FR-16 + scope §10 A9, BINDING).
//
// FR-16 wants the proxy-routing option VISIBLE but A9 pins M2 to OFF:
//   "Proxy routing module: OFF by default; enable only on a recorded measured
//   need". This route serves exactly that fact — nothing dynamic, nothing
//   toggleable. There is deliberately NO enable route in this task: routing
//   enablement is a future GATED decision (recorded measured need + owner
//   sign-off), and shipping a toggle now would contradict A9.
//
// No request body, no query parameters, no upstream calls, no state.

import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ROUTING_STATE = {
  routingEnabled: false,
  reason: 'A9 — M2 ships routing OFF; enablement is a future gated decision',
} as const

export async function GET(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied
  return NextResponse.json(ROUTING_STATE)
}
