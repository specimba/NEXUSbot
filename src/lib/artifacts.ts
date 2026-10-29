// Artifact store — T-105. Implements FR-04: artifacts live under
// artifacts/YYYY-MM/ (UTC month, repo root), each with a sha256/bytes row in
// the DB. File-first ordering (spec §3): the file is the durable effect and is
// written BEFORE the hash/row; a checkpoint recorded later therefore always
// points at something already on disk.
//
// Integrity (FR-04/NFR-05): a missing or hash-mismatched file emits a
// `system.log` integrity_error event (component 'artifacts.integrity',
// deduped per artifact+reason via idempotencyKey) — never silent.
//
// Path safety: rows store paths RELATIVE to the repo root. Any path containing
// `..` or starting with `/` (or `\`) is rejected before any disk access.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Artifact as ArtifactRow } from '@prisma/client'
import { db, ensureDbReady, withWriteRetry } from '@/lib/db'
import { insertEvent } from '@/lib/events'

export interface WriteArtifactInput {
  kind: string
  content: string | Buffer
  jobId?: number
  ext?: string
}

/** A row path is safe iff it is relative and contains no traversal. */
export function isSafeArtifactPath(p: string): boolean {
  return p.length > 0 && !p.startsWith('/') && !p.startsWith('\\') && !p.includes('..')
}

function toBuffer(content: string | Buffer): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
}

/**
 * Write the artifact: file first (durable effect), then sha256/bytes, then the
 * DB row (busy-retry wrapped). Returns the created Artifact row; `path` is
 * relative to the repo root, e.g. `artifacts/2026-10/<uuid>.json`.
 */
export async function writeArtifact(input: WriteArtifactInput): Promise<ArtifactRow> {
  await ensureDbReady()
  const buf = toBuffer(input.content)
  const now = new Date()
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const ext = input.ext ?? 'json'
  const relPath = path.join('artifacts', month, `${randomUUID()}.${ext}`)
  const absPath = path.join(process.cwd(), relPath)

  await mkdir(path.dirname(absPath), { recursive: true })
  await writeFile(absPath, buf) // durable effect FIRST (§3 file-first ordering)

  const sha256 = createHash('sha256').update(buf).digest('hex')
  return withWriteRetry(() =>
    db.artifact.create({
      data: {
        jobId: input.jobId ?? null,
        kind: input.kind,
        path: relPath,
        sha256,
        bytes: buf.byteLength,
      },
    }),
  )
}

/**
 * Read the artifact file for a row. Returns null when the file is missing or
 * the row path is unsafe — callers surface integrity, this never throws.
 */
export async function readArtifactFile(
  row: Pick<ArtifactRow, 'path'>,
): Promise<Buffer | null> {
  if (!isSafeArtifactPath(row.path)) return null
  try {
    return await readFile(path.join(process.cwd(), row.path))
  } catch {
    return null // missing/unreadable file — integrity is reported by the caller
  }
}

async function emitIntegrityEvent(artifactId: number, reason: string): Promise<void> {
  try {
    await insertEvent({
      type: 'system.log',
      source: 'pipeline',
      payloadVersion: 1,
      payload: {
        level: 'error',
        component: 'artifacts.integrity',
        message: `integrity_error artifact ${artifactId} (${reason})`,
      },
      occurredAt: new Date().toISOString(),
      synthetic: false,
      // Dedupe key: repeated probes of the same broken artifact emit once.
      idempotencyKey: `integrity:${artifactId}:${reason}`,
    })
  } catch (err) {
    // Emission is best-effort (the verdict below is the primary answer) — but
    // an emission failure is itself logged loudly, never swallowed (NFR-05).
    console.error(
      JSON.stringify({
        layer: 'L0',
        component: 'artifacts.integrity',
        task_id: 'T-105',
        event: 'integrity_event_emit_error',
        artifactId,
        reason,
        message: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      }),
    )
  }
}

export type ArtifactVerdict = { ok: true; reason: null } | { ok: false; reason: string }

/**
 * Verify a row's file against the stored sha256. Missing file / hash mismatch
 * / unsafe path → emits the deduped integrity_error system.log event and
 * returns {ok:false, reason}. Never throws for missing files.
 */
export async function verifyArtifact(row: ArtifactRow): Promise<ArtifactVerdict> {
  if (!isSafeArtifactPath(row.path)) {
    await emitIntegrityEvent(row.id, 'unsafe_path')
    return { ok: false, reason: 'unsafe_path' }
  }
  const buf = await readArtifactFile(row)
  if (!buf) {
    await emitIntegrityEvent(row.id, 'file_missing')
    return { ok: false, reason: 'file_missing' }
  }
  const sha256 = createHash('sha256').update(buf).digest('hex')
  if (sha256 !== row.sha256) {
    await emitIntegrityEvent(row.id, 'hash_mismatch')
    return { ok: false, reason: 'hash_mismatch' }
  }
  return { ok: true, reason: null }
}
