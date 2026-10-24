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
import type { HyperbrowserStatusPayload } from "@/lib/connectors/hyperbrowser";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { Globe, KeyRound, PlugZap, RefreshCw, Trash2 } from "lucide-react";

/**
 * T-205 — Hyperbrowser connector card. Honest states only:
 * NOT CONFIGURED (key input) → CONNECTED / KEY REJECTED / UNREACHABLE / VAULT ERROR.
 * A reachable host with a rejected key is never shown as "connected".
 */

type StatusResponse = { ok: true; status: HyperbrowserStatusPayload };

function reachability(
  s: HyperbrowserStatusPayload,
): { label: string; badgeClass: string; detail: string } {
  if (!s.configured) {
    return { label: "NOT CONFIGURED", badgeClass: "text-muted-foreground border-border", detail: "No API key stored in the vault yet." };
  }
  if (s.apiOk) {
    return {
      label: "CONNECTED",
      badgeClass: "border-primary/40 text-primary",
      detail: `GET /api/sessions accepted the key${s.sessionsCount !== null ? ` · ${s.sessionsCount} session(s) on record` : ""}.`,
    };
  }
  if (s.reachable === false) {
    return { label: "UNREACHABLE", badgeClass: "border-destructive/50 text-destructive", detail: s.error ?? "Probe failed before an HTTP answer." };
  }
  if (s.error?.includes("unreadable")) {
    return { label: "VAULT ERROR", badgeClass: "border-accent/60 text-accent", detail: s.error };
  }
  return { label: "KEY REJECTED", badgeClass: "border-destructive/50 text-destructive", detail: s.error ?? "Hyperbrowser did not accept the stored key." };
}

export function HyperbrowserCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [apiKeyInput, setApiKeyInput] = useState("");

  const status = useQuery<StatusResponse>({
    queryKey: ["connector-hyperbrowser-status"],
    queryFn: async () => {
      const res = await fetch("/api/connectors/hyperbrowser/status", { cache: "no-store" });
      if (!res.ok) throw new Error("status unavailable");
      return res.json() as Promise<StatusResponse>;
    },
    refetchInterval: 30_000,
  });

  const saveKey = useMutation({
    mutationFn: async (apiKey: string) => {
      const res = await fetch("/api/connectors/hyperbrowser/key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `Save failed (HTTP ${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      setApiKeyInput("");
      void queryClient.invalidateQueries({ queryKey: ["connector-hyperbrowser-status"] });
      toast({ title: "Hyperbrowser key stored", description: "Encrypted in the vault. Probing the API…" });
    },
    onError: (e: Error) =>
      toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/connectors/hyperbrowser/key", { method: "DELETE" });
      if (!res.ok) throw new Error(`Disconnect failed (HTTP ${res.status})`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connector-hyperbrowser-status"] });
      toast({ title: "Hyperbrowser disconnected", description: "Stored key removed from the vault." });
    },
    onError: (e: Error) =>
      toast({ title: "Disconnect failed", description: e.message, variant: "destructive" }),
  });

  const s = status.data?.status ?? null;
  const reach = s ? reachability(s) : null;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 font-mono">
            <PlugZap className="size-5 text-primary" aria-hidden="true" />
            Hyperbrowser
          </CardTitle>
          <CardDescription>
            Browser-agent sessions (REST + CDP). Key lives encrypted in the vault — masked
            previews only.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="icon"
          className="size-11 shrink-0"
          aria-label="Refresh Hyperbrowser status"
          disabled={status.isFetching}
          onClick={() => void status.refetch()}
        >
          <RefreshCw className={cn("size-4", status.isFetching && "animate-spin")} aria-hidden="true" />
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {status.isLoading ? (
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="h-12 rounded-md" />
            <Skeleton className="h-9 rounded-md" />
            <Skeleton className="h-9 w-2/3 rounded-md" />
          </div>
        ) : status.isError ? (
          <p className="text-sm text-destructive" role="alert">
            Connector status unavailable — retrying automatically.
          </p>
        ) : s && reach ? (
          <div className="space-y-4" aria-live="polite">
            <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 p-3">
              <div className="min-w-0">
                <p className="font-mono text-sm">reachability</p>
                <p className="truncate text-xs text-muted-foreground">{reach.detail}</p>
              </div>
              <Badge variant="outline" className={cn("shrink-0 font-mono text-[10px]", reach.badgeClass)}>
                {reach.label}
              </Badge>
            </div>

            {s.configured && s.credential ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 p-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-mono text-sm">
                    <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
                    vault key <span className="text-muted-foreground">{s.credential.masked}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    saved{" "}
                    <time
                      dateTime={s.credential.updatedAt}
                      suppressHydrationWarning
                    >
                      {formatDistanceToNow(new Date(s.credential.updatedAt), { addSuffix: true })}
                    </time>
                  </p>
                </div>
                <Button
                  variant="ghost"
                  className="min-h-11 shrink-0 text-destructive hover:text-destructive"
                  disabled={disconnect.isPending}
                  aria-label="Disconnect Hyperbrowser and remove the stored key"
                  onClick={() => disconnect.mutate()}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Disconnect
                </Button>
              </div>
            ) : (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (apiKeyInput.trim().length >= 8) saveKey.mutate(apiKeyInput.trim());
                }}
              >
                <Label htmlFor="hyperbrowser-api-key">Hyperbrowser API key</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="hyperbrowser-api-key"
                    type="password"
                    inputMode="text"
                    autoComplete="off"
                    spellCheck={false}
                    className="min-h-11 font-mono"
                    placeholder="hb_…"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    aria-describedby="hyperbrowser-key-note"
                  />
                  <Button
                    type="submit"
                    className="min-h-11 shrink-0 font-mono"
                    disabled={apiKeyInput.trim().length < 8 || saveKey.isPending}
                  >
                    {saveKey.isPending ? "Saving…" : "Save key"}
                  </Button>
                </div>
                <p id="hyperbrowser-key-note" className="text-xs text-muted-foreground">
                  Stored AES-256-GCM in the local vault — never displayed again, only a
                  masked preview. Probe target:{" "}
                  <span className="font-mono">
                    {s.probeTarget} · GET /api/sessions · 8s timeout
                  </span>
                </p>
              </form>
            )}

            {s.configured && (
              <p className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] [overflow-wrap:anywhere] text-muted-foreground">
                <Globe className="size-3" aria-hidden="true" />
                probe {s.probeTarget} · GET /api/sessions
                {s.probedAt ? (
                  <>
                    {" · "}
                    <time dateTime={s.probedAt} suppressHydrationWarning>
                      {formatDistanceToNow(new Date(s.probedAt), { addSuffix: true })}
                    </time>
                  </>
                ) : null}
              </p>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
