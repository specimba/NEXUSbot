// GET /api/artifacts/[id] — stream one artifact file (FR-04). Integrity first:
// a missing/mismatched/unsafe file emits the deduped `system.log`
// integrity_error event (via verifyArtifact — never silent) and answers 500.
// Path safety: rows carry repo-root-relative paths; traversal is rejected.
//
// Session-gated per the §11 authz matrix (in-route enforcement — edge
// middleware cannot run Prisma; see worklog 5-d).

import { NextResponse } from 'next/server'
import { db, ensureDbReady } from '@/lib/db'
import { readArtifactFile, verifyArtifact } from '@/lib/artifacts'
import { requireSession } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface ErrorBody {
  error: {
    code: string
    message: string
    details?: Array<{ field: string; issue: string }>
  }
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: Array<{ field: string; issue: string }>,
): NextResponse<ErrorBody> {
  const body: ErrorBody = {
    error: details ? { code, message, details } : { code, message },
  }
  return NextResponse.json(body, { status })
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireSession(req)
  if (denied) return denied
  await ensureDbReady()

  // Next 16: params is a Promise.
  const { id } = await ctx.params
  const artifactId = Number(id)
  if (!Number.isInteger(artifactId) || artifactId < 1) {
    return errorResponse(400, 'validation', 'Invalid artifact id', [
      { field: 'id', issue: 'must be a positive integer' },
    ])
  }

  const row = await db.artifact.findUnique({ where: { id: artifactId } })
  if (!row) {
    return errorResponse(404, 'not_found', `Artifact ${artifactId} not found`)
  }

  // Verify (and emit integrity_error event on any mismatch) BEFORE serving.
  const verdict = await verifyArtifact(row)
  if (!verdict.ok) {
    return errorResponse(
      500,
      'integrity_error',
      `Artifact file failed integrity verification (${verdict.reason})`,
    )
  }

  const buf = await readArtifactFile(row)
  if (!buf) {
    // Raced deletion between verify and read — re-verify to emit (deduped)
    // and fail loudly rather than serve an empty body.
    await verifyArtifact(row)
    return errorResponse(
      500,
      'integrity_error',
      'Artifact file failed integrity verification (file_missing)',
    )
  }

  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'x-nexus-sha256': row.sha256,
    },
  })
}
