"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle2, ChevronDown, Layers, LoaderCircle, Play, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchRsiJson,
  parseJsonField,
  type RsiPlugin,
  type RsiRunDetail,
  type RsiRunRow,
  type RsiSuitesResponse,
} from "./api";
import { ParetoChart } from "./pareto-chart";

const LIST_SCROLLBAR =
  "overflow-y-auto pr-1 [scrollbar-color:theme(colors.primary/40)_transparent] [scrollbar-width:thin]";

function statusChip(status: string): string {
  switch (status) {
    case "done":
      return "border-primary/40 text-primary";
    case "queued":
    case "running":
      return "border-accent/60 text-accent animate-pulse";
    case "error":
      return "border-destructive/50 text-destructive";
    default:
      return "text-muted-foreground";
  }
}

function pct(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? `${(100 * v).toFixed(0)}%` : "—";
}

function num(v: number | null | undefined, digits = 2): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
}

/** Expandable run row: fetches the full run detail on open; per-task verdicts. */
function RunRow({ run, suiteKeyById }: { run: RsiRunRow; suiteKeyById: Map<string, string> }) {
  const [open, setOpen] = useState(false);
  const detail = useQuery({
    queryKey: ["rsi-run-detail", run.id],
    queryFn: () => fetchRsiJson<{ ok: true; run: RsiRunDetail }>(`/api/rsi/runs/${run.id}`),
    enabled: open,
    refetchInterval: (q) => (q.state.data?.run?.status === "running" || q.state.data?.run?.status === "queued" ? 8_000 : false),
  });

  const d = detail.data?.run;
  const engine = d ? parseJsonField<Record<string, unknown>>(JSON.stringify(d.engine ?? {}), {}) : {};

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border border-border/60">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex min-h-11 w-full flex-wrap items-center gap-2 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent/40 dark:hover:bg-accent/25"
          aria-expanded={open}
          aria-label={`${run.status} ${run.variant} run on ${suiteKeyById.get(run.suiteId) ?? run.suiteId}`}
        >
          <Badge variant="outline" className={cn("shrink-0 font-mono text-[10px]", statusChip(run.status))}>
            {run.status}
          </Badge>
          <Badge variant="outline" className={cn("shrink-0 font-mono text-[10px]", run.variant === "candidate" ? "border-accent/60 text-accent" : "border-primary/40 text-primary")}>
            {run.variant}
          </Badge>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {suiteKeyById.get(run.suiteId) ?? "suite"}
          </span>
          <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
            <span>pass {pct(run.passRate)}</span>
            <span>comp {num(run.compositeScore, 3)}</span>
            {run.judgeAvg !== null && run.judgeAvg !== undefined ? <span>judge {num(run.judgeAvg, 1)}</span> : null}
            <span>p50 {run.latencyP50Ms ?? "—"}ms</span>
            <span>p95 {run.latencyP95Ms ?? "—"}ms</span>
            <span>cost {num(run.costUnits)}</span>
          </span>
          <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden="true" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 border-t border-border/60 px-3 py-3">
        {detail.isLoading ? (
          <Skeleton className="h-20 rounded-md" />
        ) : detail.isError ? (
          <p className="text-xs text-muted-foreground" role="note">
            Run detail unavailable.
          </p>
        ) : d ? (
          <div className="space-y-2" aria-live="polite">
            <p className="font-mono text-[11px] text-muted-foreground">
              engine truth: {String(engine.provider ?? "—")} · {String(engine.modelId ?? "—")}
              {Array.isArray(engine.models) ? ` · ladder answered: ${(engine.models as string[]).join(", ")}` : ""} ·
              persona {String((engine as { personaProvenance?: string }).personaProvenance ?? "—")}
            </p>
            {d.error ? (
              <p className="text-xs text-destructive" role="alert">
                {d.error}
              </p>
            ) : null}
            {d.results.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No task verdicts yet — {d.status === "running" ? "battery in flight." : "no results recorded."}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {d.results.map((t) => (
                  <li
                    key={t.taskId}
                    className="flex items-start gap-2 rounded-md border border-border/50 px-2.5 py-1.5 text-xs"
                  >
                    {t.ok ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                    ) : (
                      <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-mono">
                        {t.name}
                        {t.judgeScore !== null && t.judgeScore !== undefined ? (
                          <span className="text-accent"> · judge {t.judgeScore}</span>
                        ) : null}
                        <span className="text-muted-foreground"> · {t.latencyMs ?? "—"}ms · {t.modelId}</span>
                      </p>
                      <p className="text-muted-foreground">{t.verdictDetail}</p>
                      {t.replyExcerpt ? (
                        <p className="mt-0.5 truncate italic text-muted-foreground/80" title={t.replyExcerpt}>
                          “{t.replyExcerpt}”
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Suites & Runs tab — frozen suite cards (configHash + verifier badges +
 * difficulty), the manual battery launcher (suite/variant/plugin), the runs
 * ledger (newest-first, capped scroll, auto-poll while anything is in
 * flight), and the Pareto scatter over completed runs.
 */
export function RsiSuitesRunsTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [suiteId, setSuiteId] = useState<string>("");
  const [variant, setVariant] = useState<string>("baseline");
  const [pluginId, setPluginId] = useState<string>("none");

  const suites = useQuery<RsiSuitesResponse>({
    queryKey: ["rsi-suites"],
    queryFn: () => fetchRsiJson<RsiSuitesResponse>("/api/rsi/suites"),
  });
  const plugins = useQuery<{ ok: true; plugins: RsiPlugin[] }>({
    queryKey: ["rsi-plugins"],
    queryFn: () => fetchRsiJson<{ ok: true; plugins: RsiPlugin[] }>("/api/rsi/plugins"),
  });
  const runs = useQuery<{ ok: true; runs: RsiRunRow[] }>({
    queryKey: ["rsi-runs"],
    queryFn: () => fetchRsiJson<{ ok: true; runs: RsiRunRow[] }>("/api/rsi/runs?limit=20"),
    refetchInterval: (q) =>
      (q.state.data?.runs ?? []).some((r) => r.status === "queued" || r.status === "running") ? 8_000 : false,
  });

  const launch = useMutation({
    mutationFn: () => {
      const body: Record<string, string> = { suiteId, variant };
      if (variant === "candidate" && pluginId !== "none") body.pluginId = pluginId;
      return fetchRsiJson<{ ok: true; run: { id: string } }>("/api/rsi/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["rsi-runs"] });
      toast({
        title: "Battery leg queued",
        description: `run ${data.run.id.slice(0, 8)} — executing live through the provider ladder; the table polls it.`,
      });
    },
    onError: (e: Error) =>
      toast({ title: "Launch failed", description: e.message, variant: "destructive" }),
  });

  const suiteList = suites.data?.suites ?? [];
  const suiteKeyById = new Map(suiteList.map((s) => [s.id, s.key]));
  const runList = runs.data?.runs ?? [];
  const usablePlugins = (plugins.data?.plugins ?? []).filter((p) => p.status === "draft" || p.status === "active" || p.status === "adopted");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 font-mono">
            <Layers className="size-5 shrink-0 text-primary" aria-hidden="true" />
            Frozen suites v1.0
          </CardTitle>
          <CardDescription>
            Seeded once from the eval-design blueprint, configHash-sealed (AUDIT re-checks). The engine never writes
            suite rows — tamper-evidence, not convenience.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {suites.isLoading ? (
            <div className="space-y-2" aria-label="Loading suites">
              <Skeleton className="h-28 rounded-md" />
              <Skeleton className="h-28 rounded-md" />
            </div>
          ) : suites.isError ? (
            <p className="text-sm text-destructive" role="alert">
              Suites unavailable — retrying automatically.
            </p>
          ) : (
            <div className={cn("max-h-96 space-y-2", LIST_SCROLLBAR)} aria-label="Suite cards">
              {suiteList.map((s) => (
                <Collapsible key={s.id} className="rounded-md border border-border/60">
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent/40 dark:hover:bg-accent/25"
                      aria-label={`Suite ${s.name}`}
                    >
                      <Badge variant="outline" className="shrink-0 border-primary/40 font-mono text-[10px] text-primary">
                        {s.category}
                      </Badge>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{s.name}</span>
                        <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
                          frozen v{s.version} · hash {s.configHashShort} · {s.tasks.length} tasks
                        </span>
                      </span>
                      <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-2 border-t border-border/60 px-3 py-2.5">
                    <p className="text-xs text-muted-foreground">{s.description}</p>
                    <p className="font-mono text-[10px] text-muted-foreground">grounding: {s.grounding}</p>
                    <ul className="space-y-1">
                      {s.tasks.map((t) => (
                        <li key={t.id} className="flex flex-wrap items-center gap-1.5 rounded-md border border-border/50 px-2 py-1 text-xs">
                          <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
                            {String(t.idx).padStart(2, "0")}
                          </Badge>
                          <span className="min-w-0 flex-1 truncate font-mono">{t.name}</span>
                          <Badge variant="outline" className="border-accent/50 font-mono text-[10px] text-accent">
                            {t.verifierLabel}
                          </Badge>
                          <span className="font-mono text-[10px] text-muted-foreground">d{t.difficulty} · w{t.weight}</span>
                        </li>
                      ))}
                    </ul>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="font-mono text-sm">Battery launcher</CardTitle>
          <CardDescription>
            One leg = one suite × one variant through the brain&apos;s provider ladder. Every call is budget-counted;
            a breached cap fails the run loudly.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-2 sm:grid-cols-[2fr_1fr_2fr_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              if (suiteId && (variant === "baseline" || (variant === "candidate" && pluginId !== "none"))) {
                launch.mutate();
              } else if (variant === "candidate" && pluginId === "none") {
                toast({
                  title: "Plugin required",
                  description: "A candidate leg is baseline + plugin promptDelta — pick or draft a plugin first.",
                  variant: "destructive",
                });
              }
            }}
          >
            <Label className="sr-only" htmlFor="rsi-run-suite">
              Suite
            </Label>
            <Select value={suiteId} onValueChange={setSuiteId}>
              <SelectTrigger id="rsi-run-suite" className="min-h-11 font-mono" aria-label="Frozen suite to run">
                <SelectValue placeholder="suite" />
              </SelectTrigger>
              <SelectContent>
                {suiteList.map((s) => (
                  <SelectItem key={s.id} value={s.id} className="font-mono">
                    {s.key} ({s.tasks.length} tasks)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Label className="sr-only" htmlFor="rsi-run-variant">
              Variant
            </Label>
            <Select value={variant} onValueChange={setVariant}>
              <SelectTrigger id="rsi-run-variant" className="min-h-11 font-mono" aria-label="Variant: baseline or candidate">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="baseline" className="font-mono">baseline</SelectItem>
                <SelectItem value="candidate" className="font-mono">candidate</SelectItem>
              </SelectContent>
            </Select>
            <Label className="sr-only" htmlFor="rsi-run-plugin">
              Plugin (candidate legs)
            </Label>
            <Select value={pluginId} onValueChange={setPluginId} disabled={variant !== "candidate"}>
              <SelectTrigger id="rsi-run-plugin" className="min-h-11 font-mono" aria-label="Plugin for candidate legs">
                <SelectValue placeholder={variant === "candidate" ? "pick a plugin" : "baseline needs none"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" className="font-mono">— none —</SelectItem>
                {usablePlugins.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="font-mono">
                    {p.name} [{p.status}]
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" className="min-h-11 shrink-0 font-mono" disabled={!suiteId || launch.isPending}>
              {launch.isPending ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Play className="size-4" aria-hidden="true" />
              )}
              Run
            </Button>
          </form>
        </CardContent>
      </Card>

      <ParetoChart runs={runList} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="font-mono text-sm">Runs (newest first)</CardTitle>
          <CardDescription>
            Every number live-measured: pass rate (weighted), judge average (judged tasks only), latency p50/p95, cost
            units, and the resolved provider/modelId truth. Failed runs are kept as failures.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {runs.isLoading ? (
            <div className="space-y-2" aria-label="Loading runs">
              <Skeleton className="h-11 rounded-md" />
              <Skeleton className="h-11 rounded-md" />
            </div>
          ) : runs.isError ? (
            <p className="text-sm text-destructive" role="alert">
              Runs unavailable — retrying automatically.
            </p>
          ) : runList.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              No runs yet — an honest empty ledger. Launch a battery leg above.
            </p>
          ) : (
            <div className={cn("max-h-96 space-y-2", LIST_SCROLLBAR)} aria-label="Run rows">
              {runList.map((r) => (
                <RunRow key={r.id} run={r} suiteKeyById={suiteKeyById} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
