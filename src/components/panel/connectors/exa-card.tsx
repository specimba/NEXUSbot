"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import {
  BrainCircuit,
  ExternalLink,
  Gauge,
  KeyRound,
  Newspaper,
  Pause,
  Play,
  Radar,
  RefreshCw,
  Timer,
  Trash2,
} from "lucide-react";

/**
 * Exa connector card (v29.12) — the brain's research engine.
 * Owner directive: paid credits partially expire unused on quiet days, so the
 * posture is aggressive-but-budgeted. Honest states only: NOT CONFIGURED →
 * ARMED (panel probe verified). The card also shows whether the LIVE edge
 * (nexus-cortex) has its Exa tier armed — panel + edge can be armed
 * independently (edge arming needs the Supabase PAT for the secret push).
 */

type ExaStatus = {
  ok: boolean;
  armed: boolean;
  maskedKey: string;
  usage: {
    day: string;
    search: number;
    contentsPages: number;
    answers: number;
    agentRuns: number;
    estCostUsd: number;
    lastRequestAt: string;
    lastError: string;
  };
  budget: { dailySearch: number; dailyAnswer: number; dailyContents: number };
  digest: {
    ok: boolean;
    provider: string;
    builtAt: string;
    items?: Array<{ title: string; url: string; summary: string; date: string; source: string }>;
    freshCount?: number;
    error?: string;
  } | null;
  monitors: Array<{
    id?: string;
    name?: string | null;
    status?: string;
    state?: string;
    search?: { query?: string };
    trigger?: { period?: string } | null;
    nextRunAt?: string | null;
  }>;
  monitorsError: string;
  localMonitors: Array<{
    id: string;
    query: string;
    periodLabel: string;
    paused: boolean;
    lastRunAt: string | null;
    nextRunAt: string | null;
    lastStatus: "never" | "ok" | "error";
    lastError: string;
    lastItemCount: number;
    runCount: number;
  }>;
  monitorRuns: Array<{
    id: string;
    monitorId: string;
    query: string;
    at: string;
    ok: boolean;
    itemCount: number;
    newCount: number;
    error: string;
    tookMs: number;
  }>;
  webhookMode: { nativeWebhook: boolean; source: string };
  webhookInbox: Array<{ receivedAt: string; monitorId: string; kind: string }>;
  edge: { reachable: boolean; service: string; exaArmed: boolean };
};

type SetKeyResult = {
  ok: boolean;
  maskedKey?: string;
  edgeArmed?: boolean;
  edgeError?: string;
  probe?: { ok: boolean; error: string; items: number };
};

export function ExaCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [keyInput, setKeyInput] = useState("");
  const [searchBudget, setSearchBudget] = useState("");
  const [answerBudget, setAnswerBudget] = useState("");
  const [monitorQuery, setMonitorQuery] = useState("Major AI lab product and research updates");
  const [monitorPeriod, setMonitorPeriod] = useState("1d");

  const status = useQuery<{ ok: boolean; status?: never } & Partial<ExaStatus>>({
    queryKey: ["connector-exa-status"],
    queryFn: async () => {
      const res = await fetch("/api/exa", { cache: "no-store" });
      if (!res.ok) throw new Error("status unavailable");
      return res.json();
    },
    refetchInterval: 45_000,
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ["connector-exa-status"] });

  const saveKey = useMutation({
    mutationFn: async (secret: string): Promise<SetKeyResult> => {
      const res = await fetch("/api/exa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-key", secret }),
      });
      const body = (await res.json().catch(() => null)) as SetKeyResult | null;
      if (!res.ok || !body?.ok) throw new Error("Save failed");
      return body;
    },
    onSuccess: (data) => {
      setKeyInput("");
      invalidate();
      const probeOk = data.probe?.ok;
      toast({
        title: probeOk ? "Exa armed — live probe passed" : "Key stored, but the probe failed",
        description: probeOk
          ? `Panel research now Exa-first (${data.probe?.items ?? 0} digest items). ${
              data.edgeArmed
                ? "Live edge armed too."
                : "Edge NOT armed: " + (data.edgeError ?? "needs the Supabase PAT — re-enter it in Connectors → Supabase, then redeploy the cortex.")
            }`
          : data.probe?.error ?? "Exa rejected the key.",
        variant: probeOk ? "default" : "destructive",
      });
    },
    onError: (e: Error) =>
      toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const saveBudget = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/exa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set-budget",
          dailySearch: searchBudget ? Number(searchBudget) : undefined,
          dailyAnswer: answerBudget ? Number(answerBudget) : undefined,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      setSearchBudget("");
      setAnswerBudget("");
      invalidate();
      toast({ title: "Budgets updated", description: "Daily caps saved." });
    },
    onError: (e: Error) =>
      toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const refreshDigest = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/exa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh-digest" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Digest refreshed", description: "Latest AI news pulled through Exa." });
    },
    onError: (e: Error) =>
      toast({ title: "Refresh failed", description: e.message, variant: "destructive" }),
  });

  const createMonitor = useMutation({
    mutationFn: async (): Promise<{ transport?: string }> => {
      const res = await fetch("/api/exa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create-monitor",
          query: monitorQuery,
          period: monitorPeriod,
          numResults: 8,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { transport?: string; error?: { message?: string } }
        | null;
      if (!res.ok || !body) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      return body;
    },
    onSuccess: (data) => {
      invalidate();
      toast({
        title: data.transport === "exa" ? "Native Exa monitor registered" : "Local monitor registered",
        description:
          data.transport === "exa"
            ? "Exa will push deduped results to /api/exa/webhook on its interval."
            : "The panel scheduler runs it in-process (first check ~1 min). Results land in the webhook inbox.",
      });
    },
    onError: (e: Error) =>
      toast({ title: "Monitor failed", description: e.message, variant: "destructive" }),
  });

  const runMonitor = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch("/api/exa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run-monitor", id }),
      });
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      return body;
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Monitor run finished", description: "Run history + inbox updated." });
    },
    onError: (e: Error) =>
      toast({ title: "Run failed", description: e.message, variant: "destructive" }),
  });

  const toggleMonitor = useMutation({
    mutationFn: async ({ id, paused }: { id: string; paused: boolean }) => {
      const res = await fetch("/api/exa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle-monitor", id, paused }),
      });
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      return body;
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Monitor updated" });
    },
    onError: (e: Error) =>
      toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  const deleteMonitor = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch("/api/exa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete-monitor", id }),
      });
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      return body;
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Monitor deleted" });
    },
    onError: (e: Error) =>
      toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  const s = status.data;
  const usage = s?.usage;
  const digest = s?.digest ?? null;
  const edge = s?.edge;

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <BrainCircuit className="h-4 w-4 shrink-0" aria-hidden />
              Exa — Research Engine
            </CardTitle>
            <CardDescription className="mt-1 text-xs">
              Search · Answer (cited) · Contents · Monitors. The anti-hallucination tier for
              VYCE&apos;s research.
            </CardDescription>
          </div>
          {status.isLoading ? (
            <Skeleton className="h-5 w-28" />
          ) : s?.armed ? (
            <Badge variant="outline" className="border-primary/40 text-primary">ARMED</Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">NOT CONFIGURED</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        {/* Key */}
        <div className="space-y-1.5">
          <Label htmlFor="exa-key" className="text-xs font-medium">
            EXA_API_KEY {s?.armed && s.maskedKey ? <span className="ml-1 font-mono text-muted-foreground">({s.maskedKey})</span> : null}
          </Label>
          <div className="flex gap-2">
            <Input
              id="exa-key"
              type="password"
              placeholder={s?.armed ? "Replace stored key…" : "Paste the Exa API key (dashboard.exa.ai)"}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              className="h-9 font-mono text-xs"
              autoComplete="off"
            />
            <Button
              size="sm"
              className="h-9 shrink-0"
              disabled={!keyInput || saveKey.isPending}
              onClick={() => saveKey.mutate(keyInput.trim())}
            >
              <KeyRound className="mr-1 h-3.5 w-3.5" aria-hidden />
              {saveKey.isPending ? "Probing…" : "Arm"}
            </Button>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Stored AES-256-GCM in the vault. Arming auto-pushes the key to the live Supabase
            edge (needs a valid Management PAT in Connectors → Supabase).
          </p>
        </div>

        {/* Edge status */}
        <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-[11px] leading-relaxed">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">Live edge (nexus-cortex)</span>
            {edge?.reachable ? (
              <Badge variant="outline" className="border-primary/40 text-primary">
                {edge.service || "reachable"}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">unreachable</Badge>
            )}
          </div>
          <div className="mt-1 text-muted-foreground">
            Exa tier on the edge:{" "}
            {edge?.reachable ? (
              edge.exaArmed ? (
                <span className="font-medium text-primary">ARMED — grounded+cited research live</span>
              ) : (
                <span className="font-medium text-accent">not armed yet (key push or redeploy pending)</span>
              )
            ) : (
              <span>probe failed</span>
            )}
          </div>
        </div>

        {/* Usage + budgets */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium">
            <Gauge className="h-3.5 w-3.5" aria-hidden /> Today&apos;s usage &amp; budgets
          </div>
          <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
            <div className="rounded-md border border-border/60 px-2 py-1.5">
              <div className="text-muted-foreground">Searches</div>
              <div className="font-mono text-sm">{usage ? `${usage.search}/${s?.budget?.dailySearch ?? "—"}` : "—"}</div>
            </div>
            <div className="rounded-md border border-border/60 px-2 py-1.5">
              <div className="text-muted-foreground">Answers</div>
              <div className="font-mono text-sm">{usage ? `${usage.answers}/${s?.budget?.dailyAnswer ?? "—"}` : "—"}</div>
            </div>
            <div className="rounded-md border border-border/60 px-2 py-1.5">
              <div className="text-muted-foreground">Est. spend</div>
              <div className="font-mono text-sm">{usage ? `$${usage.estCostUsd.toFixed(3)}` : "—"}</div>
            </div>
            <div className="rounded-md border border-border/60 px-2 py-1.5">
              <div className="text-muted-foreground">Last error</div>
              <div className="truncate font-mono text-sm" title={usage?.lastError}>
                {usage?.lastError ? usage.lastError.slice(0, 18) : "none"}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-24">
              <Label htmlFor="exa-search-budget" className="text-[10px] text-muted-foreground">Search/day</Label>
              <Input id="exa-search-budget" inputMode="numeric" className="h-8 text-xs" placeholder={String(s?.budget?.dailySearch ?? "")} value={searchBudget} onChange={(e) => setSearchBudget(e.target.value)} />
            </div>
            <div className="w-24">
              <Label htmlFor="exa-answer-budget" className="text-[10px] text-muted-foreground">Answers/day</Label>
              <Input id="exa-answer-budget" inputMode="numeric" className="h-8 text-xs" placeholder={String(s?.budget?.dailyAnswer ?? "")} value={answerBudget} onChange={(e) => setAnswerBudget(e.target.value)} />
            </div>
            <Button size="sm" variant="secondary" className="h-8" disabled={saveBudget.isPending} onClick={() => saveBudget.mutate()}>
              Save budgets
            </Button>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Posture: expiring credits are wasted credits — generous caps by design (150 / 80),
            still fenced against runaway loops.
          </p>
        </div>

        {/* News digest */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-medium">
              <Newspaper className="h-3.5 w-3.5" aria-hidden /> AI news digest
              {digest?.builtAt ? (
                <span className="text-[10px] font-normal text-muted-foreground">
                  {digest.provider} · {formatDistanceToNow(new Date(digest.builtAt), { addSuffix: true })}
                  {digest.freshCount ? ` · ${digest.freshCount} new` : ""}
                </span>
              ) : null}
            </div>
            <Button size="sm" variant="ghost" className="h-7 px-2" disabled={refreshDigest.isPending} onClick={() => refreshDigest.mutate()}>
              <RefreshCw className={cn("h-3 w-3", refreshDigest.isPending && "animate-spin")} aria-hidden />
              Refresh
            </Button>
          </div>
          {digest?.ok && digest.items?.length ? (
            <ul className="max-h-40 space-y-1.5 overflow-y-auto pr-1 text-[11px] leading-relaxed">
              {digest.items.slice(0, 5).map((item, i) => (
                <li key={`${item.url}-${i}`} className="truncate">
                  <a href={item.url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 hover:underline">
                    <span className="truncate">{item.title}</span>
                    <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="shrink-0 text-muted-foreground">[{item.source}]</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {digest?.error ? `Digest error: ${digest.error.slice(0, 80)}` : "No digest yet — arm the key or refresh."}
            </p>
          )}
        </div>

        {/* Monitors */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-medium">
              <Radar className="h-3.5 w-3.5" aria-hidden /> Monitors (scheduled research)
            </div>
            <span className="text-[10px] text-muted-foreground" title="Local runs in-process and feeds the webhook inbox; native Exa monitors only with a public https webhook">
              {s?.webhookMode?.nativeWebhook ? "transport: exa webhook" : "transport: local scheduler"}
            </span>
          </div>
          {s?.localMonitors?.length || s?.monitors?.length ? (
            <ul className="max-h-40 space-y-1 overflow-y-auto pr-1 text-[11px]">
              {(s.localMonitors ?? []).map((m) => (
                <li key={m.id} className="rounded border border-border/50 px-2 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate" title={m.query}>{m.query}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      <Badge variant="secondary" className="px-1 py-0 text-[9px]">LOCAL</Badge>
                      {m.paused ? (
                        <span className="text-muted-foreground">paused</span>
                      ) : m.lastStatus === "error" ? (
                        <span className="font-medium text-destructive" title={m.lastError}>error</span>
                      ) : m.lastStatus === "ok" ? (
                        <span className="font-medium text-primary">ok</span>
                      ) : (
                        <span className="text-muted-foreground">pending</span>
                      )}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                    <span className="truncate">
                      {m.periodLabel}
                      {m.lastRunAt ? ` · last ${formatDistanceToNow(new Date(m.lastRunAt), { addSuffix: true })} (${m.lastItemCount} items)` : " · not run yet"}
                      {!m.paused && m.nextRunAt ? ` · next ${formatDistanceToNow(new Date(m.nextRunAt))}` : ""}
                    </span>
                    <span className="flex shrink-0 items-center gap-0.5">
                      <Button size="icon" variant="ghost" className="h-6 w-6" title="Run now" disabled={runMonitor.isPending} onClick={() => runMonitor.mutate(m.id)}>
                        <Play className="h-3 w-3" aria-hidden />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-6 w-6" title={m.paused ? "Resume" : "Pause"} disabled={toggleMonitor.isPending} onClick={() => toggleMonitor.mutate({ id: m.id, paused: !m.paused })}>
                        {m.paused ? <Play className="h-3 w-3" aria-hidden /> : <Pause className="h-3 w-3" aria-hidden />}
                      </Button>
                      <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" title="Delete" disabled={deleteMonitor.isPending} onClick={() => deleteMonitor.mutate(m.id)}>
                        <Trash2 className="h-3 w-3" aria-hidden />
                      </Button>
                    </span>
                  </div>
                </li>
              ))}
              {(s.monitors ?? []).map((m, i) => (
                <li key={m.id ?? `native-${i}`} className="flex items-center justify-between gap-2 rounded border border-border/50 px-2 py-1">
                  <span className="truncate">{m.search?.query ?? m.name ?? "(query n/a)"}</span>
                  <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                    <Badge variant="outline" className="px-1 py-0 text-[9px]">EXA</Badge>
                    <Timer className="h-3 w-3" aria-hidden />
                    {m.trigger?.period ?? "manual"}
                    {(m.status ?? m.state) ? ` · ${m.status ?? m.state}` : ""}
                    <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" title="Delete" disabled={deleteMonitor.isPending || !m.id} onClick={() => m.id && deleteMonitor.mutate(m.id)}>
                      <Trash2 className="h-3 w-3" aria-hidden />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {s?.monitorsError ? `List failed: ${s.monitorsError.slice(0, 60)}` : "No monitors yet."}
            </p>
          )}
          <div className="flex gap-2">
            <Input
              className="h-8 flex-1 text-xs"
              value={monitorQuery}
              onChange={(e) => setMonitorQuery(e.target.value)}
              aria-label="Monitor query"
            />
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              value={monitorPeriod}
              onChange={(e) => setMonitorPeriod(e.target.value)}
              aria-label="Monitor interval"
            >
              {/* Local scheduler floors at 15m; native Exa monitors floor at 1h (docs). */}
              <option value="15m">15m</option>
              <option value="1h">1h</option>
              <option value="6h">6h</option>
              <option value="12h">12h</option>
              <option value="1d">1d</option>
              <option value="7d">7d</option>
            </select>
            <Button size="sm" variant="secondary" className="h-8" disabled={!s?.armed || createMonitor.isPending} onClick={() => createMonitor.mutate()}>
              Create
            </Button>
          </div>
          {s?.monitorRuns?.length ? (
            <div className="space-y-1">
              <p className="text-[10px] font-medium text-muted-foreground">Recent runs</p>
              <ul className="max-h-24 space-y-0.5 overflow-y-auto pr-1 text-[10px]">
                {s.monitorRuns.slice(0, 6).map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 text-muted-foreground">
                    <span className="truncate" title={r.error || r.query}>
                      <span className={r.ok ? "text-primary" : "text-destructive"}>{r.ok ? "✓" : "✕"}</span>{" "}
                      {r.query.slice(0, 40)}
                    </span>
                    <span className="shrink-0">
                      {r.ok ? `${r.itemCount} items${r.newCount ? ` · ${r.newCount} new` : ""} · ` : `${r.error.slice(0, 24)} · `}
                      {formatDistanceToNow(new Date(r.at), { addSuffix: true })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {s?.webhookInbox?.length ? (
            <p className="text-[11px] text-muted-foreground">
              Last inbox push: {formatDistanceToNow(new Date(s.webhookInbox[0].receivedAt), { addSuffix: true })} · {s.webhookInbox[0].kind}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
