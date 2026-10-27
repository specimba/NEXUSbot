// Retention sweep — T-106 / FR-31 (RT-02/12): bounded storage defaults,
// enforced by sweep (session-triggered via /api/dev/retention + once per boot
// from the metrics route module).
//
// Frozen defaults: events 30d · artifacts ≤ 500 files / 200 MB · backups 10.
// Order inside the sweep matters: outbox rows are deleted BEFORE their events
// (FK NO ACTION by design, schema §3). Artifact rows are plain-referenced by
// Job.artifactId (no FK) so row deletion is safe. Only FILES are pruned for
// backups — stale Artifact rows for deleted tarballs surface as
// integrity_error via the normal verify path (honest, FR-04).

import { readdir, unlink, stat } from 'node:fs/promises'
import path from 'node:path'
import { db, ensureDbReady, withWriteRetry } from '@/lib/db'

// ---------------------------------------------------------------------------
// Config constants (frozen defaults, FR-31)
// ---------------------------------------------------------------------------

export const RETENTION_EVENT_DAYS = 30
export const ARTIFACT_MAX_FILES = 500
export const ARTIFACT_MAX_BYTES = 200 * 1024 * 1024 // 200 MB
export const BACKUPS_KEEP = 10

const BACKUPS_DIR = path.join(process.cwd(), 'db', 'backups')

export interface RetentionResult {
  eventsDeleted: number
  artifactsDeleted: number
  backupsPruned: number
}

const globalForRetention = globalThis as unknown as {
  __nexusRetentionInFlight: boolean | undefined
}

async function deleteFileQuiet(absPath: string): Promise<void> {
  try {
    await unlink(absPath)
  } catch {
    // already gone — pruning is idempotent
  }
}

/**
 * (1) Events older than 30d (by ingestedAt): delete their outbox rows first,
 *     then the events.
 * (2) Artifacts: when over file/byte caps, delete oldest (createdAt asc) until
 *     within both caps — file (if it exists) then row.
 * (3) Backups: keep the newest 10 *.db + 10 *.tar.gz in db/backups (files only).
 *
 * Guarded by a globalThis in-flight flag: concurrent triggers collapse into
 * the running sweep (single-writer topology, spec §12).
 */
export async function runRetentionSweep(): Promise<RetentionResult> {
  if (globalForRetention.__nexusRetentionInFlight) {
    return { eventsDeleted: 0, artifactsDeleted: 0, backupsPruned: 0 }
  }
  globalForRetention.__nexusRetentionInFlight = true
  try {
    await ensureDbReady()
    const eventsDeleted = await pruneEvents()
    const artifactsDeleted = await pruneArtifacts()
    const backupsPruned = await pruneBackups()
    return { eventsDeleted, artifactsDeleted, backupsPruned }
  } finally {
    globalForRetention.__nexusRetentionInFlight = false
  }
}

async function pruneEvents(): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_EVENT_DAYS * 24 * 60 * 60 * 1000)
  const old = await db.event.findMany({
    where: { ingestedAt: { lt: cutoff } },
    select: { id: true },
  })
  if (old.length === 0) return 0
  const ids = old.map((e) => e.id)
  // FK order: outbox rows first (Event relation has NO cascade by design).
  await withWriteRetry(() => db.outbox.deleteMany({ where: { eventId: { in: ids } } }))
  const res = await withWriteRetry(() =>
    db.event.deleteMany({ where: { id: { in: ids } } }),
  )
  return res.count
}

async function pruneArtifacts(): Promise<number> {
  const rows = await db.artifact.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, path: true, bytes: true },
  })
  let files = rows.length
  let bytes = rows.reduce((sum, r) => sum + r.bytes, 0)
  let deleted = 0

  for (const row of rows) {
    if (files <= ARTIFACT_MAX_FILES && bytes <= ARTIFACT_MAX_BYTES) break
    await deleteFileQuiet(path.join(process.cwd(), row.path))
    await withWriteRetry(() => db.artifact.delete({ where: { id: row.id } }))
    files -= 1
    bytes -= row.bytes
    deleted += 1
  }
  return deleted
}

async function pruneBackups(): Promise<number> {
  let names: string[]
  try {
    names = await readdir(BACKUPS_DIR)
  } catch {
    return 0 // no backups dir yet — nothing to prune
  }

  const dbs = names.filter((n) => /^backup-\d{8}T\d{6}Z\.db$/.test(n)).sort()
  const tars = names.filter((n) => /^artifacts-\d{8}T\d{6}Z\.tar\.gz$/.test(n)).sort()
  // Compact UTC ts in the name ⇒ lexicographic sort IS chronological.
  const excess = [
    ...dbs.slice(0, Math.max(0, dbs.length - BACKUPS_KEEP)),
    ...tars.slice(0, Math.max(0, tars.length - BACKUPS_KEEP)),
  ]
  for (const name of excess) {
    await deleteFileQuiet(path.join(BACKUPS_DIR, name))
  }
  return excess.length
}

/** stat helper kept for future restore-drill tooling (reads only). */
export async function fileSizeOf(absPath: string): Promise<number | null> {
  try {
    return (await stat(absPath)).size
  } catch {
    return null
  }
}
