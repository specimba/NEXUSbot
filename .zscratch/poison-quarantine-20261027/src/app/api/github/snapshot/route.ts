// POST /api/github/snapshot — FR-12 snapshot push (T-202). SESSION-GATED.
//
// Takes the latest backup tarball (FR-28) and pushes it to the owner's private
// repo via the GitHub REST Git data API (blob → tree → commit → ref).
//
// Backup reuse (brief-sanctioned "call its internals", zero tar-logic
// duplication): this route imports the FR-28 route handler's POST and invokes
// it with the caller's session cookie, producing a FRESH backup (own Artifact
// row + pruning). The returned sha256 is matched against the on-disk tarball;
// fallback = newest existing backup tarball (createdFresh:false, honest).
//
// Target repo: GITHUB_SNAPSHOT_REPO ('owner/repo') or auto
// `<login>/nexus-snapshots` (created private when missing — Repository
// creation:write per ADR-003). In-repo path: snapshots/<ts>/artifacts-<ts>.tar.gz
// (append-only history, one commit per push). Result stored in Setting
// 'github.snapshot' + ConnectorRun (result + commit sha, no secret fragments).
// A GitHub 401 marks the credential invalid — honest reauth state (FR-12).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
// FR-28 backup reuse: the route handler IS the creation logic (its steps are
// not exported from a lib). Importing + calling with the forwarded session
// cookie is the brief's sanctioned reuse path — see file header.
import { POST as backupRoutePost } from '@/app/api/dev/backup/route'
import {
  decryptGithubAccessToken,
  ensureSnapshotBundle,
  GithubApiError,
  logGithubRun,
  markGithubCredentialInvalid,
  probeGithubLogin,
  pushSnapshotTarball,
  readGithubAccountMeta,
  readGithubCredentialMeta,
  SNAPSHOT_MAX_BYTES,
  snapshotRepoTarget,
  writeGithubSnapshotMeta,
} from '@/lib/connectors/github'
import { VaultConfigError, VaultIntegrityError } from '@/lib/crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120 // fresh backup + multi-call GitHub push

function errorResponse(
  status: number,
  code: string,
  message: string,
): NextResponse<{ error: { code: string; message: string } }> {
  return NextResponse.json({ error: { code, message } }, { status })
}

const snapshotBodySchema = z.object({
  message: z.string().min(1).max(200).optional(),
})

export async function POST(req: Request): Promise<NextResponse> {
  const denied = await requireSession(req)
  if (denied) return denied

  // Optional operator commit-message override (zod-validated body).
  let message: string | undefined
  try {
    const text = await req.text()
    if (text.length > 0) {
      const parsed = snapshotBodySchema.safeParse(JSON.parse(text))
      if (!parsed.success) {
        return errorResponse(400, 'validation', 'Snapshot body failed validation', [
          ...parsed.error.issues.map((iss) => ({
            field: iss.path.length > 0 ? iss.path.join('.') : '(root)',
            issue: iss.message,
          })),
        ])
      }
      message = parsed.data.message
    }
  } catch {
    return errorResponse(400, 'validation', 'Request body is not valid JSON')
  }

  // Connection state — decrypt-and-discard probe, then real decrypt for use.
  const credential = await readGithubCredentialMeta()
  if (credential === null) {
    return errorResponse(409, 'not_connected', 'GitHub is not connected — connect first, then push a snapshot')
  }
  if (credential.integrity === 'vault_config') {
    return errorResponse(500, 'server_config', 'ENCRYPTION_KEY is not configured — vault unavailable')
  }
  if (credential.integrity === 'tampered') {
    return errorResponse(409, 'integrity_error', 'Stored GitHub token failed vault integrity — reconnect')
  }

  let token: string
  try {
    token = await decryptGithubAccessToken()
  } catch (err) {
    if (err instanceof VaultConfigError) {
      return errorResponse(500, 'server_config', 'ENCRYPTION_KEY is not configured — vault unavailable')
    }
    if (err instanceof VaultIntegrityError) {
      return errorResponse(409, 'integrity_error', 'Stored GitHub token failed vault integrity — reconnect')
    }
    return errorResponse(500, 'server_error', 'Token decrypt failed')
  }

  const startedAt = Date.now()

  // Bundle: fresh FR-28 backup (sha256-bound to disk) or newest tarball.
  let bundle
  try {
    bundle = await ensureSnapshotBundle(req.headers.get('cookie'), backupRoutePost)
  } catch (err) {
    const messageText = err instanceof Error ? err.message.slice(0, 200) : 'backup bundle unavailable'
    await logGithubRun('snapshot_push', 'error', Date.now() - startedAt, messageText)
    if (err instanceof GithubApiError) {
      return errorResponse(err.status === 0 ? 502 : err.status, err.code, messageText)
    }
    return errorResponse(500, 'snapshot_failed', messageText)
  }

  if (bundle.bytes > SNAPSHOT_MAX_BYTES) {
    await logGithubRun('snapshot_push', 'error', Date.now() - startedAt, `tarball too large for GitHub blobs: ${bundle.bytes} B`)
    return errorResponse(413, 'payload_too_large', `Backup tarball is ${bundle.bytes} bytes — GitHub blob limit is 100 MB; prune artifacts first`)
  }

  // Target repo: env 'owner/repo' or auto <login>/nexus-snapshots. The login
  // is resolved lazily — only when a bare repo name needs an owner. A 401 on
  // the login probe means GitHub REJECTED the stored token → honest invalid
  // marking (same disposition as a push-time 401).
  let target = snapshotRepoTarget()
  let fallbackOwner = ''
  if (target === null || !target.includes('/')) {
    const account = await readGithubAccountMeta()
    let login = account?.login ?? null
    let probeStatus = 0
    if (login === null || login === 'unknown') {
      const probe = await probeGithubLogin(token)
      if (probe.ok) login = probe.login
      else probeStatus = probe.status
    }
    if (login === null || login === 'unknown') {
      if (probeStatus === 401 || probeStatus === 403) {
        await markGithubCredentialInvalid()
        await logGithubRun('snapshot_push', 'error', Date.now() - startedAt, `GitHub rejected the stored token (HTTP ${probeStatus}) during login probe — credential marked invalid`)
        return errorResponse(502, 'snapshot_failed', `GitHub rejected the stored token (HTTP ${probeStatus}) — reconnect GitHub and retry`)
      }
      await logGithubRun('snapshot_push', 'error', Date.now() - startedAt, 'no snapshot target: GITHUB_SNAPSHOT_REPO unset/ownerless and login unavailable')
      return errorResponse(409, 'no_snapshot_target', 'GITHUB_SNAPSHOT_REPO is unset (or missing owner) and the account login is unavailable — set the env var or reconnect')
    }
    fallbackOwner = login
    if (target === null) target = `${login}/nexus-snapshots`
  }

  const commitMessage = message ?? `NEXUS OS snapshot — ${bundle.fileName} (sha256 ${bundle.sha256.slice(0, 12)})`

  try {
    const push = await pushSnapshotTarball(token, target, bundle, commitMessage, fallbackOwner)
    const meta = {
      repo: push.repo,
      path: push.path,
      sha: push.commitSha,
      bytes: bundle.bytes,
      tarSha256: bundle.sha256,
      pushedAt: new Date().toISOString(),
      backupId: bundle.backupId,
    }
    await writeGithubSnapshotMeta(meta)
    await logGithubRun(
      'snapshot_push',
      'ok',
      Date.now() - startedAt,
      `${push.repo}@${push.path} commit ${push.commitSha.slice(0, 10)} (${bundle.bytes} B, backupId=${bundle.backupId ?? 'none'}, repoCreated=${push.repoCreated})`,
    )
    return NextResponse.json({
      ...meta,
      branch: push.branch,
      repoCreated: push.repoCreated,
      branchCreated: push.branchCreated,
      blobSha: push.blobSha,
      createdFresh: bundle.createdFresh,
      commitUrl: `https://github.com/${push.repo}/commit/${push.commitSha}`,
    })
  } catch (err) {
    if (err instanceof GithubApiError) {
      if (err.status === 401 || err.status === 403) {
        await markGithubCredentialInvalid()
        await logGithubRun('snapshot_push', 'error', Date.now() - startedAt, `GitHub rejected the stored token (HTTP ${err.status}) — credential marked invalid`)
        return errorResponse(502, 'snapshot_failed', `GitHub rejected the stored token (HTTP ${err.status}) — reconnect GitHub and retry`)
      }
      await logGithubRun('snapshot_push', 'error', Date.now() - startedAt, `push failed: ${err.code} ${err.message.slice(0, 150)}`)
      return errorResponse(err.status === 0 ? 502 : err.status, 'snapshot_failed', err.message.slice(0, 200))
    }
    const messageText = err instanceof Error ? err.message.slice(0, 200) : 'snapshot push failed'
    await logGithubRun('snapshot_push', 'error', Date.now() - startedAt, messageText)
    return errorResponse(500, 'snapshot_failed', messageText)
  }
}
