import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  deleteMgmtPat,
  getMgmtPat,
  isPlausiblePat,
  logSupabaseEvent,
  maskMgmtPat,
  mgmtListProjects,
  storeMgmtPat,
} from "@/lib/connectors/supabase";

/**
 * PUT  /api/connectors/supabase/pat (session required) — store scoped Mgmt PAT
 *      via the encrypted vault (service "supabase", label "mgmt"). A MEASURED
 *      probe against /v1/projects is returned either way; a failing probe does
 *      NOT block storage (honesty is handled by status/health, not by hiding).
 * DELETE — removes the vault credential. Idempotent.
 *
 * P7: the PAT is accepted once, encrypted immediately, never logged/echoed.
 */
export async function PUT(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as { pat?: unknown } | null;
  const pat = typeof body?.pat === "string" ? body.pat.trim() : "";
  if (!isPlausiblePat(pat)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "BAD_PAT",
          message: "pat must be a string of 8–4096 characters (Supabase Management API access token).",
        },
      },
      { status: 400 },
    );
  }

  await storeMgmtPat(pat);
  await logSupabaseEvent("supabase.pat_stored", { masked: maskMgmtPat(pat) });

  // MEASURED probe with the just-stored credential (value never logged).
  let probe: { ok: boolean; httpStatus: number; projectCount: number } | null = null;
  try {
    const res = await mgmtListProjects(pat);
    probe = { ok: res.ok, httpStatus: res.status, projectCount: res.ok ? res.projects.length : 0 };
  } catch {
    probe = { ok: false, httpStatus: 0, projectCount: 0 };
  }

  return NextResponse.json(
    { ok: true, stored: true, masked: maskMgmtPat(pat), probe },
    { status: 201 },
  );
}

export async function DELETE() {
  const denied = await requireSession();
  if (denied) return denied;

  const had = await deleteMgmtPat();
  if (had) await logSupabaseEvent("supabase.pat_removed", {});

  return NextResponse.json({ ok: true, patPresent: false, deleted: had });
}

/** GET returns whether a PAT exists (no value ever leaves the vault). */
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  const pat = await getMgmtPat();
  return NextResponse.json({
    ok: true,
    patPresent: pat !== null,
    masked: pat ? maskMgmtPat(pat) : null,
  });
}
