// GET /api/health — FR-09, PUBLIC (no session): liveness + DB reachability +
// process metadata. Never throws; db:'down' reports ok:false honestly.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const globalForHealth = globalThis as unknown as {
  __nexusPkgVersion: string | undefined
}

function pkgVersion(): string {
  if (globalForHealth.__nexusPkgVersion) return globalForHealth.__nexusPkgVersion
  let version = 'unknown'
  try {
    const raw = readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    if (typeof parsed.version === 'string') version = parsed.version
  } catch {
    // keep 'unknown' — health must never fail on cosmetics
  }
  globalForHealth.__nexusPkgVersion = version
  return version
}

export async function GET(): Promise<NextResponse> {
  let dbUp = true
  try {
    await db.$queryRawUnsafe('SELECT 1')
  } catch {
    dbUp = false
  }
  return NextResponse.json({
    ok: dbUp,
    db: dbUp ? 'up' : 'down',
    version: pkgVersion(),
    uptimeS: Math.round(process.uptime()),
  })
}
