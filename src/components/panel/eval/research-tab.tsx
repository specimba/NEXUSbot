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
import {
  ExternalLink,
  BookOpen,
  ChevronDown,
  LoaderCircle,
  Send,
  Telescope,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchRsiJson,
  PAPER_CATEGORIES,
  RESEARCH_EFFORT_OPTIONS,
  SUGGESTED_RESEARCH_QUERIES,
  type RsiPaper,
  type RsiPapersResponse,
} from "./api";
import {
  fetchExaJson,
  isNotConfigured,
  isRateLimited,
  relativeTime,
  type ResearchLaunchResponse,
  type ResearchListResponse,
  type ResearchJob,
} from "../connectors/exa-api";

const LIST_SCROLLBAR =
  "overflow-y-auto pr-1 [scrollbar-color:theme(colors.primary/40)_transparent] [scrollbar-width:thin]";

function relevanceClass(relevance: string): string {
  switch (relevance) {
    case "core":
      return "border-primary/40 text-primary";
    case "supporting":
      return "border-accent/60 text-accent";
    default:
      return "text-muted-foreground";
  }
}

/**
 * Research tab — two sections:
 *  (a) the curated papers library (48 web-abstract-verified entries) with
 *      search + category chips, in a capped scroll area;
 *  (b) the EXISTING Exa Deep Research launcher + job ledger (same engine
 *      the Connectors tab uses; queries suggested for RSI topics).
 */
export function RsiResearchTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [researchQuery, setResearchQuery] = useState("");
  const [effort, setEffort] = useState<string>("medium");

  const papers = useQuery<RsiPapersResponse>({
    queryKey: ["rsi-papers", query, category],
    queryFn: () => {
      const params = new URLSearchParams();
      if (query.trim()) params.set("query", query.trim());
      if (category !== "all") params.set("category", category);
      return fetchRsiJson<RsiPapersResponse>(`/api/rsi/papers?${params.toString()}`);
    },
  });

  const launch = useMutation({
    mutationFn: (input: { query: string; effort: string }) =>
      fetchExaJson<ResearchLaunchResponse>("/api/exa/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: (data) => {
      setResearchQuery("");
      void queryClient.invalidateQueries({ queryKey: ["exa-research-jobs"] });
      toast({
        title: "Deep-research run launched",
        description: `effort ${data.job.effort} — tracked in the ledger below with live cost.`,
      });
    },
    onError: (e: Error) => {
      if (isNotConfigured(e)) {
        toast({ title: "Exa key missing", description: "Save your Exa API key in the Connectors tab first.", variant: "destructive" });
        return;
      }
      if (isRateLimited(e)) {
        toast({ title: "Rate limited", description: "5 runs per 10 minutes — wait a moment.", variant: "destructive" });
        return;
      }
      toast({ title: "Launch failed", description: e.message, variant: "destructive" });
    },
  });

  const jobs = useQuery<ResearchListResponse>({
    queryKey: ["exa-research-jobs"],
    queryFn: () => fetchExaJson<ResearchListResponse>("/api/exa/research"),
    refetchInterval: (q) => ((q.state.data?.jobs ?? []).some((j) => j.status === "queued" || j.status === "running") ? 30_000 : false),
  });

  const list = papers.data?.papers ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 font-mono">
            <BookOpen className="size-5 shrink-0 text-primary" aria-hidden="true" />
            Papers — curated RSI corpus
          </CardTitle>
          <CardDescription>
            {papers.data ? `${papers.data.total} entries` : "loading"} · every entry arXiv-abstract-verified (evidence:
            web-abstract) · training-dependent papers are honestly marked inspiration-only in their appliesTo notes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="rsi-paper-search"
              className="min-h-11"
              placeholder="Search title, one-line, technique or authors…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search the paper library"
            />
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Category filter chips">
            <button
              type="button"
              onClick={() => setCategory("all")}
              aria-pressed={category === "all"}
              className={cn(
                "min-h-11 rounded-md border px-3 font-mono text-xs transition-colors",
                category === "all"
                  ? "border-primary/40 bg-primary/15 text-primary"
                  : "border-border/60 text-muted-foreground hover:text-foreground",
              )}
            >
              all
            </button>
            {PAPER_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                aria-pressed={category === c}
                className={cn(
                  "min-h-11 rounded-md border px-3 font-mono text-xs transition-colors",
                  category === c
                    ? "border-primary/40 bg-primary/15 text-primary"
                    : "border-border/60 text-muted-foreground hover:text-foreground",
                )}
              >
                {c}
              </button>
            ))}
          </div>
          {papers.isLoading ? (
            <div className="space-y-2" aria-label="Loading papers">
              <Skeleton className="h-24 rounded-md" />
              <Skeleton className="h-24 rounded-md" />
              <Skeleton className="h-24 rounded-md" />
            </div>
          ) : papers.isError ? (
            <p className="text-sm text-destructive" role="alert">
              Paper library unavailable — retrying automatically.
            </p>
          ) : list.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              No papers match this filter — an honest empty result, not a padded list.
            </p>
          ) : (
            <div className={cn("max-h-96 space-y-2", LIST_SCROLLBAR)} aria-label="Paper cards">
              {list.map((p: RsiPaper) => (
                <Collapsible key={p.id} className="rounded-md border border-border/60">
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="flex min-h-11 w-full items-start gap-2 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent/40 dark:hover:bg-accent/25"
                      aria-expanded={false}
                      aria-label={`Paper: ${p.title}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{p.title}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
                            {p.authorsShort} {p.year}
                          </Badge>
                          <Badge variant="outline" className="font-mono text-[10px]">{p.category}</Badge>
                          <Badge variant="outline" className={cn("font-mono text-[10px]", relevanceClass(p.relevance))}>
                            {p.relevance}
                          </Badge>
                          <span className="font-mono text-[10px] text-muted-foreground">arXiv:{p.arxivId}</span>
                        </span>
                        <span className="mt-1 block line-clamp-1 text-xs text-muted-foreground">{p.oneLine}</span>
                      </span>
                      <ChevronDown className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-2 border-t border-border/60 px-3 py-2.5 text-xs text-muted-foreground">
                    <p>{p.oneLine}</p>
                    <p>
                      <span className="font-mono text-[10px] uppercase tracking-wide">technique</span> — {p.keyTechnique}
                    </p>
                    <p>
                      <span className="font-mono text-[10px] uppercase tracking-wide">applies to NEXUS</span> — {p.appliesTo}
                    </p>
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-11 items-center gap-1.5 text-primary hover:underline"
                      aria-label={`Open arXiv page for ${p.title}`}
                    >
                      <ExternalLink className="size-3.5" aria-hidden="true" />
                      arxiv.org/abs/{p.arxivId}
                    </a>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 font-mono">
            <Telescope className="size-5 shrink-0 text-primary" aria-hidden="true" />
            Deep research launcher (Exa Agent)
          </CardTitle>
          <CardDescription>
            The same Exa Agent engine the Connectors tab runs — pointed here at the RSI frontier. Measured per-run
            costs are honest; every completed run reports its real spend.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              const q = researchQuery.trim();
              if (q.length >= 3) launch.mutate({ query: q, effort });
            }}
          >
            <Label htmlFor="rsi-research-query" className="sr-only">
              Research question
            </Label>
            <Textarea
              id="rsi-research-query"
              rows={2}
              placeholder="e.g. training-free harness evolution Pareto gates 2026"
              value={researchQuery}
              onChange={(e) => setResearchQuery(e.target.value)}
              disabled={launch.isPending}
            />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select value={effort} onValueChange={(v) => setEffort(v)}>
                <SelectTrigger className="min-h-11 w-full font-mono sm:w-56" aria-label="Research effort and cost cap">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESEARCH_EFFORT_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value} className="font-mono">
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="submit" className="min-h-11 shrink-0 font-mono" disabled={researchQuery.trim().length < 3 || launch.isPending}>
                {launch.isPending ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Send className="size-4" aria-hidden="true" />
                )}
                {launch.isPending ? "Launching…" : "Launch run"}
              </Button>
            </div>
          </form>
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Suggested research queries">
            <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">suggested:</span>
            {SUGGESTED_RESEARCH_QUERIES.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setResearchQuery(q)}
                className="min-h-11 max-w-full rounded-md border border-border/60 px-2.5 text-left font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
              >
                {q}
              </button>
            ))}
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Research jobs</p>
            {jobs.isLoading ? (
              <Skeleton className="h-11 rounded-md" />
            ) : jobs.isError ? (
              <p className="text-xs text-muted-foreground" role="note">
                Research ledger unavailable.
              </p>
            ) : (jobs.data?.jobs ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No research runs yet — launch one above.</p>
            ) : (
              <div className={cn("max-h-96 space-y-2", LIST_SCROLLBAR)} aria-label="Research job rows">
                {(jobs.data?.jobs ?? []).map((job: ResearchJob) => (
                  <div key={job.id} className="flex min-h-11 items-center gap-2 rounded-md border border-border/60 px-3 py-2">
                    <Badge
                      variant="outline"
                      className={cn(
                        "shrink-0 font-mono text-[10px]",
                        job.status === "completed"
                          ? "border-primary/40 text-primary"
                          : job.status === "failed" || job.status === "stopped"
                            ? "border-destructive/50 text-destructive"
                            : "border-accent/60 text-accent",
                      )}
                    >
                      {job.status}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs" title={job.query}>
                      {job.query}
                    </span>
                    {job.answerPreview ? (
                      <span className="hidden max-w-56 truncate text-xs text-muted-foreground md:inline" title={job.answerPreview}>
                        {job.answerPreview}
                      </span>
                    ) : null}
                    {job.costDollars !== null && job.costDollars !== undefined ? (
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">${job.costDollars.toFixed(4)}</span>
                    ) : null}
                    {relativeTime(job.createdAt) ? (
                      <time dateTime={job.createdAt} suppressHydrationWarning className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
                        {relativeTime(job.createdAt)}
                      </time>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
