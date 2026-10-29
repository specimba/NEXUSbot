// POST /api/dev/retention — FR-31, SESSION-GATED: runs the retention sweep
// once and reports what it removed (also fires automatically once per boot
// from the metrics route module).

import { NextResponse } from 'next/server'
import { runRetentionSweep } from '@/lib/retention'
import { requireSession } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied

  const result = await runRetentionSweep()
  return NextResponse.json({
    eventsDeleted: result.eventsDeleted,
    artifactsDeleted: result.artifactsDeleted,
    backupsPruned: result.backupsPruned,
  })
}
