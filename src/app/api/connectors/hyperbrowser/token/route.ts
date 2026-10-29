// /api/connectors/hyperbrowser/token — Hyperbrowser API-key custody (T-205,
// FR-15 + ADR-002 + A8). Keys are the only path here: the Hyperbrowser console
// offers account-wide API keys, no OAuth app for this panel (research R3) —
// the honest labeled key path, same family as the Supabase PAT fallback.
//
// POST   — store/replace the API key: body {key}; shape-checked (hb_-prefixed
//          OR generic opaque, ≥16 chars, no whitespace), sealed into the
//          credential vault (service='hyperbrowser', name='api-key',
//          scopes=['all']) via src/lib/crypto (AES-256-GCM, AAD-bound),
//          ConnectorRun 'token_stored'. Response is METADATA ONLY — never key
//          material (mask 'hb_••••·last4' / '••••·last4', task-brief shape).
// DELETE — disconnect: removes the credential, ConnectorRun 'token_deleted'.
//          404 when nothing is stored.
//
// Session-gated per §11 (requireSession in-route); single error shape.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { VaultIntegrityError } from '@/lib/crypto'
import {
  HYPERBROWSER_KEY_NAME,
  HYPERBROWSER_KEY_SCOPES,
  HYPERBROWSER_SERVICE,
  classifyKey,
  deleteKey,
  maskKey,
  recordRun,
  storeKey,
  hyperbrowserErrorResponse,
} from '@/lib/connectors/hyperbrowser'

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

const keySchema = z.object({
  key: z
    .string()
    .trim()
    .min(16)
    .max(512)
    .regex(/^[A-Za-z0-9_\-.=]+$/, 'no whitespace or control characters'),
})

type KeyBody = z.infer<typeof keySchema>

// ---------------------------------------------------------------------------
// POST — store API key (create/replace, write-only)
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
  const parsed = keySchema.safeParse(bodyResult.value)
  if (!parsed.success) {
    return errorResponse(400, 'validation', 'API-key body failed validation', [
      ...parsed.error.issues.map((iss) => ({
        field: iss.path.length > 0 ? iss.path.join('.') : '(root)',
        issue: iss.message,
      })),
    ])
  }
  const body: KeyBody = parsed.data

  // Shape gate: hb_-prefixed (documented console shape) OR generic opaque.
  const classification = classifyKey(body.key)
  if (classification === null) {
    return errorResponse(400, 'validation', 'API-key format not recognized', [
      {
        field: 'key',
        issue: 'must be an hb_-prefixed Hyperbrowser API key (or a generic opaque key, ≥16 chars, no whitespace)',
      },
    ])
  }

  try {
    const { created, keyId } = await storeKey(body.key)
    await recordRun('token_stored', 'ok', {
      summary: `kind=${classification.kind} vault=credential:${HYPERBROWSER_SERVICE}:${HYPERBROWSER_KEY_NAME}`,
    })
    // Metadata-only response — key material never leaves the server (P7/ADR-002).
    return NextResponse.json(
      {
        service: HYPERBROWSER_SERVICE,
        name: HYPERBROWSER_KEY_NAME,
        scopes: [...HYPERBROWSER_KEY_SCOPES],
        status: 'active',
        created,
        keyId,
        keyKind: classification.kind,
        maskedKey: maskKey(body.key),
      },
      { status: created ? 201 : 200 },
    )
  } catch (err) {
    if (err instanceof VaultIntegrityError) {
      return errorResponse(500, 'integrity_error', 'Vault encryption failed')
    }
    return hyperbrowserErrorResponse(err)
  }
}

// ---------------------------------------------------------------------------
// DELETE — disconnect
// ---------------------------------------------------------------------------

export async function DELETE(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied

  try {
    const existed = await deleteKey()
    if (!existed) {
      return errorResponse(404, 'not_found', 'No Hyperbrowser API key is stored')
    }
    await recordRun('token_deleted', 'ok')
    return NextResponse.json({ ok: true, deleted: true })
  } catch (err) {
    return hyperbrowserErrorResponse(err)
  }
}
