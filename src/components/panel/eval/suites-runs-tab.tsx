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
import { useI18n } from "@/lib/i18n";
import { CheckCircle2, ChevronDown, Inbox, Layers, LoaderCircle, Play, Plus, XCircle } from "lucide-react";
import logCandidatesJson from "@/data/rsi/log-candidates.json";
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

/** One live-log-derived candidate eval task awaiting the owner's v1.1 suite freeze. */
type LogCandidate = {
  id: string;
  observedAt: string;
  sourceUser: string;
  sourceQuote: string;
  failureClass: string;
  evidence: string;
  proposedVerifier: string;
  freezeTarget: string;
  status: "candidate";
  note: string;
};

/**
 * Candidate registry from the owner's 2026-10-28/29 live-log dump (times +03) —
 * real production failure classes, quoted verbatim. Code, not DB rows: frozen
 * v1.0 stays configHash-sealed and is never edited retroactively; these await
 * the owner's v1.1 freeze decision.
 */
const LOG_CANDIDATES = logCandidatesJson as unknown as LogCandidate[];

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
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [suiteId, setSuiteId] = useState<string>("");
  const [variant, setVariant] = useState<string>("baseline");
  const [pluginId, setPluginId] = useState<string>("none");
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDelta, setDraftDelta] = useState("");

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

  const onError = (e: Error) =>
    toast({ title: "Launch failed", description: e.message, variant: "destructive" });
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
    onError,
  });

  /**
   * Draft-plugin mutation — the POST /api/rsi/plugins endpoint existed but had
   * NO panel surface, which left candidate legs unreachable whenever no
   * engine-synthesized plugin was usable. On success the new draft is
   * auto-selected so the next candidate leg can fire immediately.
   */
  const draftPlugin = useMutation({
    mutationFn: () =>
      fetchRsiJson<{ ok: true; plugin: { id: string; name: string; status: string } }>("/api/rsi/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: draftName.trim(), kind: "prompt-delta", promptDelta: draftDelta.trim() }),
      }),
    onSuccess: async (data) => {
      // Await the refetch BEFORE selecting: the plugin option must be mounted
      // when the Select value lands, or Radix keeps rendering the placeholder.
      await queryClient.invalidateQueries({ queryKey: ["rsi-plugins"] });
      const newId = data.plugin.id || "none";
      setPluginId(newId);
      // Radix keys its hidden native bubble select by the option-value list
      // (nativeSelectKey) — a freshly added draft remounts it, and the remount
      // emits a spurious onChange("") that would clobber the selection. The
      // deferred re-assert lands after that burst and wins.
      setTimeout(() => setPluginId(newId), 0);
      setDraftName("");
      setDraftDelta("");
      setDraftOpen(false);
      toast({
        title: t("eval.launcher.draftSaved"),
        description: `${data.plugin.name} — selected for the next candidate leg.`,
      });
    },
    onError,
  });

  const suiteList = suites.data?.suites ?? [];
  const suiteKeyById = new Map(suiteList.map((s) => [s.id, s.key]));
  const runList = runs.data?.runs ?? [];
  // Shadow-eval selects by PAYLOAD, not status: any plugin with a non-empty
  // promptDelta is a legitimate candidate subject — draft, active, adopted,
  // or a REJECTED one being re-measured (the G-gates govern promotion, not
  // experimentation; status stays visible in the dropdown label). The previous
  // status filter left the launcher candidate-only-with-no-plugins: the only
  // engine plugin was rejected, so candidate legs were impossible to launch.
  const usablePlugins = (plugins.data?.plugins ?? []).filter((p) => {
    try {
      const cfg = JSON.parse(p.payload || "{}") as { promptDelta?: unknown };
      return typeof cfg.promptDelta === "string" && cfg.promptDelta.trim().length > 0;
    } catch {
      return false;
    }
  });
  const selectedPlugin = pluginId === "none" ? null : usablePlugins.find((p) => p.id === pluginId) ?? null;

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

      <section aria-label="Log-derived candidates">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 font-mono text-sm">
              <Inbox className="size-4 shrink-0 text-primary" aria-hidden="true" />
              Log-derived candidates (v1.1 inbox)
            </CardTitle>
            <CardDescription>
              Frozen v1.0 is configHash-sealed — nothing here edits it. These candidates come straight from live
              production rows and await the owner&apos;s v1.1 freeze decision. Live-measured evidence, quoted verbatim.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className={cn("max-h-96 space-y-2", LIST_SCROLLBAR)} aria-label="Candidate rows">
              {LOG_CANDIDATES.map((c) => (
                <li
                  key={c.id}
                  className="min-h-11 space-y-1 rounded-md border border-border/60 px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                      {c.id}
                    </Badge>
                    <Badge
                      variant="outline"
                      className="shrink-0 border-accent/60 font-mono text-[10px] text-accent"
                    >
                      {c.status}
                    </Badge>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {c.observedAt} · {c.sourceUser}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                      freeze → {c.freezeTarget}
                    </span>
                  </div>
                  <p className="text-xs">{c.failureClass}</p>
                  <p className="text-xs italic text-muted-foreground/80">“{c.sourceQuote}”</p>
                  <p className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted-foreground">
                    {/* v35.3 responsive fix: the verifier sentence used to sit
                        INSIDE the pill — Badge is whitespace-nowrap shrink-0 by
                        construction, so the 840px "lane-truth (…)" row blew the
                        390px viewport out to 826px scrollWidth. The short
                        verifier id stays in the pill; the parenthetical flies
                        next to it as plain text. */}
                    <Badge variant="outline" className="border-accent/50 font-mono text-[10px] text-accent">
                      {c.proposedVerifier.split(/\s*\(\s*/)[0]}
                    </Badge>
                    {c.proposedVerifier.includes("(") ? (
                      <span className="min-w-0">
                        ({c.proposedVerifier.slice(c.proposedVerifier.indexOf("(") + 1)}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-[11px] text-muted-foreground">{c.evidence}</p>
                  {c.note ? (
                    <p className="text-[11px] text-muted-foreground/80">note: {c.note}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="font-mono text-sm">Battery launcher</CardTitle>
          <CardDescription>
            One leg = one suite × one variant through the brain&apos;s provider ladder. Every call is budget-counted;
            a breached cap fails the run loudly. Candidate legs are baseline + a plugin promptDelta — any plugin with a
            promptDelta is selectable (status shown honestly; shadow-eval is experimentation, promotion still goes
            through the owner gate).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form
            className="grid grid-cols-1 gap-2 sm:grid-cols-[2fr_1fr_2fr_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              if (suiteId && (variant === "baseline" || (variant === "candidate" && pluginId !== "none"))) {
                launch.mutate();
              } else if (variant === "candidate" && pluginId === "none") {
                toast({
                  title: t("eval.launcher.pluginRequiredTitle"),
                  description: t("eval.launcher.pluginRequiredDesc"),
                  variant: "destructive",
                });
              }
            }}
          >
            <Label className="sr-only" htmlFor="rsi-run-suite">
              Suite
            </Label>
            <Select value={suiteId} onValueChange={setSuiteId}>
              <SelectTrigger id="rsi-run-suite" className="min-h-11 w-full min-w-0 font-mono" aria-label="Frozen suite to run">
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
            <Select
              value={variant}
              onValueChange={(v) => {
                setVariant(v);
                // Auto-select the newest usable plugin so a candidate leg is
                // never blocked by an untouched "— none —" dropdown.
                if (v === "candidate" && pluginId === "none" && usablePlugins[0]) {
                  setPluginId(usablePlugins[0].id);
                }
              }}
            >
              <SelectTrigger id="rsi-run-variant" className="min-h-11 w-full min-w-0 font-mono" aria-label="Variant: baseline or candidate">
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
            <Select
              value={pluginId}
              onValueChange={(v) => setPluginId(v || "none")}
              disabled={variant !== "candidate"}
            >
              <SelectTrigger id="rsi-run-plugin" className="min-h-11 w-full min-w-0 font-mono" aria-label="Plugin for candidate legs">
                {/* Explicit children: Radix only re-resolves the auto label on
                    item mount or click — a programmatic value change (draft
                    saved → auto-select) would keep rendering the placeholder
                    even though the hidden native select carries the value.
                    Deriving the label from state makes the display honest and
                    deterministic in every path. */}
                <SelectValue placeholder="pick a plugin">
                  {variant === "candidate"
                    ? selectedPlugin
                      ? `${selectedPlugin.name} [${selectedPlugin.status}]`
                      : pluginId === "none"
                        ? "— none —"
                        : undefined
                    : "— none —"}
                </SelectValue>
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
            <Button type="submit" className="min-h-11 w-full shrink-0 font-mono sm:w-auto" disabled={!suiteId || launch.isPending}>
              {launch.isPending ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Play className="size-4" aria-hidden="true" />
              )}
              Run
            </Button>
          </form>

          {/* Draft-plugin surface: POST /api/rsi/plugins existed engine-side
              but had no panel affordance — without it candidate legs were
              unreachable whenever no engine-synthesized plugin was usable. */}
          <Collapsible open={draftOpen} onOpenChange={setDraftOpen} className="rounded-md border border-border/60">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left font-mono text-xs text-muted-foreground transition-colors hover:bg-accent/40 dark:hover:bg-accent/25"
                aria-expanded={draftOpen}
                aria-label={t("eval.launcher.draftToggleAria")}
              >
                <Plus className="size-4 shrink-0" aria-hidden="true" />
                {t("eval.launcher.draftToggle")}
                <ChevronDown
                  className={cn("ml-auto size-4 shrink-0 transition-transform", draftOpen && "rotate-180")}
                  aria-hidden="true"
                />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2 border-t border-border/60 px-3 py-3">
              <p className="text-[11px] text-muted-foreground">{t("eval.launcher.draftDesc")}</p>
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (draftName.trim().length >= 3 && draftDelta.trim().length > 0 && !draftPlugin.isPending) {
                    draftPlugin.mutate();
                  }
                }}
              >
                <div className="space-y-1">
                  <Label htmlFor="rsi-plugin-draft-name" className="font-mono text-[11px] text-muted-foreground">
                    {t("eval.launcher.draftName")}
                  </Label>
                  <Input
                    id="rsi-plugin-draft-name"
                    className="min-h-11 font-mono"
                    placeholder={t("eval.launcher.draftNamePlaceholder")}
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    maxLength={80}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="rsi-plugin-draft-delta" className="font-mono text-[11px] text-muted-foreground">
                    {t("eval.launcher.draftDelta")}
                  </Label>
                  <Textarea
                    id="rsi-plugin-draft-delta"
                    rows={3}
                    className="font-mono"
                    placeholder={t("eval.launcher.draftDeltaPlaceholder")}
                    value={draftDelta}
                    onChange={(e) => setDraftDelta(e.target.value)}
                    maxLength={4000}
                  />
                </div>
                <Button
                  type="submit"
                  size="sm"
                  className="min-h-11 font-mono"
                  disabled={draftName.trim().length < 3 || draftDelta.trim().length === 0 || draftPlugin.isPending}
                >
                  {draftPlugin.isPending ? (
                    <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Plus className="size-4" aria-hidden="true" />
                  )}
                  {t("eval.launcher.draftSave")}
                </Button>
              </form>
            </CollapsibleContent>
          </Collapsible>
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
