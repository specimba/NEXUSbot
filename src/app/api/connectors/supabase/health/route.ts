import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  getMgmtPat,
  mgmtClientState,
  mgmtProjectHealth,
  mgmtListProjects,
} from "@/lib/connectors/supabase";

/**
 * GET /api/connectors/supabase/health (session required)
 * Per-project health, MEASURED: one GET /v1/projects, then per project
 * (capped at 10 to respect the 120 req/min budget) GET /v1/projects/{ref}/health.
 * Every row carries the real upstream HTTP status. An upstream auth failure is
 * reported honestly (probeOk=false + httpStatus) — never dressed up as healthy.
 */
const MAX_HEALTH_PROBES = 10;

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  const pat = await getMgmtPat();
  if (!pat) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "NOT_STORED", message: "No Management PAT stored — add one first." },
      },
      { status: 409 },
    );
  }

  const checkedAt = new Date().toISOString();

  let projectsRes;
  try {
    projectsRes = await mgmtListProjects(pat);
  } catch (e) {
    return NextResponse.json({
      ok: true,
      probeOk: false,
      httpStatus: 0,
      checkedAt,
      projects: [],
      note: e instanceof Error ? e.message : "probe failed",
      mgmt: mgmtClientState(),
    });
  }

  if (!projectsRes.ok) {
    return NextResponse.json({
      ok: true,
      probeOk: false,
      httpStatus: projectsRes.status,
      checkedAt,
      projects: [], // an auth/permission failure must NOT fabricate project rows
      mgmt: mgmtClientState(),
    });
  }

  const projects = await Promise.all(
    projectsRes.projects.slice(0, MAX_HEALTH_PROBES).map(async (p) => {
      try {
        const h = await mgmtProjectHealth(pat, p.ref);
        return {
          ref: p.ref,
          name: p.name,
          region: p.region,
          status: p.status,
          health: {
            ok: h.ok,
            httpStatus: h.status,
            reports: h.ok ? h.reports : [],
          },
        };
      } catch (e) {
        return {
          ref: p.ref,
          name: p.name,
          region: p.region,
          status: p.status,
          health: {
            ok: false,
            httpStatus: 0,
            reports: [] as Array<{ service: string; healthy: boolean; status: string | null }>,
            note: e instanceof Error ? e.message : "probe failed",
          },
        };
      }
    }),
  );

  return NextResponse.json({
    ok: true,
    probeOk: true,
    httpStatus: projectsRes.status,
    checkedAt,
    projects,
    mgmt: mgmtClientState(),
  });
}
