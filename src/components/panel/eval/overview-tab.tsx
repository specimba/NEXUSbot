"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  BUDGET_CAP_MAX,
  BUDGET_CAP_MIN,
  BUDGET_CAP_PRESETS,
  fetchRsiJson,
  type RsiAdvanceResponse,
  type RsiBudgetResponse,
  type RsiOverview,
} from "./api";
import { StageStepper } from "./stage-stepper";
import { Database, FlaskConical, Gauge, Layers, LoaderCircle, Play, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

function StatTile({ label, value, sub, icon: Icon }: { label: string; value: string | number; sub?: string; icon: typeof Database }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md border border-primary/25 bg-primary/10">
          <Icon className="size-5 text-primary" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="font-mono text-2xl font-semibold text-primary text-glow">{value}</p>
          {sub ? <p className="truncate font-mono text-[10px] text-muted-foreground">{sub}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Overview tab — live counters (papers, frozen suites/tasks, cycle statuses,
 * runs today + budget headroom), the 9-stage spine, active cycles with an
 * Advance shortcut, and the honesty notes (judge calibration status, G4/G6
 * pending). Nothing on this tab is synthesized.
 */
export function RsiOverviewTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const overview = useQuery<RsiOverview>({
    queryKey: ["rsi-overview"],
    queryFn: () => fetchRsiJson<RsiOverview>("/api/rsi/overview"),
    refetchInterval: 15_000,
  });

  const advance = useMutation({
    mutationFn: (cycleId: string) =>
      fetchRsiJson<RsiAdvanceResponse>(`/api/rsi/cycles/${cycleId}/advance`, { method: "POST" }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["rsi-overview"] });
      void queryClient.invalidateQueries({ queryKey: ["rsi-cycles"] });
      void queryClient.invalidateQueries({ queryKey: ["rsi-cycle-detail"] });
      toast({
        title: `Stage advanced → ${data.cycle.status}`,
        description: data.note ?? data.pending
          ? `${data.runs?.length ?? 0} battery leg(s) in flight — advance again once they settle.`
          : `event #${data.event?.seq ?? "-"} recorded on the hash chain`,
      });
    },
    onError: (e: Error) =>
      toast({ title: "Advance failed", description: e.message, variant: "destructive" }),
  });

  // Owner cap editor draft — null mirrors the server cap (the draft survives
  // the 15s overview poll; a successful save resets it back to the server).
  const [capDraft, setCapDraft] = useState<string | null>(null);

  const saveCap = useMutation({
    mutationFn: (cap: number) =>
      fetchRsiJson<RsiBudgetResponse>("/api/rsi/budget", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cap }),
      }),
    onSuccess: (data) => {
      setCapDraft(null);
      void queryClient.invalidateQueries({ queryKey: ["rsi-overview"] });
      toast({
        title: `Daily cap set to ${data.budget.cap}`,
        description: `Setting rsi.callBudgetDaily written — ${data.budget.remaining} call(s) remaining today (UTC). Live for every G7 gate and runner pre-flight on the next check.`,
      });
    },
    onError: (e: Error) =>
      toast({ title: "Cap update failed", description: e.message, variant: "destructive" }),
  });

  const o = overview.data;
  const cyclesAdopted = o?.cycles?.adopted ?? 0;
  const cyclesRejected = o?.cycles?.rejected ?? 0;
  const cyclesAborted = o?.cycles?.aborted ?? 0;
  const cyclesLive = Object.entries(o?.cycles ?? {})
    .filter(([k]) => !["adopted", "rejected", "aborted"].includes(k))
    .reduce((s, [, v]) => s + v, 0);

  const liveCap = o?.budget.cap ?? null;
  const capValue = capDraft ?? (liveCap !== null ? String(liveCap) : "");
  const parsedCap = Number(capValue);
  const capValid =
    capValue.trim() !== "" &&
    Number.isInteger(parsedCap) &&
    parsedCap >= BUDGET_CAP_MIN &&
    parsedCap <= BUDGET_CAP_MAX;
  const capDirty = liveCap !== null && parsedCap !== liveCap;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {overview.isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)
        ) : overview.isError ? (
          <p className="col-span-full text-sm text-destructive" role="alert">
            Overview unavailable — the API returns honest errors; retry after a moment.
          </p>
        ) : o ? (
          <>
            <StatTile label="Papers (curated corpus)" value={o.papers} icon={Database} sub="arXiv-verified abstracts" />
            <StatTile label="Frozen suites v1.0" value={`${o.suites} / ${o.tasks} tasks`} icon={Layers} sub="configHash-sealed" />
            <StatTile label="Cycles live / adopted" value={`${cyclesLive} / ${cyclesAdopted}`} icon={FlaskConical} sub={`${cyclesRejected} rejected · ${cyclesAborted} aborted`} />
            <StatTile label="Runs today" value={o.runs.today} icon={Gauge} sub={`${o.runs.done} done · ${o.runs.error} error (all time)`} />
          </>
        ) : null}
      </div>

      {o ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex flex-wrap items-center justify-between gap-2 font-mono text-sm">
              <span>LLM call budget (today, UTC)</span>
              <span className={cn("font-mono text-xs", o.budget.ok ? "text-primary" : "text-destructive")}>
                {o.budget.used}/{o.budget.cap} used · {o.budget.remaining} remaining
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Progress
              value={Math.min(100, (o.budget.used / Math.max(1, o.budget.cap)) * 100)}
              aria-label="Daily RSI LLM call budget"
              className="h-2"
            />
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="font-mono text-[11px] text-muted-foreground">Owner cap:</span>
              {BUDGET_CAP_PRESETS.map((preset) => (
                <Button
                  key={preset}
                  type="button"
                  variant={capValue === String(preset) ? "default" : "outline"}
                  className="min-h-11 px-3 font-mono text-xs"
                  disabled={saveCap.isPending}
                  aria-pressed={capValue === String(preset)}
                  aria-label={`Preset daily cap ${preset}`}
                  onClick={() => setCapDraft(String(preset))}
                >
                  {preset}
                </Button>
              ))}
              <Input
                type="number"
                inputMode="numeric"
                min={BUDGET_CAP_MIN}
                max={BUDGET_CAP_MAX}
                step={1}
                value={capValue}
                onChange={(e) => setCapDraft(e.target.value)}
                disabled={saveCap.isPending}
                aria-label={`Custom daily cap, integer ${BUDGET_CAP_MIN} to ${BUDGET_CAP_MAX}`}
                aria-invalid={capDraft !== null && !capValid}
                className="h-11 w-20 shrink-0 font-mono text-xs"
              />
              <Button
                type="button"
                className="min-h-11 shrink-0 px-4 font-mono text-xs"
                disabled={saveCap.isPending || !capValid || !capDirty}
                aria-label="Save the daily LLM call cap"
                onClick={() => saveCap.mutate(parsedCap)}
              >
                {saveCap.isPending ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : null}
                Save
              </Button>
            </div>
            {capDraft !== null && !capValid ? (
              <p className="font-mono text-[10px] text-destructive" role="alert">
                cap must be an integer between {BUDGET_CAP_MIN} and {BUDGET_CAP_MAX}
              </p>
            ) : null}
            <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
              Cap stored in Setting <code>rsi.callBudgetDaily</code> (default 64, evolution-engine.json costModel) —
              owner-editable right here: raising it grants headroom for longer, harder evaluation batteries. A breach
              still fails runs loudly with <code>budget_exceeded</code> — never a silent truncation, and no number is
              ever fabricated.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="font-mono text-sm">The 9-stage cycle spine</CardTitle>
        </CardHeader>
        <CardContent>
          <StageStepper status="scout" />
          <p className="pt-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
            scout → thesis → synthesize → shadow-eval → pareto-gate → canary → promote → audit → record. The engine
            proposes; owner-frozen suites and gates grade; promotion requires the owner human gate; deploy remains a
            manual Edge Cortex Deploy action.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="font-mono text-sm">Active cycles</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {overview.isLoading ? (
            <Skeleton className="h-14 rounded-md" />
          ) : (o?.activeCycles ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground" role="note">
              No live cycles — open one in the Cycles tab. An honest empty state: the lab forces nothing.
            </p>
          ) : (
            (o?.activeCycles ?? []).map((c) => (
              <div
                key={c.id}
                className="flex min-h-11 flex-wrap items-center gap-2 rounded-md border border-border/60 px-3 py-2"
              >
                <Badge variant="outline" className="shrink-0 border-primary/40 font-mono text-[10px] text-primary">
                  {c.status}
                </Badge>
                <span className="min-w-0 flex-1 truncate font-mono text-sm" title={c.name}>
                  {c.name}
                </span>
                <Button
                  variant="outline"
                  className="min-h-11 shrink-0 font-mono text-xs"
                  disabled={advance.isPending}
                  aria-label={`Advance cycle ${c.name} from ${c.status}`}
                  onClick={() => advance.mutate(c.id)}
                >
                  {advance.isPending ? (
                    <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Play className="size-4" aria-hidden="true" />
                  )}
                  Advance
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 font-mono text-sm">
            <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
            Honesty notes
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Judge calibration: PROVISIONAL — a small author-anchored battery (2 anchors per run-batch) records
            agreement honestly; the binding G6 gate (kappa ≥ 0.6 on OWNER-labeled anchors) stays{" "}
            <span className="font-mono text-accent">PENDING</span> until the owner authors the anchor set.
          </p>
          <p>
            G4 counterfactual registry: <span className="font-mono text-accent">PENDING</span> — gain survival cannot be
            claimed until the owner authors paraphrase/order/format variants.
          </p>
          <p>
            No improvement claim anywhere in this lab is valid until the first full cycle completes end-to-end —{" "}
            <span className="font-mono text-accent">[UNVERIFIED]</span> by design.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
