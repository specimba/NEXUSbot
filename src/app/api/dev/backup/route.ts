// POST /api/dev/backup — FR-28 (RT-04), SESSION-GATED. Steps:
//   1. PRAGMA wal_checkpoint(TRUNCATE)  → WAL folded into the main DB file
//   2. VACUUM INTO db/backups/backup-<ts>.db (path is server-generated —
//      literal interpolation safe, never user input)
//   3. tar -czf db/backups/artifacts-<ts>.tar.gz artifacts (child process)
//   4. ONE Artifact row inserted DIRECTLY (kind='backup') — writeArtifact
//      would place the file under artifacts/YYYY-MM, which backups are not
//   5. Prune to the newest 10 *.db + 10 *.tar.gz (files only; stale rows for
//      pruned tarballs surface as integrity_error — honest per FR-04)

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { NextResponse } from 'next/server'
import { db, ensureDbReady, withWriteRetry } from '@/lib/db'
import { requireSession } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const execFileAsync = promisify(execFile)

const BACKUPS_DIR = path.join(process.cwd(), 'db', 'backups')
const BACKUPS_KEEP = 10

function error(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status })
}

function compactUtcTs(date: Date): string {
  // 2026-10-21T15:30:00.123Z → 20261021T153000Z (lexicographic = chronological)
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

async function pruneBackups(): Promise<void> {
  let names: string[]
  try {
    names = await readdir(BACKUPS_DIR)
  } catch {
    return
  }
  const dbs = names.filter((n) => /^backup-\d{8}T\d{6}Z\.db$/.test(n)).sort()
  const tars = names.filter((n) => /^artifacts-\d{8}T\d{6}Z\.tar\.gz$/.test(n)).sort()
  const excess = [
    ...dbs.slice(0, Math.max(0, dbs.length - BACKUPS_KEEP)),
    ...tars.slice(0, Math.max(0, tars.length - BACKUPS_KEEP)),
  ]
  for (const name of excess) {
    try {
      await unlink(path.join(BACKUPS_DIR, name))
    } catch {
      // idempotent prune
    }
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied
  await ensureDbReady()

  const startedAt = Date.now()
  const ts = compactUtcTs(new Date())
  const dbBackupPath = path.join(BACKUPS_DIR, `backup-${ts}.db`)
  const tarRelPath = `db/backups/artifacts-${ts}.tar.gz`
  const tarAbsPath = path.join(process.cwd(), tarRelPath)

  try {
    await mkdir(BACKUPS_DIR, { recursive: true })
    await db.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);')
    await db.$executeRawUnsafe(`VACUUM INTO '${dbBackupPath}'`)

    await mkdir(path.join(process.cwd(), 'artifacts'), { recursive: true })
    await execFileAsync('tar', ['-czf', tarAbsPath, 'artifacts'], { cwd: process.cwd() })

    const tarball = await readFile(tarAbsPath)
    const sha256 = createHash('sha256').update(tarball).digest('hex')
    const artifact = await withWriteRetry(() =>
      db.artifact.create({
        data: {
          jobId: null, // system backup — kind='backup' (FR-28)
          kind: 'backup',
          path: tarRelPath,
          sha256,
          bytes: tarball.byteLength,
        },
      }),
    )
    await pruneBackups()

    return NextResponse.json({
      backupId: artifact.id,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      elapsedMs: Date.now() - startedAt,
    })
  } catch (err) {
    // No payload fragments in logs (RT-13) — message + phase only.
    return error(
      500,
      'backup_failed',
      `Backup failed: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}`,
    )
  }
}
