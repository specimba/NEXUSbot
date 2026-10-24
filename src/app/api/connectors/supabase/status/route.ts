import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  getMgmtPat,
  maskMgmtPat,
  mgmtClientState,
  mgmtListProjects,
} from "@/lib/connectors/supabase";

/**
 * GET /api/connectors/supabase/status (session required)
 * patPresent (vault), masked preview, and — when a PAT is stored — a MEASURED
 * live probe of GET https://api.supabase.com/v1/projects. A bad PAT reports
 * probe.ok=false with the real upstream HTTP status; never a fake "connected".
 */
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  const pat = await getMgmtPat();
  if (!pat) {
    return NextResponse.json({
      ok: true,
      patPresent: false,
      masked: null,
      probe: null,
      mgmt: mgmtClientState(),
    });
  }

  let probe: { ok: boolean; httpStatus: number; projectCount: number; note?: string } | null = null;
  try {
    const res = await mgmtListProjects(pat);
    probe = {
      ok: res.ok,
      httpStatus: res.status,
      projectCount: res.ok ? res.projects.length : 0,
    };
  } catch (e) {
    probe = {
      ok: false,
      httpStatus: 0,
      projectCount: 0,
      note: e instanceof Error ? e.message : "probe failed",
    };
  }

  return NextResponse.json({
    ok: true,
    patPresent: true,
    masked: maskMgmtPat(pat),
    probe,
    mgmt: mgmtClientState(),
  });
}
