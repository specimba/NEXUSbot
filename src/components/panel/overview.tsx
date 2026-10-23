"use client";

import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { PanelEvent, PanelStats } from "@/lib/types";
import { CreditsCard } from "./credits-card";
import { DurabilityCard } from "./durability-card";
import { formatDistanceToNow } from "date-fns";
import { Activity, Database, KeyRound, Timer } from "lucide-react";

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number | string;
  icon: typeof Database;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md border border-primary/25 bg-primary/10">
          <Icon className="size-5 text-primary" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          <p className="font-mono text-2xl font-semibold text-primary text-glow">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function levelBadgeClass(level: string): string {
  switch (level) {
    case "error":
      return "border-destructive/50 text-destructive";
    case "warn":
      return "border-accent/60 text-accent";
    case "debug":
      return "text-muted-foreground";
    default:
      return "border-primary/40 text-primary";
  }
}

export function OverviewTab() {
  const stats = useQuery<PanelStats>({
    queryKey: ["stats"],
    queryFn: async () => {
      const res = await fetch("/api/stats", { cache: "no-store" });
      if (!res.ok) throw new Error("stats unavailable");
      const body = await res.json();
      return body.stats as PanelStats;
    },
  });

  const events = useQuery<{ events: PanelEvent[] }>({
    queryKey: ["events", "overview"],
    queryFn: async () => {
      const res = await fetch("/api/events?limit=6", { cache: "no-store" });
      if (!res.ok) throw new Error("events unavailable");
      return res.json();
    },
  });

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)
        ) : stats.isError ? (
          <p className="col-span-full text-sm text-destructive" role="alert">
            Stats unavailable — is the API up? Pull to retry after fixing.
          </p>
        ) : stats.data ? (
          <>
            <StatCard label="Events stored" value={stats.data.eventsTotal} icon={Database} />
            <StatCard label="Active ingest tokens" value={stats.data.tokensActive} icon={KeyRound} />
            <StatCard label="Vault credentials" value={stats.data.credentialsTotal} icon={Activity} />
            <StatCard
              label="Server uptime"
              value={`${Math.floor(stats.data.uptimeSec / 60)}m`}
              icon={Timer}
            />
          </>
        ) : null}
      </div>

      <DurabilityCard />

      <CreditsCard />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Recent events
          </CardTitle>
        </CardHeader>
        <CardContent>
          {events.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 rounded-md" />
              ))}
            </div>
          ) : events.isError ? (
            <p className="text-sm text-destructive" role="alert">
              Event list unavailable.
            </p>
          ) : events.data && events.data.events.length > 0 ? (
            <ul className="divide-y divide-border/60">
              {events.data.events.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-2 py-2.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge variant="outline" className={levelBadgeClass(e.level)}>
                      {e.level}
                    </Badge>
                    <span className="truncate font-mono text-sm">{e.type}</span>
                    <span className="hidden text-xs text-muted-foreground sm:inline">
                      {e.source}
                    </span>
                  </div>
                  <time
                    dateTime={e.ts}
                    suppressHydrationWarning
                    className="shrink-0 text-xs text-muted-foreground"
                  >
                    {formatDistanceToNow(new Date(e.ts), { addSuffix: true })}
                  </time>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No events yet — the L0 stream fills up as your widget, userscript and agents report
              in. Honest zero, nothing faked.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
