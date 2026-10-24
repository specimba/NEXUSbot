"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import type { IngestTokenRow, PanelEvent } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";

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

/**
 * R18-d — copyable example for the ingest-token dialog. The contract is
 * REAL, verified against POST /api/events (type required, source defaults
 * "system", level defaults "info", payload any JSON ≤ 8 KiB) and POST
 * /api/usage (same bearer authorizes counter writes: {kind, model, …}).
 */
const INGEST_EXAMPLE = `POST /api/events
Authorization: Bearer <your-ingest-token>
Content-Type: application/json

{"type":"viewer.join","source":"kick","payload":{"user":"@name"}}`;

export function StreamTab() {
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const events = useQuery<{ events: PanelEvent[] }>({
    queryKey: ["events", "live"],
    queryFn: async () => {
      const res = await fetch("/api/events?limit=100", { cache: "no-store" });
      if (!res.ok) throw new Error("events unavailable");
      return res.json();
    },
    refetchInterval: 2000,
  });

  const tokens = useQuery<{ tokens: IngestTokenRow[] }>({
    queryKey: ["ingest-tokens"],
    queryFn: async () => {
      const res = await fetch("/api/ingest-tokens", { cache: "no-store" });
      if (!res.ok) throw new Error("tokens unavailable");
      return res.json();
    },
  });

  const createToken = useMutation({
    mutationFn: async (label: string) => {
      const res = await fetch("/api/ingest-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) throw new Error("Token creation failed");
      return res.json() as Promise<{ token: string; record: { id: string } }>;
    },
    onSuccess: (data) => {
      setFreshToken(data.token);
      void queryClient.invalidateQueries({ queryKey: ["ingest-tokens"] });
      toast({ title: "Ingest token created", description: "Copy it now — shown only once." });
    },
    onError: (e: Error) =>
      toast({ title: "Token creation failed", description: e.message, variant: "destructive" }),
  });

  const revokeToken = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/ingest-tokens/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Revoke failed");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ingest-tokens"] });
      toast({ title: "Token revoked" });
    },
    onError: (e: Error) =>
      toast({ title: "Revoke failed", description: e.message, variant: "destructive" }),
  });

  const [tokenLabel, setTokenLabel] = useState("");
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const sources = useMemo(() => {
    const s = new Set<string>();
    for (const e of events.data?.events ?? []) s.add(e.source);
    return [...s].sort();
  }, [events.data]);

  const visible = (events.data?.events ?? []).filter(
    (e) => sourceFilter === "all" || e.source === sourceFilter,
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Live L0 stream
          </CardTitle>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="min-h-9 font-mono">
                <KeyRound className="size-4" aria-hidden="true" />
                Ingest tokens ({tokens.data?.tokens.filter((t) => !t.revokedAt).length ?? "…"})
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Ingest tokens</DialogTitle>
                <DialogDescription>
                  Bearer tokens for writing events into L0 (widget / userscript / automations).
                  Hashed at rest; plaintext is shown exactly once.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                {/* R18d help block — what ingest tokens are for + how to use them,
                    with the REAL request contract (copyable). */}
                <div className="space-y-2 rounded-md border border-border/60 bg-muted/30 p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    What this is for
                  </p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Ingest tokens let external things — the Kick widget, userscripts,
                    automations — write events into the L0 stream (and usage counters)
                    without ever knowing the panel password. Only a sha256 hash is
                    stored; the plaintext token is shown exactly once at creation.
                  </p>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    How to use
                  </p>
                  <ol className="list-decimal space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
                    <li>
                      Type a label like <span className="font-mono">kick-widget</span> → Create.
                    </li>
                    <li>Copy the shown token immediately — it is never displayed again.</li>
                    <li>From your external script, send requests with it:</li>
                  </ol>
                  <div className="flex items-start gap-2">
                    <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words rounded bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                      {INGEST_EXAMPLE}
                    </pre>
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-11 shrink-0"
                      aria-label="Copy example request to clipboard"
                      onClick={async () => {
                        await navigator.clipboard.writeText(INGEST_EXAMPLE);
                        toast({ title: "Example request copied" });
                      }}
                    >
                      <Copy className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    The same token also authorizes usage-counter writes at{" "}
                    <span className="font-mono">POST /api/usage</span>.
                  </p>
                </div>

                <form
                  className="flex items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    createToken.mutate(tokenLabel.trim() || "default");
                    setTokenLabel("");
                  }}
                >
                  <div className="flex-1 space-y-1.5">
                    <Label htmlFor="token-label">Label</Label>
                    <Input
                      id="token-label"
                      value={tokenLabel}
                      onChange={(e) => setTokenLabel(e.target.value)}
                      placeholder="kick-widget"
                      maxLength={48}
                    />
                  </div>
                  <Button
                    type="submit"
                    className="min-h-11 font-mono"
                    disabled={createToken.isPending}
                  >
                    <Plus className="size-4" aria-hidden="true" />
                    Create
                  </Button>
                </form>

                {freshToken && (
                  <div className="space-y-2 rounded-md border border-accent/50 bg-accent/10 p-3">
                    <p className="text-xs font-medium text-accent">
                      Shown once — copy now, it cannot be retrieved again:
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 truncate rounded bg-background/60 p-2 font-mono text-xs">
                        {freshToken}
                      </code>
                      <Button
                        variant="outline"
                        size="icon"
                        className="size-11 shrink-0"
                        aria-label="Copy token to clipboard"
                        onClick={async () => {
                          await navigator.clipboard.writeText(freshToken);
                          toast({ title: "Copied to clipboard" });
                        }}
                      >
                        <Copy className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                )}

                <div className="max-h-64 space-y-2 overflow-y-auto">
                  {tokens.isLoading ? (
                    Array.from({ length: 2 }).map((_, i) => (
                      <Skeleton key={i} className="h-12 rounded-md" />
                    ))
                  ) : tokens.data && tokens.data.tokens.length > 0 ? (
                    tokens.data.tokens.map((t) => (
                      <div
                        key={t.id}
                        className="flex items-center justify-between gap-2 rounded-md border border-border/60 p-2.5"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-mono text-sm">
                            {t.label} <span className="text-muted-foreground">{t.preview}</span>
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {t.revokedAt
                              ? "revoked"
                              : t.lastUsedAt
                                ? `last used ${formatDistanceToNow(new Date(t.lastUsedAt), { addSuffix: true })}`
                                : "never used"}
                          </p>
                        </div>
                        {!t.revokedAt && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-11 shrink-0 text-destructive"
                            aria-label={`Revoke token ${t.label}`}
                            disabled={revokeToken.isPending}
                            onClick={() => revokeToken.mutate(t.id)}
                          >
                            <Trash2 className="size-4" aria-hidden="true" />
                          </Button>
                        )}
                      </div>
                    ))
                  ) : (
                    <p className="py-4 text-center text-sm text-muted-foreground">
                      No ingest tokens yet — create one to let your widget write events.
                    </p>
                  )}
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter by source">
            <button
              onClick={() => setSourceFilter("all")}
              aria-pressed={sourceFilter === "all"}
              className={cn(
                "min-h-9 rounded-full border px-3 font-mono text-xs",
                sourceFilter === "all"
                  ? "border-primary/40 bg-primary/15 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              all
            </button>
            {sources.map((s) => (
              <button
                key={s}
                onClick={() => setSourceFilter(s)}
                aria-pressed={sourceFilter === s}
                className={cn(
                  "min-h-9 rounded-full border px-3 font-mono text-xs",
                  sourceFilter === s
                    ? "border-primary/40 bg-primary/15 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {s}
              </button>
            ))}
          </div>

          {events.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-10 rounded-md" />
              ))}
            </div>
          ) : events.isError ? (
            <p className="text-sm text-destructive" role="alert">
              Live stream unavailable — retrying automatically.
            </p>
          ) : visible.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Waiting for events… (polling every 2s). Stream is honestly empty until something
              reports in.
            </p>
          ) : (
            <ul
              className="max-h-96 divide-y divide-border/60 overflow-y-auto pr-1"
              aria-live="polite"
            >
              {visible.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-2 py-2.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge variant="outline" className={levelBadgeClass(e.level)}>
                      {e.level}
                    </Badge>
                    <span className="truncate font-mono text-sm">{e.type}</span>
                    <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
                      {e.source}
                    </Badge>
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
          )}
        </CardContent>
      </Card>
    </div>
  );
}
