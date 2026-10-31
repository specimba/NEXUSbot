"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, Coins, Globe, KeyRound, Loader2, RefreshCw, Search, Server } from "lucide-react";

/**
 * v37.3 — WEB LANES card: the three web lanes from the agent-systems
 * capture (docs/agentmail-deep-dive.md §4/§5).
 *   Keenable — FREE search (100k window) — the lane that found the Nikolina
 *              ticketing evidence Exa missed [MEASURED].
 *   TinyFish — FREE JS-page fetch (residential-proxy egress) — the arena-class
 *              SPA reader [MEASURED on artificialanalysis.ai].
 *   Firecrawl — metered backup (1,400 credits) — last resort after both free lanes.
 * Exa stays PRIMARY; these are fallbacks. Honest states only.
 * EN pass: v37.1 shipped the card in Turkish — the rest of the panel is EN,
 * this card now matches (owner ask 2026-10-30).
 * v38.7 — KEY ENTRY (owner ask 2026-10-31 ~04:15 +03: "still empty no key
 * entry parts for me to fill"): each lane now carries its own paste-and-seal
 * field. The secret goes through POST /api/credentials (AES vault, masked
 * preview only — the plaintext never leaves the process) and the lane status
 * refetches immediately, so the owner can arm Keenable/TinyFish/Firecrawl
 * without touching the .env or the seal file by hand.
 */

type LaneStatus = {
  ok: true;
  status: {
    configured: boolean;
    reachable: boolean | null;
    apiOk: boolean | null;
    error: string | null;
    credential: { masked: string; keyId: string; updatedAt: string } | null;
    probedAt: string | null;
  } & Record<string, unknown>;
};

type SearchResponse = {
  ok: true;
  search: {
    query: string;
    results: Array<{ title: string; url: string; snippet: string; description: string }>;
    formatted: string;
    tookMs: number;
  };
};

function useLaneStatus(lane: string) {
  return useQuery<LaneStatus>({
    queryKey: ["connectors", lane, "status"],
    queryFn: async () => {
      const res = await fetch(`/api/connectors/${lane}/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
  });
}

function laneBadge(st: LaneStatus["status"] | undefined) {
  if (!st) return <Skeleton className="h-5 w-16" />;
  if (!st.configured)
    return <Badge variant="outline" className="text-muted-foreground">no key</Badge>;
  if (st.apiOk) return <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">live</Badge>;
  return <Badge variant="destructive">see error</Badge>;
}

const LANES = [
  {
    key: "keenable",
    name: "Keenable",
    icon: Search,
    role: "FREE search — 100k requests (renews Nov 29)",
    detail: "Catches the colloquial-Turkish entity class where Exa failed (Nikolina proof).",
  },
  {
    key: "tinyfish",
    name: "TinyFish",
    icon: Server,
    role: "FREE JS-page reader — residential proxy egress",
    detail: "Reads arena.ai-class SPA pages as markdown [MEASURED].",
  },
  {
    key: "firecrawl",
    name: "Firecrawl",
    icon: Coins,
    role: "METERED backup — 1,400 credits (resets Nov 29)",
    detail: "Last resort: when both free lanes fail the same page.",
  },
] as const;

/** v38.7 — per-lane paste-and-seal key field. Save → vault → status refetch. */
function LaneKeyField({
  laneKey,
  laneName,
  configured,
  masked,
  onSaved,
}: {
  laneKey: string;
  laneName: string;
  configured: boolean;
  masked: string | null;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: laneKey, secret: value.trim(), label: "default" }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
      return body;
    },
    onSuccess: () => {
      setValue("");
      setOpen(false);
      toast({ title: `${laneName} key sealed into the vault`, description: "Lane status re-checks now." });
      onSaved();
    },
    onError: (err: Error) => {
      toast({ title: `${laneName} key save failed`, description: err.message, variant: "destructive" });
    },
  });

  if (!open) {
    return configured ? (
      <span className="flex min-w-0 items-center gap-1">
        <KeyRound className="h-3 w-3 shrink-0 text-emerald-600" aria-hidden />
        <span className="truncate font-mono text-[11px] text-muted-foreground" title="vault credential (masked)">
          {masked || "sealed"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 px-2 text-[11px] text-muted-foreground"
          aria-label={`Replace ${laneName} key`}
          onClick={() => setOpen(true)}
        >
          replace
        </Button>
      </span>
    ) : (
      <Button
        variant="outline"
        size="sm"
        className="h-6 shrink-0 gap-1 px-2 text-[11px]"
        aria-label={`Add ${laneName} key`}
        onClick={() => setOpen(true)}
      >
        <KeyRound className="h-3 w-3" aria-hidden />
        add key
      </Button>
    );
  }

  return (
    <span className="flex w-full min-w-0 items-center gap-1">
      <Input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={`paste ${laneName} API key`}
        aria-label={`${laneName} API key`}
        className="h-7 min-w-0 flex-1 font-mono text-[11px]"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim().length >= 8) save.mutate();
          if (e.key === "Escape") { setOpen(false); setValue(""); }
        }}
      />
      <Button
        size="sm"
        className="h-7 shrink-0 gap-1 px-2 text-[11px]"
        disabled={save.isPending || value.trim().length < 8}
        onClick={() => save.mutate()}
      >
        {save.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
        seal
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2 text-[11px]"
        aria-label="Cancel key entry"
        onClick={() => { setOpen(false); setValue(""); }}
      >
        cancel
      </Button>
    </span>
  );
}

export function AgentLanesCard() {
  const { toast } = useToast();
  const [query, setQuery] = useState("");

  const keenable = useLaneStatus("keenable");
  const tinyfish = useLaneStatus("tinyfish");
  const firecrawl = useLaneStatus("firecrawl");
  const statusMap: Record<string, ReturnType<typeof useLaneStatus>> = {
    keenable,
    tinyfish,
    firecrawl,
  };

  const search = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/connectors/keenable/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, maxResults: 5 }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      return body as SearchResponse;
    },
    onSuccess: (data) => {
      toast({
        title: `Keenable — ${data.search.results.length} sources (${data.search.tookMs}ms)`,
        description: data.search.results.map((r) => r.url).slice(0, 3).join(" · "),
      });
    },
    onError: (err: Error) => {
      toast({ title: "Keenable search failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-4 w-4" aria-hidden />
          WEB LANES — free search/read layers
        </CardTitle>
        <CardDescription>
          Exa stays primary (owner doctrine); these three lanes take over the
          moment it drops: Keenable (free search), TinyFish (free JS-page
          reading), Firecrawl (metered last resort). Budget impact: $0. Keys
          are pasted here and sealed into the vault — no .env editing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-2" role="list">
          {LANES.map((lane) => {
            const st = statusMap[lane.key].data?.status;
            const q = statusMap[lane.key];
            return (
              <li
                key={lane.key}
                className="space-y-1.5 rounded-md border border-border/60 p-2 text-xs"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <lane.icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="font-medium">{lane.name}</span>
                  {laneBadge(st)}
                  <span className="text-muted-foreground min-w-0 flex-1 truncate" title={lane.role}>
                    {lane.role}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    aria-label={`Refresh ${lane.name}`}
                    onClick={() => q.refetch()}
                  >
                    <RefreshCw className="h-3 w-3" />
                  </Button>
                </div>
                {/* v38.7 — the owner-facing key entry: paste → seal → vault */}
                <LaneKeyField
                  laneKey={lane.key}
                  laneName={lane.name}
                  configured={Boolean(st?.configured)}
                  masked={st?.credential?.masked ?? null}
                  onSaved={() => q.refetch()}
                />
                {q.isError && (
                  <span className="block w-full text-destructive">
                    <AlertTriangle className="mr-1 inline h-3 w-3" />
                    {(q.error as Error).message}
                  </span>
                )}
                {st?.error && (
                  <span className="block w-full text-destructive">{st.error}</span>
                )}
              </li>
            );
          })}
        </ul>

        {/* Keenable search test — proves the free lane with real results */}
        {keenable.data?.status.configured && (
          <div className="space-y-2 rounded-md border border-border/60 p-3">
            <div className="text-xs font-medium">
              Free search test — you can re-run the Nikolina proof
            </div>
            <div className="flex gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. DJ Nikolina 74 Hall concert"
                aria-label="Keenable search query"
                className="text-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && query.trim().length >= 2) search.mutate();
                }}
              />
              <Button
                size="sm"
                className="gap-1 shrink-0"
                disabled={search.isPending || query.trim().length < 2}
                onClick={() => search.mutate()}
              >
                {search.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Search className="h-3 w-3" />
                )}
                search
              </Button>
            </div>
            {search.data && (
              <ul className="max-h-64 space-y-1 overflow-y-auto text-xs" role="list">
                {search.data.search.results.map((r, i) => (
                  <li key={i} className="truncate" title={r.snippet || r.description}>
                    <span className="text-muted-foreground">{i + 1}.</span>{" "}
                    <span className="text-primary underline-offset-2">{r.url}</span>
                    {r.title ? ` — ${r.title}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
