import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import {
  BENCH_SOURCES,
  getBenchmarkSnapshot,
  isStale,
  refreshBenchmark,
  type BenchKind,
  type BenchRefreshResult,
  type BenchSnapshot,
} from "@/lib/benchmarks";
export const dynamic = "force-dynamic";

/**
 * Task R18-c — model benchmark board (STABLE CONTRACT — R18-b's Brain tab and
 * the bench-cadence mini-service both consume this route).
 *
 * GET  → { ok, sources:[{kind,label,url,ok,fetchedAt,ageHours,modelCount,via,
 *        error,entries}] } — entries always included (6×300 rows is fine).
 *        R19-b ADDITIVE: each source also carries metricLabel (the metric the
 *        board scores on, e.g. "Arena Elo (chat)" vs "Net Improvement %
 *        (agent)"), metricUnit ("percent"|"plain" — percent scores render
 *        with a % suffix) and notes (parse-anomaly warnings, else null).
 *        R20-a ADDITIVE: each source also carries boardMeta
 *        ({date,sessions,models} — the source board's own header stamp, so
 *        the panel shows WHICH vintage it mirrors) and rankSource ("board" =
 *        ranks are the board's own positions — arena boards are NEVER
 *        re-sorted by score, their tail segments ascend; "derived" =
 *        aa-index score-order ranks; null = legacy snapshot).
 *        Existing consumers ignore unknown fields — contract not broken.
 * POST → body {}     : refresh ALL stale-or-missing sources (sequential)
 *        body {kind} : refresh exactly that source regardless of staleness
 *      → { ok, results:[{kind,ok,via,modelCount,error}] } — honest per-source
 *        outcomes; an outer ok:true means the route ran, NEVER that every
 *        source succeeded (per-source ok carries the truth; no fake success).
 *
 * §11: 401 UNAUTHORIZED, 429 RATE_LIMITED, 400 INVALID_BODY / INVALID_KIND.
 * Refreshes are heavyweight (up to ~20 s per JS-rendered source through the
 * Hyperbrowser fallback) → POST is limited to 4/hour, GET to 30/min.
 */

type SourceState = {
  kind: BenchKind;
  label: string;
  url: string;
  /** R19-b additive — the metric this board scores on (never bare numbers). */
  metricLabel: string;
  /** R19-b additive — "percent" scores render with a % suffix, "plain" don't. */
  metricUnit: string;
  ok: boolean;
  fetchedAt: string | null;
  ageHours: number | null;
  modelCount: number | null;
  via: string | null;
  error: { code: string; message: string } | null;
  /** R19-b additive — parse-anomaly warning (e.g. out-of-range scores), else null. */
  notes: string | null;
  /** R20-a additive — the source board's own header stamp (date/sessions/models), else null. */
  boardMeta: { date: string | null; sessions: string | null; models: number | null } | null;
  /** R20-a additive — "board" = the source's own rank positions; "derived" = score order; null = legacy. */
  rankSource: "board" | "derived" | null;
  entries: { model: string; norm: string; score: number | null; rank: number | null }[];
};

function sourceState(
  kind: BenchKind,
  label: string,
  url: string,
  metricLabel: string,
  metricUnit: string,
  snap: BenchSnapshot | null,
): SourceState {
  const neverFetched = !snap || !snap.fetchedAt;
  if (neverFetched) {
    return {
      kind,
      label,
      url,
      metricLabel,
      metricUnit,
      ok: false,
      fetchedAt: null,
      ageHours: null,
      modelCount: null,
      via: null,
      error: {
        code: "NEVER_FETCHED",
        message: "no snapshot yet — the bench-cadence service fetches this source shortly after boot",
      },
      notes: null,
      boardMeta: null,
      rankSource: null,
      entries: [],
    };
  }
  const t = Date.parse(snap.fetchedAt);
  const ageHours = Number.isFinite(t) ? Math.max(0, Math.round(((Date.now() - t) / 3_600_000) * 10) / 10) : null;
  return {
    kind,
    label,
    url,
    metricLabel,
    metricUnit,
    ok: snap.ok,
    fetchedAt: snap.fetchedAt,
    ageHours,
    modelCount: snap.ok ? snap.modelCount : null,
    via: snap.via,
    error: snap.error,
    notes: snap.ok ? snap.notes : null,
    boardMeta: snap.ok ? (snap.boardMeta ?? null) : null,
    rankSource: snap.ok ? (snap.rankSource ?? null) : null,
    entries: snap.entries,
  };
}

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  if (!rateLimit(`bench-read:${clientKey(req)}`, 30, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many benchmark reads — slow down." } },
      { status: 429 },
    );
  }

  const sources: SourceState[] = [];
  for (const src of BENCH_SOURCES) {
    const snap = await getBenchmarkSnapshot(src.kind);
    sources.push(sourceState(src.kind, src.label, src.url, src.metricLabel, src.metricUnit, snap));
  }
  return NextResponse.json({ ok: true, sources });
}

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  if (!rateLimit(`bench-refresh:${clientKey(req)}`, 4, 60 * 60_000)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "RATE_LIMITED",
          message: "Benchmark refreshes are limited to 4 per hour (each refresh runs live scrapes).",
        },
      },
      { status: 429 },
    );
  }

  const body = (await req.json().catch(() => null)) as { kind?: unknown } | null;
  if (body !== null && typeof body !== "object") {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_BODY", message: "Body must be a JSON object: {} or {kind}." } },
      { status: 400 },
    );
  }
  const kindRaw = body?.kind;
  if (kindRaw !== undefined && typeof kindRaw !== "string") {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_KIND", message: "kind must be a string benchmark source id." } },
      { status: 400 },
    );
  }
  if (typeof kindRaw === "string") {
    const src = BENCH_SOURCES.find((s) => s.kind === kindRaw);
    if (!src) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "INVALID_KIND",
            message: `unknown benchmark kind — use one of: ${BENCH_SOURCES.map((s) => s.kind).join(", ")}.`,
          },
        },
        { status: 400 },
      );
    }
    const result = await refreshBenchmark(src.kind, "api:one");
    return NextResponse.json({ ok: true, results: [result] });
  }

  // body {} → refresh all stale-or-missing sources, sequentially (the mutex in
  // refreshBenchmark dedupes concurrent in-flight per-kind refreshes).
  const results: BenchRefreshResult[] = [];
  for (const src of BENCH_SOURCES) {
    const snap = await getBenchmarkSnapshot(src.kind);
    if (!isStale(snap)) continue;
    results.push(await refreshBenchmark(src.kind, "api:stale"));
  }
  return NextResponse.json({ ok: true, results });
}
