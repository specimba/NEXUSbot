// /api/connectors/upstash/pat — Upstash Redis REST token-pair custody (T-204,
// FR-14 + ADR-002 + A8).
//
// POST   — store/replace the REST token pair: body {url, token}; the URL is
//          normalized (https, *.upstash.io, origin-only) and BOTH parts are
//          sealed into ONE credential vault record (service='upstash',
//          name='rest', scopes=['rest']) as a JSON envelope via src/lib/crypto
//          (AES-256-GCM, AAD-bound), ConnectorRun 'pat_stored'. Response is
//          METADATA ONLY — never token material, never the raw URL.
// DELETE — disconnect: removes the credential, ConnectorRun 'pat_deleted'.
//          404 when nothing is stored.
//
// Session-gated per §11 (requireSession in-route); single error shape.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { VaultIntegrityError } from '@/lib/crypto'
import {
  UPSTASH_NAME,
  UPSTASH_PURPOSE,
  UPSTASH_SCOPES,
  UPSTASH_SERVICE,
  deletePair,
  maskToken,
  normalizeEndpoint,
  recordRun,
  storePair,
  upstashErrorResponse,
} from '@/lib/connectors/upstash'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 32_768

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

function parseJsonBody(
  buf: ArrayBuffer,
): { ok: true; value: unknown } | { ok: false; issue: string } {
  try {
    const text = new TextDecoder().decode(buf)
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (err) {
    return { ok: false, issue: `body is not valid JSON: ${String(err)}` }
  }
}

const pairSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  token: z
    .string()
    .trim()
    .min(32)
    .max(512)
    .regex(/^[A-Za-z0-9_\-.=+/]+$/, 'no whitespace or control characters'),
})

type PairBody = z.infer<typeof pairSchema>

// ---------------------------------------------------------------------------
// POST — store the REST token pair (create/replace, write-only)
// ---------------------------------------------------------------------------

export async function POST(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied

  const contentLength = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return errorResponse(413, 'payload_too_large', `Request body exceeds ${MAX_BODY_BYTES} bytes`)
  }
  const raw = await req.arrayBuffer()
  if (raw.byteLength > MAX_BODY_BYTES) {
    return errorResponse(413, 'payload_too_large', `Request body exceeds ${MAX_BODY_BYTES} bytes`)
  }

  const bodyResult = parseJsonBody(raw)
  if (!bodyResult.ok) {
    return errorResponse(400, 'validation', 'Request body is not valid JSON', [
      { field: '(root)', issue: bodyResult.issue },
    ])
  }
  const parsed = pairSchema.safeParse(bodyResult.value)
  if (!parsed.success) {
    return errorResponse(400, 'validation', 'Token pair body failed validation', [
      ...parsed.error.issues.map((iss) => ({
        field: iss.path.length > 0 ? iss.path.join('.') : '(root)',
        issue: iss.message,
      })),
    ])
  }
  const body: PairBody = parsed.data

  // Semantic gate: the REST base URL must be a console-issued *.upstash.io
  // https origin (keeps the vault from becoming an exfiltration channel).
  const endpoint = normalizeEndpoint(body.url)
  if (endpoint === null) {
    return errorResponse(400, 'validation', 'REST URL not recognized', [
      {
        field: 'url',
        issue:
          'must be an https Upstash Redis REST endpoint URL (console-issued, *.upstash.io, base origin only)',
      },
    ])
  }

  try {
    const { created, keyId } = await storePair(endpoint.origin, body.token)
    await recordRun('pat_stored', 'ok', {
      summary: `endpoint=${endpoint.host} vault=${UPSTASH_PURPOSE}`,
    })
    // Metadata-only response — token material never leaves the server (P7/ADR-002).
    return NextResponse.json(
      {
        service: UPSTASH_SERVICE,
        name: UPSTASH_NAME,
        scopes: [...UPSTASH_SCOPES],
        status: 'active',
        created,
        keyId,
        endpointHost: endpoint.host,
        maskedToken: maskToken(body.token),
      },
      { status: created ? 201 : 200 },
    )
  } catch (err) {
    if (err instanceof VaultIntegrityError) {
      return errorResponse(500, 'integrity_error', 'Vault encryption failed')
    }
    return upstashErrorResponse(err)
  }
}

// ---------------------------------------------------------------------------
// DELETE — disconnect
// ---------------------------------------------------------------------------

export async function DELETE(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied

  try {
    const existed = await deletePair()
    if (!existed) {
      return errorResponse(404, 'not_found', 'No Upstash REST token pair is stored')
    }
    await recordRun('pat_deleted', 'ok')
    return NextResponse.json({ ok: true, deleted: true })
  } catch (err) {
    return upstashErrorResponse(err)
  }
}
