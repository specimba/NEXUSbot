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
import { Database, Loader2, RefreshCw, Unplug } from "lucide-react";

/**
 * T-204 — Upstash REST connector card.
 *
 * Three honest states only: NOT CONFIGURED (credential form) · SAVING (mutation
 * in flight) · CONNECTED (live-probed health row: measured latency or the real
 * error). There is no optimistic "connected" — health comes from the server's
 * live GET {url}/ping probe on every status read.
 *
 * P7: the stored token/url are never rendered, never prefetched, never echoed.
 */

type UpstashStatus = {
  ok: boolean;
  configured: boolean;
  healthy?: boolean;
  latencyMs?: number;
  probedAt?: string;
  error?: { code: string; message: string };
};

const STATUS_KEY = ["connector", "upstash", "status"] as const;

async function fetchStatus(): Promise<UpstashStatus> {
  const res = await fetch("/api/connectors/upstash/status", { cache: "no-store" });
  if (res.status === 401) throw new Error("Panel session expired — sign in again.");
  if (!res.ok) throw new Error("Status unavailable");
  return res.json() as Promise<UpstashStatus>;
}

export function UpstashCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const status = useQuery<UpstashStatus>({
    queryKey: STATUS_KEY,
    queryFn: fetchStatus,
    refetchInterval: 30_000,
  });

  const [restUrl, setRestUrl] = useState("");
  const [restToken, setRestToken] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/connectors/upstash/token", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: restUrl.trim(), token: restToken.trim() }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: { message?: string } }
        | null;
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error?.message ?? "Saving the credential failed");
      }
      return json;
    },
    onSuccess: () => {
      setRestUrl("");
      setRestToken("");
      void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
      toast({
        title: "Upstash REST credential saved",
        description: "Stored encrypted in the vault — probing live health now.",
      });
    },
    onError: (e: Error) =>
      toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/connectors/upstash/token", { method: "DELETE" });
      if (!res.ok) throw new Error("Disconnect failed");
      return res.json() as Promise<{ ok: boolean; removed: boolean }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
      toast({ title: "Upstash disconnected", description: "Credential removed from the vault." });
    },
    onError: (e: Error) =>
      toast({ title: "Disconnect failed", description: e.message, variant: "destructive" }),
  });

  const busy = save.isPending || disconnect.isPending;
  const configured = status.data?.configured === true;
  const healthy = status.data?.healthy === true;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 font-mono">
            <Database className="size-5 text-primary" aria-hidden="true" />
            Upstash Redis
            <span className="text-xs font-normal text-muted-foreground">REST · T-204</span>
          </CardTitle>
          <CardDescription>
            Redis Streams over the Upstash REST API (XADD / XREADGROUP via /pipeline).
          </CardDescription>
        </div>
        {status.isLoading ? (
          <Skeleton className="h-6 w-28 rounded-full" />
        ) : (
          <Badge
            variant="outline"
            aria-label={`Connector state: ${
              !configured ? "not configured" : busy ? "working" : healthy ? "connected" : "unhealthy"
            }`}
            className={cn(
              "shrink-0 font-mono text-[10px]",
              !configured && "text-muted-foreground",
              configured && busy && "border-accent/60 text-accent",
              configured && !busy && healthy && "border-primary/40 text-primary",
              configured && !busy && !healthy && "border-destructive/50 text-destructive",
            )}
          >
            {!configured ? "NOT CONFIGURED" : busy ? "SAVING" : healthy ? "CONNECTED" : "UNHEALTHY"}
          </Badge>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {status.isLoading ? (
          <div className="space-y-3" aria-hidden="true">
            <Skeleton className="h-11 w-full rounded-md" />
            <Skeleton className="h-11 w-full rounded-md" />
            <Skeleton className="h-11 w-32 rounded-md" />
          </div>
        ) : !configured ? (
          <form
            className="space-y-3"
            aria-label="Save Upstash REST credential"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) save.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="upstash-rest-url">REST URL</Label>
              <Input
                id="upstash-rest-url"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                required
                placeholder="https://your-db.upstash.io"
                className="h-11 font-mono"
                value={restUrl}
                onChange={(e) => setRestUrl(e.target.value)}
                disabled={save.isPending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="upstash-rest-token">REST token</Label>
              <Input
                id="upstash-rest-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                required
                placeholder="••••••••••••"
                className="h-11 font-mono"
                value={restToken}
                onChange={(e) => setRestToken(e.target.value)}
                disabled={save.isPending}
                aria-describedby="upstash-rest-token-hint"
              />
              <p id="upstash-rest-token-hint" className="text-xs text-muted-foreground">
                Stored AES-256-GCM encrypted in the vault. Never displayed again, never logged.
              </p>
            </div>
            <Button
              type="submit"
              className="min-h-11 w-full font-mono sm:w-auto"
              disabled={save.isPending || !restUrl.trim() || !restToken.trim()}
            >
              {save.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Saving…
                </>
              ) : (
                "Save credential"
              )}
            </Button>
          </form>
        ) : (
          <>
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/60 p-3"
              role="status"
              aria-live="polite"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
                  Ping
                </span>
                {status.isFetching ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
                ) : healthy && typeof status.data?.latencyMs === "number" ? (
                  <span
                    className="font-mono text-lg font-semibold text-primary text-glow"
                    aria-label={`Measured latency ${status.data.latencyMs} milliseconds`}
                  >
                    {status.data.latencyMs}
                    <span className="text-xs font-normal text-muted-foreground">ms</span>
                  </span>
                ) : (
                  <span className="font-mono text-lg font-semibold text-destructive">—</span>
                )}
                {healthy && typeof status.data?.latencyMs === "number" && (
                  <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
                    MEASURED
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="size-11 shrink-0"
                  aria-label="Re-probe Upstash health"
                  disabled={busy}
                  onClick={() => void status.refetch()}
                >
                  <RefreshCw
                    className={cn("size-4", status.isFetching && "animate-spin")}
                    aria-hidden="true"
                  />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0 text-destructive hover:text-destructive"
                  aria-label="Disconnect Upstash and delete stored credential"
                  disabled={busy}
                  onClick={() => disconnect.mutate()}
                >
                  {disconnect.isPending ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Unplug className="size-4" aria-hidden="true" />
                  )}
                </Button>
              </div>
            </div>

            {!healthy && status.data?.error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
                <p className="font-mono text-xs text-destructive" role="alert">
                  {status.data.error.code}
                </p>
                <p className="mt-1 text-sm text-destructive">{status.data.error.message}</p>
              </div>
            )}

            {healthy && status.data?.probedAt && (
              <p className="text-xs text-muted-foreground">
                Last probed live{" "}
                <time
                  dateTime={status.data.probedAt}
                  suppressHydrationWarning
                  className="font-mono"
                >
                  {new Date(status.data.probedAt).toLocaleTimeString()}
                </time>{" "}
                — auto re-probe every 30s, or use the refresh button.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
