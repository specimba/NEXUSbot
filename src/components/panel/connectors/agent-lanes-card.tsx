"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, Coins, Globe, Loader2, RefreshCw, Search, Server } from "lucide-react";

/**
 * v37.1 — WEB HATLARI card: the three new web lanes from the agent-systems
 * capture (docs/agentmail-deep-dive.md §4/§5).
 *   Keenable — FREE search (100k window) — the lane that found the Nikolina
 *              ticketing evidence Exa missed [MEASURED].
 *   TinyFish — FREE JS-page fetch (residential-proxy egress) — the arena-class
 *              SPA reader [MEASURED on artificialanalysis.ai].
 *   Firecrawl — metered backup (1,400 credits) — last resort after both free lanes.
 * Exa stays PRIMARY; these are fallbacks. Honest states only.
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
    return <Badge variant="outline" className="text-muted-foreground">anahtar yok</Badge>;
  if (st.apiOk) return <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">canlı</Badge>;
  return <Badge variant="destructive">hatayı gör</Badge>;
}

const LANES = [
  {
    key: "keenable",
    name: "Keenable",
    icon: Search,
    role: "ÜCRETSİZ arama — 100k istek (29 Kasım'da yenilenir)",
    detail: "Exa'nın sınıfta kaldığı Türkçe günlük dil sınıfını yakalar (Nikolina kanıtı).",
  },
  {
    key: "tinyfish",
    name: "TinyFish",
    icon: Server,
    role: "ÜCRETSİZ JS-sayfa okuyucu — residential proxy çıkışı",
    detail: "arena.ai sınıfı SPA sayfaları markdown olarak okur [MEASURED].",
  },
  {
    key: "firecrawl",
    name: "Firecrawl",
    icon: Coins,
    role: "ÖLÇÜLMÜŞ yedek — 1,400 kredi (29 Kasım'da sıfırlanır)",
    detail: "Son çare: iki ücretsiz hat da aynı sayfada başarısız olursa.",
  },
] as const;

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
        title: `Keenable — ${data.search.results.length} kaynak (${data.search.tookMs}ms)`,
        description: data.search.results.map((r) => r.url).slice(0, 3).join(" · "),
      });
    },
    onError: (err: Error) => {
      toast({ title: "Keenable araması başarısız", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-4 w-4" aria-hidden />
          WEB HATLARI — ücretsiz arama/okuma katmanları
        </CardTitle>
        <CardDescription>
          Exa birincil kalır (owner doktrini); bu üç hat düşüş anında devralır:
          Keenable (ücretsiz arama), TinyFish (ücretsiz JS-sayfa okuma), Firecrawl
          (kredili son çare). Bütçe etkisi: $0.
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
                className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 p-2 text-xs"
              >
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
                  aria-label={`${lane.name} yenile`}
                  onClick={() => q.refetch()}
                >
                  <RefreshCw className="h-3 w-3" />
                </Button>
                {q.isError && (
                  <span className="w-full text-destructive">
                    <AlertTriangle className="mr-1 inline h-3 w-3" />
                    {(q.error as Error).message}
                  </span>
                )}
                {st?.error && (
                  <span className="w-full text-destructive">{st.error}</span>
                )}
              </li>
            );
          })}
        </ul>

        {/* Keenable search test — proves the free lane with real results */}
        {keenable.data?.status.configured && (
          <div className="space-y-2 rounded-md border border-border/60 p-3">
            <div className="text-xs font-medium">
              Ücretsiz arama testi — Nikolina kanıtını tekrarlayabilirsin
            </div>
            <div className="flex gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ör. DJ Nikolina 74 Hall konser"
                aria-label="Keenable arama sorgusu"
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
                ara
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
