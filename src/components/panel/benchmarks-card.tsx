"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ChevronDown, ChevronUp, Globe, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

/**
 * Task R18-c — model benchmark card. Shows the six owner-specified board
 * sources (Artificial Analysis + five arena.ai leaderboards) with honest,
 * measured state only: LIVE / FAILED / "— never fetched" badges, the transport
 * that produced the data (direct / hyperbrowser / pool), per-source refresh
 * and one Refresh-all button, and the top entries parsed from the live pages.
 *
 * Honest states only (P7 / honest-failure doctrine): a badge is rendered ONLY
 * from a stored snapshot; failures show their typed code+message muted; the
 * never-fetched state says so and points at the bench-cadence service. No
 * fabricated rows, ever.
 *
 * Self-contained by contract: it talks to /api/benchmarks only and imports
 * nothing from brain-tab / role-bindings (R18-b's tab mounts this component).
 */

// ---------------------------------------------------------------------------
// Types (mirror of the /api/benchmarks GET contract)
// ---------------------------------------------------------------------------

type BenchEntryRow = {
  model: string;
  norm: string;
  score: number | null;
  rank: number | null;
};

type BenchSourceRow = {
  kind: string;
  label: string;
  url: string;
  /** R19-b — the metric this board scores on (rendered in the header line). */
  metricLabel?: string | null;
  /** R19-b — "percent" scores render with a % suffix, "plain" stay bare. */
  metricUnit?: string | null;
  ok: boolean;
  fetchedAt: string | null;
  ageHours: number | null;
  modelCount: number | null;
  via: string | null;
  error: { code: string; message: string } | null;
  /** R19-b — parse-anomaly warning (e.g. out-of-range scores), else null. */
  notes?: string | null;
  /** R20-a — the source board's own header stamp (date/sessions/models), else null. */
  boardMeta?: { date: string | null; sessions: string | null; models: number | null } | null;
  /** R20-a — "board" ranks are the source's own positions; "derived" = score order; null = legacy. */
  rankSource?: "board" | "derived" | null;
  entries: BenchEntryRow[];
};

type BenchmarksResponse = { ok: true; sources: BenchSourceRow[] };

type ApiErrorShape = { ok: false; error: { code: string; message: string } };

type RefreshResultRow = {
  kind: string;
  ok: boolean;
  via: string;
  modelCount: number | null;
  error: { code: string; message: string } | null;
};

/** Extracts the §11 message from a failed response body. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as ApiErrorShape | null;
  return body?.error?.message ?? fallback;
}

const TOP_PREVIEW = 8;

/**
 * Score formatting with metric awareness (R19-b): percent metrics carry a %
 * suffix so "20.77" reads as what it is; Elo-like / index scores stay plain
 * numbers. Tolerates a missing metricUnit (older API shape) → plain.
 */
function formatScore(score: number | null, metricUnit?: string | null): string {
  if (score === null) return "—";
  const body = score % 1 === 0 ? String(score) : score.toFixed(2);
  return metricUnit === "percent" ? `${body}%` : body;
}

function viaLabel(via: string | null): string {
  if (!via) return "";
  switch (via) {
    case "direct":
      return "direct";
    case "hyperbrowser":
      return "hyperbrowser";
    case "pool":
      return "proxy pool";
    case "tinyfish":
      return "tinyfish (residential)";
    case "firecrawl":
      return "firecrawl (metered)";
    case "failed":
      return "failed";
    default:
      return via;
  }
}

// ---------------------------------------------------------------------------
// Per-source block
// ---------------------------------------------------------------------------

function SourceBlock({
  row,
  refreshing,
  onRefresh,
}: {
  row: BenchSourceRow;
  refreshing: boolean;
  onRefresh: (kind: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const neverFetched = row.fetchedAt === null;
  const failed = !row.ok && !neverFetched;
  const shown = expanded ? row.entries.slice(0, 300) : row.entries.slice(0, TOP_PREVIEW);

  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-md border border-border/60 p-3" aria-label={row.label}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="min-w-0 flex-1 truncate text-sm font-medium">{row.label}</h4>
        {neverFetched ? (
          <Badge variant="outline" className="shrink-0 border-border/60 text-muted-foreground">
            —
          </Badge>
        ) : row.ok ? (
          <Badge variant="outline" className="shrink-0 border-primary/40 text-primary">
            LIVE
          </Badge>
        ) : (
          <Badge variant="outline" className="shrink-0 border-destructive/50 text-destructive">
            FAILED
          </Badge>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-11 shrink-0 px-3"
          disabled={refreshing}
          onClick={() => onRefresh(row.kind)}
          aria-label={`Refresh ${row.label}`}
        >
          <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {neverFetched ? (
          <>
            {row.metricLabel ? `${row.metricLabel} · ` : ""}never fetched
          </>
        ) : (
          <>
            {row.ok && row.modelCount !== null ? `${row.modelCount} models · ` : ""}
            {row.metricLabel ? `${row.metricLabel} · ` : ""}
            {viaLabel(row.via)}
            {row.via ? " · " : ""}
            fetched {formatDistanceToNow(new Date(row.fetchedAt as string), { addSuffix: true })}
          </>
        )}
      </p>

      {row.ok && row.boardMeta && (row.boardMeta.date || row.boardMeta.sessions) && (
        <p className="text-[11px] leading-snug text-muted-foreground/70">
          board as of {row.boardMeta.date ?? "unknown date"}
          {row.boardMeta.sessions ? ` · ${row.boardMeta.sessions} sessions` : ""}
          {row.rankSource === "board" ? " · mirror of the board's own order" : ""}
        </p>
      )}

      {failed && row.error && (
        <p className="text-[11px] leading-snug text-muted-foreground/80">
          <span className="font-mono text-destructive/80">{row.error.code}</span> — {row.error.message}
        </p>
      )}

      {row.ok && row.notes && (
        <p className="text-[11px] leading-snug text-muted-foreground/80" role="note">
          <span className="font-mono text-accent">parse warning</span> — {row.notes}
        </p>
      )}

      {row.ok && row.entries.length > 0 && (
        <>
          <ul className="max-h-64 space-y-0.5 overflow-y-auto rounded-md border border-border/60 p-2 font-mono text-[11px] [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar]:w-1.5">
            {shown.map((e) => (
              <li key={`${row.kind}-${e.norm}`} className="flex min-w-0 items-baseline justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-foreground/90" title={e.model}>
                  <span className="text-muted-foreground/70">{e.rank !== null ? `#${e.rank} ` : ""}</span>
                  {e.model}
                </span>
                <span
                  className="shrink-0 text-primary/90"
                  title={row.metricLabel ?? undefined}
                  aria-label={row.metricLabel ? `${formatScore(e.score, row.metricUnit)} ${row.metricLabel}` : undefined}
                >
                  {formatScore(e.score, row.metricUnit)}
                </span>
              </li>
            ))}
          </ul>
          {row.entries.length > TOP_PREVIEW && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-9 w-full text-xs text-muted-foreground"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
            >
              {expanded ? (
                <>
                  <ChevronUp className="size-3.5" aria-hidden="true" /> Top {TOP_PREVIEW}
                </>
              ) : (
                <>
                  <ChevronDown className="size-3.5" aria-hidden="true" /> Show all {row.entries.length}
                </>
              )}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export function BenchmarksCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [refreshingKinds, setRefreshingKinds] = useState<Set<string>>(new Set());

  const query = useQuery({
    queryKey: ["benchmarks"],
    queryFn: async (): Promise<BenchmarksResponse> => {
      const res = await fetch("/api/benchmarks", { cache: "no-store" });
      if (!res.ok) throw new Error(await errorMessage(res, `Could not load benchmarks (HTTP ${res.status})`));
      return (await res.json()) as BenchmarksResponse;
    },
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["benchmarks"], exact: true });

  const markRefreshing = (kind: string, on: boolean) => {
    setRefreshingKinds((prev) => {
      const next = new Set(prev);
      if (on) next.add(kind);
      else next.delete(kind);
      return next;
    });
  };

  const refreshOne = useMutation({
    mutationFn: async (kind: string) => {
      const res = await fetch("/api/benchmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, `Refresh failed (HTTP ${res.status})`));
      return (await res.json()) as { ok: true; results: RefreshResultRow[] };
    },
    onMutate: (kind) => markRefreshing(kind, true),
    onSettled: (_d, _e, kind) => markRefreshing(kind, false),
    onSuccess: (data) => {
      invalidate();
      const r = data.results[0];
      if (r && r.ok) {
        toast({
          title: `${r.kind} refreshed`,
          description: `${r.modelCount ?? 0} models via ${viaLabel(r.via)}.`,
        });
      } else if (r) {
        toast({
          title: `${r.kind} refresh failed`,
          description: r.error ? `${r.error.code} — ${r.error.message}` : "no usable data returned.",
          variant: "destructive",
        });
      }
    },
    onError: (e: Error) => toast({ title: "Refresh failed", description: e.message, variant: "destructive" }),
  });

  const refreshAll = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/benchmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(await errorMessage(res, `Refresh failed (HTTP ${res.status})`));
      return (await res.json()) as { ok: true; results: RefreshResultRow[] };
    },
    onSuccess: (data) => {
      invalidate();
      const okCount = data.results.filter((r) => r.ok).length;
      const failCount = data.results.length - okCount;
      const fresh = (query.data?.sources.length ?? 6) - data.results.length;
      const parts: string[] = [];
      if (data.results.length === 0) parts.push("nothing to do — all sources fresh (< 6h old)");
      if (okCount > 0) parts.push(`${okCount} refreshed`);
      if (failCount > 0) parts.push(`${failCount} failed (honest failure shown on the card)`);
      if (fresh > 0) parts.push(`${fresh} already fresh`);
      toast({
        title: "Benchmark refresh",
        description: parts.join(" · ") + ".",
        variant: failCount > 0 ? "destructive" : undefined,
      });
    },
    onError: (e: Error) => toast({ title: "Refresh failed", description: e.message, variant: "destructive" }),
  });

  const sources = query.data?.sources ?? [];
  const neverFetchedAny = sources.length > 0 && sources.every((s) => s.fetchedAt === null);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Globe className="size-4 text-primary" aria-hidden="true" />
            Model benchmarks
          </CardTitle>
          <div className="min-w-0 flex-1" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11"
            disabled={refreshAll.isPending}
            onClick={() => refreshAll.mutate()}
          >
            <RefreshCw className={`size-4 ${refreshAll.isPending ? "animate-spin" : ""}`} aria-hidden="true" />
            {refreshAll.isPending ? "Refreshing…" : "Refresh all"}
          </Button>
        </div>
        <CardDescription>
          Fresh model ordering from Artificial Analysis + arena.ai — auto-refreshed every 6 hours by the
          bench-cadence service; JS-guarded boards render through Hyperbrowser.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Loading benchmarks">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-36 w-full" />
            ))}
          </div>
        ) : query.isError ? (
          <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
            <p className="font-medium">Benchmarks unavailable</p>
            <p className="mt-1 text-xs text-muted-foreground">{(query.error as Error).message}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 min-h-11"
              onClick={() => void query.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : neverFetchedAny ? (
          <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            <p>
              No snapshots yet — the bench-cadence service refreshes every 6 hours (first run shortly after
              boot); press Refresh to fetch now.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {sources.map((row) => (
              <SourceBlock
                key={row.kind}
                row={row}
                refreshing={refreshingKinds.has(row.kind) || refreshAll.isPending}
                onRefresh={(kind) => refreshOne.mutate(kind)}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
