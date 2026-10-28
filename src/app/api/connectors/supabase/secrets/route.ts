import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  getMgmtPat,
  isValidProjectRef,
  isValidSecretKey,
  logSupabaseEvent,
  mgmtDeleteSecrets,
  mgmtListSecrets,
  mgmtUpsertSecrets,
} from "@/lib/connectors/supabase";

/**
 * Edge Function secrets management (supabase Mgmt API, owner's stored PAT —
 * directive §10-A1: Mgmt writes are the service's own authenticated API).
 *
 * GET    ?projectRef=<ref> → masked list (names + hasValue). Values NEVER pass
 *                            through this route, even upstream-supplied ones.
 * POST   {projectRef, key, value} → add/update one secret.
 * DELETE {projectRef, key}         → remove one secret.
 *
 * All upstream failures surface honestly with MGMT_* codes + real HTTP status.
 */
function upstreamError(res: { status: number; retryAfterSeconds: number | null }): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: res.status === 401 || res.status === 403 ? "MGMT_AUTH" : "MGMT_UPSTREAM",
        message: `Supabase Mgmt API returned HTTP ${res.status}${
          res.retryAfterSeconds !== null ? ` (Retry-After ${res.retryAfterSeconds}s)` : ""
        }`,
      },
    },
    { status: 502 },
  );
}

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const projectRef = new URL(req.url).searchParams.get("projectRef") ?? "";
  if (!isValidProjectRef(projectRef)) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_PROJECT_REF", message: "projectRef must be a 20-char Supabase project ref." } },
      { status: 400 },
    );
  }

  const pat = await getMgmtPat();
  if (!pat) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_STORED", message: "No Management PAT stored — add one first." } },
      { status: 409 },
    );
  }

  let res;
  try {
    res = await mgmtListSecrets(pat, projectRef);
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: e instanceof Error && e.name === "MgmtCooldownError" ? "MGMT_COOLDOWN" : "MGMT_RATE_LIMITED",
          message: e instanceof Error ? e.message : "Mgmt request not sent",
        },
      },
      { status: 429 },
    );
  }

  if (!res.ok) return upstreamError(res);

  // MASKED shape only: {name, alias, hasValue} — upstream "value" is dropped here.
  return NextResponse.json({ ok: true, projectRef, measured: true, secrets: res.secrets });
}

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as
    | { projectRef?: unknown; key?: unknown; value?: unknown }
    | null;
  const projectRef = typeof body?.projectRef === "string" ? body.projectRef : "";
  const key = typeof body?.key === "string" ? body.key : "";
  if (!isValidProjectRef(projectRef)) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_PROJECT_REF", message: "projectRef must be a 20-char Supabase project ref." } },
      { status: 400 },
    );
  }
  if (!isValidSecretKey(key)) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_KEY", message: "key must be an env-style identifier (letters, digits, underscore)." } },
      { status: 400 },
    );
  }
  const value = typeof body?.value === "string" ? body.value : "";
  if (value.length < 1 || value.length > 8192) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_VALUE", message: "value must be 1–8192 characters." } },
      { status: 400 },
    );
  }

  const pat = await getMgmtPat();
  if (!pat) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_STORED", message: "No Management PAT stored — add one first." } },
      { status: 409 },
    );
  }

  let res;
  try {
    res = await mgmtUpsertSecrets(pat, projectRef, [{ key, value }]);
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: e instanceof Error && e.name === "MgmtCooldownError" ? "MGMT_COOLDOWN" : "MGMT_RATE_LIMITED",
          message: e instanceof Error ? e.message : "Mgmt request not sent",
        },
      },
      { status: 429 },
    );
  }

  if (!res.ok) return upstreamError(res);

  await logSupabaseEvent("supabase.secret_set", { projectRef, key });
  return NextResponse.json({ ok: true, projectRef, key }, { status: 201 });
}

export async function DELETE(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as
    | { projectRef?: unknown; key?: unknown }
    | null;
  const projectRef = typeof body?.projectRef === "string" ? body.projectRef : "";
  const key = typeof body?.key === "string" ? body.key : "";
  if (!isValidProjectRef(projectRef)) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_PROJECT_REF", message: "projectRef must be a 20-char Supabase project ref." } },
      { status: 400 },
    );
  }
  if (!isValidSecretKey(key)) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_KEY", message: "key must be an env-style identifier (letters, digits, underscore)." } },
      { status: 400 },
    );
  }

  const pat = await getMgmtPat();
  if (!pat) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_STORED", message: "No Management PAT stored — add one first." } },
      { status: 409 },
    );
  }

  let res;
  try {
    res = await mgmtDeleteSecrets(pat, projectRef, [key]);
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: e instanceof Error && e.name === "MgmtCooldownError" ? "MGMT_COOLDOWN" : "MGMT_RATE_LIMITED",
          message: e instanceof Error ? e.message : "Mgmt request not sent",
        },
      },
      { status: 429 },
    );
  }

  if (!res.ok) return upstreamError(res);

  await logSupabaseEvent("supabase.secret_removed", { projectRef, key });
  return NextResponse.json({ ok: true, projectRef, key });
}
