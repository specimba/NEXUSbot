"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  ExternalLink,
  LoaderCircle,
  Radar,
  RefreshCw,
  Send,
  Square,
  Telescope,
} from "lucide-react";
import {
  fetchExaJson,
  hostFromUrl,
  isNotConfigured,
  isRateLimited,
  relativeTime,
  RESEARCH_EFFORTS,
  type BrainAnswerResponse,
  type ExaCitation,
  type ExaNewsResponse,
  type ResearchDetailResponse,
  type ResearchEffort,
  type ResearchJob,
  type ResearchLaunchResponse,
  type ResearchListResponse,
} from "./exa-api";

/**
 * Task 15-b — Exa Deep Research card (full-width, sits above the custom
 * providers in the Connectors tab). Four sections: grounded answer (fast
 * /answer), deep-research runs (async Exa Agent), the run ledger, and the AI
 * News Radar strip. Everything degrades honestly: while the backend lands
 * (Task 15-a) or before a key is saved, every section shows muted
 * "unavailable"/"save your key" states — the panel never crashes.
 */

const NOT_CONFIGURED_HINT = "Save your Exa API key in the connector card above first.";

const LIST_SCROLLBAR =
  "overflow-y-auto pr-1 [scrollbar-color:theme(colors.primary/40)_transparent] [scrollbar-width:thin]";

function CitationList({ citations, label }: { citations: ExaCitation[]; label: string }) {
  if (!citations || citations.length === 0) return null;
  return (
    <ul className="space-y-1.5" aria-label={label}>
      {citations.map((c, i) => (
        <li key={`${c.url}-${i}`} className="flex min-w-0 items-center gap-1.5 text-xs">
          <ExternalLink className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          <a
            href={c.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate text-primary hover:underline"
          >
            {c.title?.trim() || hostFromUrl(c.url)}
          </a>
        </li>
      ))}
    </ul>
  );
}

function jobStatusChip(status: string): { label: string; className: string } {
  switch (status) {
    case "queued":
      return { label: "queued", className: "border-accent/60 text-accent" };
    case "running":
      return { label: "running", className: "border-primary/40 text-primary animate-pulse" };
    case "completed":
      return { label: "completed", className: "border-primary/40 text-primary" };
    case "failed":
    case "stopped":
      return { label: status, className: "border-destructive/50 text-destructive" };
    default:
      return { label: status || "unknown", className: "text-muted-foreground" };
  }
}

function isActive(status: string | null | undefined): boolean {
  return status === "queued" || status === "running";
}

/** Expanded run detail: fetched on open via ["exa-research", id], polled while active. */
function JobDetail({ job }: { job: ResearchJob }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const detail = useQuery<ResearchDetailResponse>({
    queryKey: ["exa-research", job.id],
    queryFn: () => fetchExaJson<ResearchDetailResponse>(`/api/exa/research/${job.id}`),
    refetchInterval: (query) =>
      isActive(query.state.data?.job?.status) ? 10_000 : false,
  });

  const stop = useMutation({
    mutationFn: () =>
      fetchExaJson<ResearchLaunchResponse>(`/api/exa/research/${job.id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["exa-research-jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["exa-research", job.id] });
      toast({ title: "Run stopped", description: "The research run was halted by the owner." });
    },
    onError: (e: Error) =>
      toast({
        title: "Stop failed",
        description: e.message,
        variant: "destructive",
      }),
  });

  const d = detail.data?.job ?? null;
  const liveStatus = d?.status ?? job.status;

  return (
    <div className="space-y-3 border-t border-border/60 px-3 py-3">
      {detail.isLoading ? (
        <div className="space-y-2" aria-label="Loading run details">
          <Skeleton className="h-16 rounded-md" />
          <Skeleton className="h-4 w-2/3 rounded-md" />
        </div>
      ) : detail.isError ? (
        <p className="text-xs text-muted-foreground" role="note">
          Run details unavailable — retrying automatically.
        </p>
      ) : d ? (
        <div className="space-y-3" aria-live="polite">
          {d.stopReason ? (
            <p className="font-mono text-[11px] text-muted-foreground">stop reason: {d.stopReason}</p>
          ) : null}
          {d.error ? (
            <p className="text-sm text-destructive" role="alert">
              {d.error}
            </p>
          ) : null}
          {d.answer ? (
            <div className={cn("max-h-72 whitespace-pre-wrap text-sm", LIST_SCROLLBAR)}>
              {d.answer}
            </div>
          ) : !d.error ? (
            <p className="text-xs text-muted-foreground">
              {isActive(liveStatus)
                ? "The agent is still researching — this panel updates as it works."
                : "No answer text was recorded for this run."}
            </p>
          ) : null}
          <CitationList citations={d.citations ?? []} label={`Sources for "${job.query}"`} />
          {d.structured ? (
            <pre
              className={cn(
                "max-h-48 overflow-auto rounded-md border border-border/60 bg-background/50 p-2 font-mono text-xs text-muted-foreground",
                LIST_SCROLLBAR,
              )}
              aria-label="Structured output"
            >
              {JSON.stringify(d.structured, null, 2)}
            </pre>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
            {d.costDollars !== null && d.costDollars !== undefined ? (
              <span>${d.costDollars.toFixed(4)}</span>
            ) : null}
            {d.tookMs !== null && d.tookMs !== undefined ? (
              <span>took {(d.tookMs / 1000).toFixed(1)}s</span>
            ) : null}
            {d.completedAt && relativeTime(d.completedAt) ? (
              <span>
                completed{" "}
                <time dateTime={d.completedAt} suppressHydrationWarning>
                  {relativeTime(d.completedAt)}
                </time>
              </span>
            ) : null}
            {isActive(liveStatus) ? (
              <Button
                variant="ghost"
                className="min-h-11 text-destructive hover:text-destructive"
                disabled={stop.isPending}
                aria-label={`Stop research run ${job.id}`}
                onClick={() => stop.mutate()}
              >
                <Square className="size-4" aria-hidden="true" />
                {stop.isPending ? "Stopping…" : "Stop run"}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function JobRow({ job }: { job: ResearchJob }) {
  const [open, setOpen] = useState(false);
  const chip = jobStatusChip(job.status);
  const created = relativeTime(job.createdAt);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border border-border/60">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent/40 dark:hover:bg-accent/25"
          aria-expanded={open}
          aria-label={`${job.status} research run: ${job.query}. ${open ? "Collapse" : "Expand"} details.`}
        >
          <Badge variant="outline" className={cn("shrink-0 font-mono text-[10px]", chip.className)}>
            {chip.label}
          </Badge>
          <span className="min-w-0 flex-1 truncate font-mono text-sm" title={job.query}>
            {job.query}
          </span>
          <Badge
            variant="outline"
            className="hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:inline-flex"
          >
            {job.effort}
          </Badge>
          {job.costDollars !== null && job.costDollars !== undefined ? (
            <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">
              ${job.costDollars.toFixed(4)}
            </span>
          ) : null}
          {job.tookMs !== null && job.tookMs !== undefined ? (
            <span className="hidden shrink-0 font-mono text-xs text-muted-foreground md:inline">
              took {(job.tookMs / 1000).toFixed(1)}s
            </span>
          ) : null}
          {created ? (
            <time
              dateTime={job.createdAt}
              suppressHydrationWarning
              className="hidden shrink-0 text-xs text-muted-foreground md:inline"
            >
              {created}
            </time>
          ) : null}
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>{open ? <JobDetail job={job} /> : null}</CollapsibleContent>
    </Collapsible>
  );
}

export function ExaResearchCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [answerQuery, setAnswerQuery] = useState("");
  const [runQuery, setRunQuery] = useState("");
  const [effort, setEffort] = useState<ResearchEffort>("medium");

  /* ── Section 1 — grounded answer (fast /answer) ─────────────────────── */
  const ask = useMutation({
    mutationFn: (query: string) =>
      fetchExaJson<BrainAnswerResponse>("/api/brain/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, mode: "answer" }),
      }),
    onError: (e: Error) => {
      if (isNotConfigured(e)) return; // honest inline hint below the form instead
      toast({ title: "Answer failed", description: e.message, variant: "destructive" });
    },
  });

  /* ── Section 2/3 — launch + run ledger ──────────────────────────────── */
  const launch = useMutation({
    mutationFn: (input: { query: string; effort: ResearchEffort }) =>
      fetchExaJson<ResearchLaunchResponse>("/api/exa/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: (data) => {
      setRunQuery("");
      void queryClient.invalidateQueries({ queryKey: ["exa-research-jobs"] });
      toast({
        title: "Deep-research run launched",
        description: `effort ${data.job.effort} — the agent researches and reports back with sources. Track it under Runs.`,
      });
    },
    onError: (e: Error) => {
      if (isNotConfigured(e)) return; // inline hint below the form
      if (isRateLimited(e)) {
        toast({
          title: "Rate limited",
          description: "5 runs per 10 minutes — wait a moment.",
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Launch failed", description: e.message, variant: "destructive" });
    },
  });

  const jobs = useQuery<ResearchListResponse>({
    queryKey: ["exa-research-jobs"],
    queryFn: () => fetchExaJson<ResearchListResponse>("/api/exa/research"),
    // Poll only while a run is actually in flight — otherwise quiet.
    refetchInterval: (query) =>
      (query.state.data?.jobs ?? []).some((j) => isActive(j.status)) ? 10_000 : false,
  });

  /* ── Section 4 — AI News Radar ───────────────────────────────────────── */
  const news = useQuery<ExaNewsResponse>({
    queryKey: ["exa-news"],
    queryFn: () => fetchExaJson<ExaNewsResponse>("/api/exa/news"),
    staleTime: 5 * 60_000,
  });

  const refreshNews = useMutation({
    mutationFn: () => fetchExaJson<ExaNewsResponse>("/api/exa/news?refresh=1"),
    onSuccess: (data) => {
      queryClient.setQueryData(["exa-news"], data);
      toast({
        title: "AI News Radar refreshed",
        description: `${data.fresh ? "Fresh" : "Cached"} brief · ${(data.brief?.items ?? []).length} items.`,
      });
    },
    onError: (e: Error) =>
      toast({ title: "Radar refresh failed", description: e.message, variant: "destructive" }),
  });

  const answerResult = ask.data;
  const askHint = ask.isError && isNotConfigured(ask.error);
  const launchHint = launch.isError && isNotConfigured(launch.error);
  const newsItems = news.data?.brief?.items ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 font-mono">
          <Telescope className="size-5 shrink-0 text-primary" aria-hidden="true" />
          Exa Deep Research
        </CardTitle>
        <CardDescription>
          Async Exa Agent runs — exhaustive multi-source research with citations. Effort sets the
          per-run cost cap: low $0.50 · medium $1 · high $3 · xhigh $5 · ultra $10.
        </CardDescription>
      </CardHeader>

      <CardContent className="divide-y divide-border/60">
        {/* Section 1 — Grounded answer */}
        <section aria-label="Grounded answer" className="space-y-3 pb-5">
          <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Grounded answer
          </p>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              const q = answerQuery.trim();
              if (q.length >= 3) ask.mutate(q);
            }}
          >
            <Label htmlFor="exa-answer-query" className="sr-only">
              Question for the grounded answer
            </Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="exa-answer-query"
                className="min-h-11"
                placeholder="Ask something that needs sources — e.g. WoW Lacrimose Rank-up badge requirements"
                value={answerQuery}
                onChange={(e) => setAnswerQuery(e.target.value)}
                disabled={ask.isPending}
              />
              <Button
                type="submit"
                className="min-h-11 shrink-0 font-mono"
                disabled={answerQuery.trim().length < 3 || ask.isPending}
              >
                {ask.isPending ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : null}
                {ask.isPending ? "Asking…" : "Ask"}
              </Button>
            </div>
          </form>
          {askHint ? (
            <p className="text-xs text-muted-foreground" role="note">
              {NOT_CONFIGURED_HINT}
            </p>
          ) : null}
          {answerResult ? (
            <div className="space-y-3 rounded-md border border-border/60 p-3" aria-live="polite">
              <p className="whitespace-pre-wrap text-sm">{answerResult.answer}</p>
              <CitationList
                citations={answerResult.citations ?? []}
                label="Answer sources"
              />
              <p className="font-mono text-[11px] text-muted-foreground">
                provider {answerResult.provider ?? "exa"} · took{" "}
                {((answerResult.tookMs ?? 0) / 1000).toFixed(1)}s
                {typeof answerResult.costDollars === "number"
                  ? ` · ~$${answerResult.costDollars.toFixed(4)}`
                  : ""}
              </p>
            </div>
          ) : null}
        </section>

        {/* Section 2 — Launch a deep-research run */}
        <section aria-label="Launch a deep-research run" className="space-y-3 py-5">
          <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Launch a deep-research run
          </p>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              const q = runQuery.trim();
              if (q.length >= 3) launch.mutate({ query: q, effort });
            }}
          >
            <Label htmlFor="exa-research-query" className="sr-only">
              Research question
            </Label>
            <Textarea
              id="exa-research-query"
              rows={2}
              placeholder="e.g. Bugün yapay zeka dünyasında en son ne var? — the agent researches and reports back with sources"
              value={runQuery}
              onChange={(e) => setRunQuery(e.target.value)}
              disabled={launch.isPending}
            />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select value={effort} onValueChange={(v) => setEffort(v as ResearchEffort)}>
                <SelectTrigger
                  className="min-h-11 w-full font-mono sm:w-56"
                  aria-label="Research effort and cost cap"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESEARCH_EFFORTS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value} className="font-mono">
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="submit"
                className="min-h-11 shrink-0 font-mono"
                disabled={runQuery.trim().length < 3 || launch.isPending}
              >
                {launch.isPending ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Send className="size-4" aria-hidden="true" />
                )}
                {launch.isPending ? "Launching…" : "Launch run"}
              </Button>
            </div>
          </form>
          {launchHint ? (
            <p className="text-xs text-muted-foreground" role="note">
              {NOT_CONFIGURED_HINT}
            </p>
          ) : null}
        </section>

        {/* Section 3 — Runs ledger */}
        <section aria-label="Research runs" className="space-y-3 py-5">
          <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Runs
          </p>
          {jobs.isLoading ? (
            <div className="space-y-2" aria-label="Loading research runs">
              <Skeleton className="h-11 rounded-md" />
              <Skeleton className="h-11 rounded-md" />
              <Skeleton className="h-11 w-2/3 rounded-md" />
            </div>
          ) : jobs.isError ? (
            <p className="text-xs text-muted-foreground" role="note">
              Runs unavailable — retrying automatically.
            </p>
          ) : (jobs.data?.jobs ?? []).length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              No research runs yet — launch one above.
            </p>
          ) : (
            <div className={cn("max-h-96 space-y-2", LIST_SCROLLBAR)} aria-label="Research run rows">
              {(jobs.data?.jobs ?? []).map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </div>
          )}
        </section>

        {/* Section 4 — AI News Radar */}
        <section aria-label="AI News Radar" className="space-y-3 pt-5">
          <p className="flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
            <Radar className="size-4 shrink-0 text-primary" aria-hidden="true" />
            AI News Radar
          </p>
          {news.isLoading ? (
            <div className="space-y-2" aria-label="Loading news radar">
              <Skeleton className="h-9 rounded-md" />
              <Skeleton className="h-9 rounded-md" />
              <Skeleton className="h-9 w-3/4 rounded-md" />
            </div>
          ) : news.isError ? (
            isNotConfigured(news.error) ? (
              <p className="text-xs text-muted-foreground" role="note">
                {NOT_CONFIGURED_HINT}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground" role="note">
                Radar unavailable.
              </p>
            )
          ) : newsItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No radar items yet — refresh to pull the latest AI news through Exa.
            </p>
          ) : (
            <>
              <ul className="divide-y divide-border/60 rounded-md border border-border/60">
                {newsItems.slice(0, 6).map((item, i) => {
                  const rel = relativeTime(item.date);
                  return (
                    <li key={`${item.url}-${i}`}>
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex min-h-11 items-center gap-2.5 px-3 py-2 transition-colors hover:bg-accent/40 dark:hover:bg-accent/25"
                        aria-label={`AI news ${i + 1}: ${item.title} (${item.host})`}
                      >
                        <span className="shrink-0 font-mono text-xs text-primary">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm" title={item.title}>
                          {item.title}
                        </span>
                        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                          {item.host}
                        </span>
                        {rel ? (
                          <time
                            dateTime={item.date}
                            suppressHydrationWarning
                            className="shrink-0 text-xs text-muted-foreground"
                          >
                            {rel}
                          </time>
                        ) : null}
                      </a>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-mono text-[11px] text-muted-foreground">
                  {news.data?.fresh === true ? "fresh" : "cached"} · took{" "}
                  {((news.data?.brief?.tookMs ?? 0) / 1000).toFixed(1)}s
                  {typeof news.data?.brief?.costDollars === "number"
                    ? ` · ~$${news.data.brief.costDollars.toFixed(4)}`
                    : ""}
                </p>
                <Button
                  variant="outline"
                  className="min-h-11 font-mono"
                  disabled={refreshNews.isPending}
                  aria-label="Radar yenile — pull a fresh AI news brief"
                  onClick={() => refreshNews.mutate()}
                >
                  <RefreshCw
                    className={cn("size-4", refreshNews.isPending && "animate-spin")}
                    aria-hidden="true"
                  />
                  Radar yenile
                </Button>
              </div>
            </>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
