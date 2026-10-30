"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { ExternalLink, LoaderCircle, OctagonX, Play, Plus, ShieldCheck } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  fetchRsiJson,
  isTerminal,
  parseJsonField,
  STAGE_SPINE,
  stageIndex,
  type RsiAdvanceResponse,
  type RsiCycleDetail,
  type RsiCycleRow,
  type RsiPapersResponse,
  type RsiRunRow,
} from "./api";
import { StageStepper } from "./stage-stepper";
import { GatePanel } from "./gate-panel";

const LIST_SCROLLBAR =
  "overflow-y-auto pr-1 [scrollbar-color:theme(colors.primary/40)_transparent] [scrollbar-width:thin]";

const MODULES = ["persona", "routing", "guard", "tool-config", "code"] as const;

function statusBadgeClass(status: string): string {
  if (status === "adopted") return "border-primary/40 text-primary";
  if (status === "rejected") return "border-destructive/50 text-destructive";
  if (status === "aborted") return "border-border/60 text-muted-foreground";
  return "border-accent/60 text-accent";
}

function fmtMs(v: number | null | undefined): string {
  return typeof v === "number" ? `${v}ms` : "—";
}

/** New-cycle form: name, thesis, module, technique refs from core papers. */
function NewCycleForm() {
  const { toast } = useToast();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [thesis, setThesis] = useState("");
  const [moduleName, setModuleName] = useState<string>("persona");
  const [refs, setRefs] = useState<string[]>([]);

  const papers = useQuery<RsiPapersResponse>({
    queryKey: ["rsi-papers", "ref-pool"],
    queryFn: () => fetchRsiJson<RsiPapersResponse>("/api/rsi/papers"),
  });
  const refPool = useMemo(
    () =>
      (papers.data?.papers ?? []).filter(
        (p) =>
          (p.category === "harness-evolution" || p.category === "verification-eval") && p.relevance === "core",
      ),
    [papers.data],
  );

  const create = useMutation({
    mutationFn: () =>
      fetchRsiJson<{ ok: true; cycle: { id: string } }>("/api/rsi/cycles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, thesis, module: moduleName, techniqueRefs: refs }),
      }),
    onSuccess: (data) => {
      setName("");
      setThesis("");
      setRefs([]);
      void queryClient.invalidateQueries({ queryKey: ["rsi-cycles"] });
      void queryClient.invalidateQueries({ queryKey: ["rsi-overview"] });
      toast({
        title: "Cycle opened at SCOUT",
        description: `baseline snapshot captured from the current persona (${data.cycle.id.slice(0, 8)}). Advance runs the spine.`,
      });
    },
    onError: (e: Error) =>
      toast({ title: "Cycle create failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 font-mono text-sm">
          <Plus className="size-4 text-primary" aria-hidden="true" />
          Open a cycle
        </CardTitle>
        <CardDescription>
          The thesis must name ONE module and be falsifiable; duplicate theses of rejected cycles are refused at
          THESIS. The baseline snapshot is the CURRENT persona prompt (cortex builder, read-only) so every number is
          attributable.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim().length >= 3 && thesis.trim().length >= 12) create.mutate();
          }}
        >
          <div className="grid gap-2 sm:grid-cols-[1fr_180px]">
            <div className="space-y-1.5">
              <Label htmlFor="rsi-cycle-name" className="font-mono text-xs text-muted-foreground">
                Cycle name
              </Label>
              <Input
                id="rsi-cycle-name"
                className="min-h-11"
                placeholder="e.g. persona list-spam guard probe"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rsi-cycle-module" className="font-mono text-xs text-muted-foreground">
                Module scope (one)
              </Label>
              <Select value={moduleName} onValueChange={setModuleName}>
                <SelectTrigger id="rsi-cycle-module" className="min-h-11 w-full font-mono" aria-label="Module scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODULES.map((m) => (
                    <SelectItem key={m} value={m} className="font-mono">
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rsi-cycle-thesis" className="font-mono text-xs text-muted-foreground">
              Thesis (falsifiable claim: which metric moves, on which suite, at what cost)
            </Label>
            <Textarea
              id="rsi-cycle-thesis"
              rows={3}
              placeholder={t("eval.cycles.thesisPlaceholder")}
              value={thesis}
              onChange={(e) => setThesis(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <p className="font-mono text-xs text-muted-foreground" role="label">
              Technique refs (core harness/verification papers — optional)
            </p>
            {papers.isLoading ? (
              <Skeleton className="h-10 rounded-md" />
            ) : refPool.length === 0 ? (
              <p className="text-xs text-muted-foreground">No core papers found in the library.</p>
            ) : (
              <div className={cn("max-h-40 space-y-1", LIST_SCROLLBAR)} role="group" aria-label="Technique reference picker">
                {refPool.map((p) => {
                  const selected = refs.includes(p.arxivId);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() =>
                        setRefs((prev) => (selected ? prev.filter((r) => r !== p.arxivId) : [...prev, p.arxivId]))
                      }
                      className={cn(
                        "flex min-h-11 w-full items-center gap-2 rounded-md border px-2.5 text-left transition-colors",
                        selected ? "border-primary/40 bg-primary/10 text-primary" : "border-border/60 text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate text-xs" title={p.title}>
                        {p.title}
                      </span>
                      <span className="shrink-0 font-mono text-[10px]">arXiv:{p.arxivId}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <Button type="submit" className="min-h-11 font-mono" disabled={name.trim().length < 3 || thesis.trim().length < 12 || create.isPending}>
            {create.isPending ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
            Open cycle at SCOUT
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** Cycle detail: stepper, plugin, paired runs, gates, advance/abort, chain. */
function CycleDetail({ cycleId, onClosed }: { cycleId: string; onClosed: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const detail = useQuery<RsiCycleDetail>({
    queryKey: ["rsi-cycle-detail", cycleId],
    queryFn: () => fetchRsiJson<RsiCycleDetail>(`/api/rsi/cycles/${cycleId}`),
    // v38 — was an unconditional 10s poll. Terminal cycles (aborted/promoted/
    // rejected) are immutable — polling them forever burned API + render work
    // on the long-lived tab. Poll only while the cycle can still advance.
    refetchInterval: (query) => {
      const st = query.state.data?.cycle.status;
      return st && !isTerminal(st) ? 10_000 : false;
    },
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["rsi-cycle-detail", cycleId] });
    void queryClient.invalidateQueries({ queryKey: ["rsi-cycles"] });
    void queryClient.invalidateQueries({ queryKey: ["rsi-overview"] });
  };

  const advance = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      fetchRsiJson<RsiAdvanceResponse>(`/api/rsi/cycles/${cycleId}/advance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["rsi-runs"] });
      toast({
        title: `Stage advanced → ${data.cycle.status}`,
        description: data.note ?? (data.pending ? "Battery legs in flight — advance again once they settle." : `event #${data.event?.seq ?? "-"} on the chain.`),
      });
    },
    onError: (e: Error) =>
      toast({ title: "Advance refused", description: e.message, variant: "destructive" }),
  });

  const abort = useMutation({
    mutationFn: () =>
      fetchRsiJson<{ ok: true; cycle: { status: string } }>(`/api/rsi/cycles/${cycleId}/abort`, { method: "POST" }),
    onSuccess: (data) => {
      invalidate();
      toast({ title: "Cycle aborted", description: `status ${data.cycle.status} — negative evidence preserved on the chain.` });
    },
    onError: (e: Error) => toast({ title: "Abort failed", description: e.message, variant: "destructive" }),
  });

  const d = detail.data;
  if (detail.isLoading) {
    return (
      <Card>
        <CardContent className="space-y-2 p-4">
          <Skeleton className="h-8 w-1/2 rounded-md" />
          <Skeleton className="h-40 rounded-md" />
        </CardContent>
      </Card>
    );
  }
  if (detail.isError || !d) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm text-muted-foreground">
          <span role="note">Cycle detail unavailable — retrying automatically.</span>
          <Button variant="outline" className="min-h-11 font-mono" onClick={onClosed}>
            Back to list
          </Button>
        </CardContent>
      </Card>
    );
  }

  const c = d.cycle;
  const refs = parseJsonField<string[]>(c.techniqueRefs, []);
  const stageData = parseJsonField<Record<string, unknown>>(c.stageData, {});
  const pluginPayload = d.plugin ? parseJsonField<{ promptDelta?: string; notes?: string }>(d.plugin.payload, {}) : null;
  const terminal = isTerminal(c.status);
  const idx = stageIndex(c.status);
  const nextStage = idx >= 0 && idx < STAGE_SPINE.length ? STAGE_SPINE[idx] : null;
  const advanceLabel = nextStage ? `Advance: ${nextStage.label} — ${nextStage.action}` : "Advance";
  const atPromote = c.status === "promote";
  const runsByVariant: Record<string, RsiRunRow[]> = { baseline: [], candidate: [] };
  for (const r of d.runs) {
    (runsByVariant[r.variant] ??= []).push(r);
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 font-mono text-sm">
          <Badge variant="outline" className={cn("font-mono text-[10px]", statusBadgeClass(c.status))}>
            {c.status}
          </Badge>
          <span className="min-w-0 flex-1 truncate">{c.name}</span>
          <Button variant="ghost" className="min-h-11 font-mono text-xs" onClick={onClosed} aria-label="Back to cycle list">
            Back to list
          </Button>
        </CardTitle>
        <CardDescription className="font-mono text-[11px]">
          baseline snapshot {c.baselineSnapshotChars} chars · created {new Date(c.createdAt).toLocaleString()} · chain{" "}
          {d.chain.ok ? (
            <span className="inline-flex items-center gap-1 text-primary">
              <ShieldCheck className="size-3.5" aria-hidden="true" /> verified ({d.chain.events} events)
            </span>
          ) : (
            <span className="text-destructive">BROKEN at seq {d.chain.firstBadSeq}</span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="mb-1 font-mono text-xs uppercase tracking-wide text-muted-foreground">Thesis</p>
          <p className="rounded-md border border-border/60 p-3 text-sm">{c.thesis}</p>
        </div>
        {refs.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-xs uppercase tracking-wide text-muted-foreground">Technique refs:</span>
            {refs.map((r) => (
              <a
                key={r}
                href={`https://arxiv.org/abs/${r}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center gap-1 rounded-md border border-border/60 px-2 font-mono text-[11px] text-primary hover:border-primary/40"
              >
                <ExternalLink className="size-3" aria-hidden="true" />
                arXiv:{r}
              </a>
            ))}
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2">
          <StageStepper status={c.status} orientation="vertical" />
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {!terminal ? (
                atPromote ? (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button className="min-h-11 font-mono" disabled={advance.isPending}>
                        {advance.isPending ? (
                          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <Play className="size-4" aria-hidden="true" />
                        )}
                        Promote — owner human gate
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle className="font-mono">Owner human gate — record adoption?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This records the plugin as ADOPTED in the improvement ledger. Deploy remains a MANUAL Edge
                          Cortex Deploy action — the engine never deploys. G4 (counterfactual) and G6 (owner-anchored
                          judge calibration) are still PENDING and are being confirmed with full knowledge of that.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel className="min-h-11">Not yet</AlertDialogCancel>
                        <AlertDialogAction className="min-h-11" onClick={() => advance.mutate({ confirm: true })}>
                          Record adoption
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : (
                  <Button
                    className="min-h-11 font-mono"
                    disabled={advance.isPending}
                    onClick={() => advance.mutate({})}
                    aria-label={advanceLabel}
                  >
                    {advance.isPending ? (
                      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Play className="size-4" aria-hidden="true" />
                    )}
                    {advanceLabel}
                  </Button>
                )
              ) : (
                <span className="font-mono text-xs text-muted-foreground">terminal — spine closed</span>
              )}
              {!terminal ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" className="min-h-11 font-mono text-destructive hover:text-destructive" disabled={abort.isPending}>
                      {abort.isPending ? (
                        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <OctagonX className="size-4" aria-hidden="true" />
                      )}
                      Abort
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle className="font-mono">Abort this cycle?</AlertDialogTitle>
                      <AlertDialogDescription>
                        The cycle closes as ABORTED with a chain event; an active (not gate-passed) plugin from this
                        cycle is demoted to rejected. All recorded numbers stay as negative evidence.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel className="min-h-11">Keep running</AlertDialogCancel>
                      <AlertDialogAction className="min-h-11" onClick={() => abort.mutate()}>Abort cycle</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
            </div>
            {atPromote ? (
              <p className="rounded-md border border-accent/50 bg-accent/10 p-2.5 font-mono text-[11px] text-accent">
                PROMOTE waits for the owner confirm. Gates must be green; the confirm dialog states that deploy stays
                manual and that G4/G6 are pending.
              </p>
            ) : null}
            {c.status === "shadow-eval" && parseJsonField<unknown[]>(JSON.stringify(stageData.runs ?? []), []).length > 0 ? (
              <p className="rounded-md border border-accent/40 bg-accent/5 p-2.5 font-mono text-[11px] text-muted-foreground">
                Battery in flight — advancing again re-checks the paired runs and proceeds to the Pareto gate when
                both legs settle.
              </p>
            ) : null}

            {d.plugin ? (
              <div className="rounded-md border border-border/60 p-3">
                <p className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
                  Linked plugin — {d.plugin.name} [{d.plugin.status}]
                </p>
                {pluginPayload?.promptDelta ? (
                  <p className="mt-1.5 max-h-24 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">
                    {pluginPayload.promptDelta}
                  </p>
                ) : (
                  <p className="mt-1.5 text-xs text-muted-foreground">payload preview unavailable</p>
                )}
                {d.plugin.sourceArxiv ? (
                  <a
                    href={`https://arxiv.org/abs/${d.plugin.sourceArxiv}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1.5 inline-flex min-h-11 items-center gap-1 font-mono text-[11px] text-primary hover:underline"
                  >
                    <ExternalLink className="size-3" aria-hidden="true" />
                    inspired by arXiv:{d.plugin.sourceArxiv}
                  </a>
                ) : null}
              </div>
            ) : null}

            {d.runs.length > 0 ? (
              <div className="rounded-md border border-border/60 p-3">
                <p className="font-mono text-xs uppercase tracking-wide text-muted-foreground">Paired runs</p>
                <div className="mt-1.5 space-y-1">
                  {(["baseline", "candidate"] as const).map((v) =>
                    (runsByVariant[v] ?? []).map((r) => (
                      <p key={r.id} className="font-mono text-[11px] text-muted-foreground">
                        {v}: pass {r.passRate !== null ? `${(100 * r.passRate).toFixed(0)}%` : "—"} · comp{" "}
                        {r.compositeScore !== null ? r.compositeScore.toFixed(3) : "—"} · cost {r.costUnits !== null ? r.costUnits.toFixed(2) : "—"} · p95 {fmtMs(r.latencyP95Ms)} ·{" "}
                        <span className={r.status === "done" ? "text-primary" : r.status === "error" ? "text-destructive" : "text-accent"}>
                          {r.status}
                        </span>
                      </p>
                    )),
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <GatePanel gateResultsJson={c.gateResults} />

        <div>
          <p className="mb-1.5 font-mono text-xs uppercase tracking-wide text-muted-foreground">
            Audit chain ({d.events.length} events, replay-verified)
          </p>
          {d.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events recorded.</p>
          ) : (
            <div className={cn("max-h-96 space-y-1", LIST_SCROLLBAR)} aria-label="Cycle event chain">
              {/* v38 — render cap: the ledger grows monotonically per cycle;
                 long chains re-rendered uncapped every (formerly unconditional)
                 poll tick. Show the newest 60; the count below stays the full
                 chain length. */}
              {d.events.length > 60 ? (
                <p className="px-1 pb-1 font-mono text-[10px] text-muted-foreground">
                  showing latest 60 of {d.events.length} (chain-verified count above)
                </p>
              ) : null}
              {d.events.slice(-60).map((e) => (
                <div key={e.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border/50 px-2.5 py-1.5">
                  <Badge variant="outline" className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    #{String(e.seq).padStart(2, "0")}
                  </Badge>
                  <Badge variant="outline" className="shrink-0 border-primary/30 font-mono text-[10px] text-primary">
                    {e.stage}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{e.type}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground" title={`prev ${e.prevHash} → ${e.hash}`}>
                    {e.hash}
                  </span>
                  <time dateTime={e.createdAt} suppressHydrationWarning className="shrink-0 text-[10px] text-muted-foreground">
                    {new Date(e.createdAt).toLocaleTimeString()}
                  </time>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Cycles tab: form + list + inline detail. */
export function RsiCyclesTab() {
  const [selected, setSelected] = useState<string | null>(null);

  const cycles = useQuery<{ ok: true; cycles: RsiCycleRow[] }>({
    queryKey: ["rsi-cycles"],
    queryFn: () => fetchRsiJson<{ ok: true; cycles: RsiCycleRow[] }>("/api/rsi/cycles"),
    refetchInterval: 15_000,
  });

  const list = cycles.data?.cycles ?? [];

  return (
    <div className="space-y-4">
      {selected ? (
        <CycleDetail cycleId={selected} onClosed={() => setSelected(null)} />
      ) : (
        <>
          <NewCycleForm />
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="font-mono text-sm">Cycles (newest first)</CardTitle>
              <CardDescription>
                Rejected cycles stay visible — their numbers are the negative-evidence ledger future theses are
                screened against.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {cycles.isLoading ? (
                <div className="space-y-2" aria-label="Loading cycles">
                  <Skeleton className="h-12 rounded-md" />
                  <Skeleton className="h-12 rounded-md" />
                </div>
              ) : cycles.isError ? (
                <p className="text-sm text-destructive" role="alert">
                  Cycles unavailable — retrying automatically.
                </p>
              ) : list.length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">
                  No cycles yet — open the first one above. Nothing is auto-cycled; the owner drives the spine.
                </p>
              ) : (
                <div className={cn("max-h-96 space-y-2", LIST_SCROLLBAR)} aria-label="Cycle rows">
                  {list.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setSelected(c.id)}
                      aria-label={`Open cycle ${c.name} (status ${c.status})`}
                      className="flex min-h-11 w-full flex-wrap items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-left transition-colors hover:border-primary/30 hover:bg-primary/5"
                    >
                      <Badge variant="outline" className={cn("shrink-0 font-mono text-[10px]", statusBadgeClass(c.status))}>
                        {c.status}
                      </Badge>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{c.name}</span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{c.thesis}</span>
                      </span>
                      <time dateTime={c.updatedAt} suppressHydrationWarning className="shrink-0 text-[11px] text-muted-foreground">
                        {new Date(c.updatedAt).toLocaleDateString()}
                      </time>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
