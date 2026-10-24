"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Toaster } from "@/components/ui/sonner";
import { Skeleton } from "@/components/ui/skeleton";
import type { VyceStatusPayload } from "@/lib/connectors/vyce";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { BrainCircuit, KeyRound, PlugZap, RefreshCw, Trash2 } from "lucide-react";

/**
 * T-207 — Vyce brain-gateway connector card. Honest states only:
 * NOT CONFIGURED (key + optional base-url) → CONNECTED / KEY REJECTED /
 * UNREACHABLE / VAULT ERROR, with per-role tier availability badges once the
 * live /models probe succeeds.
 *
 * P7: the key is typed once into a password input, POSTed, and never rendered
 * again — the card only ever receives a masked ••••tail preview. The Supabase
 * edge-secret fallback path is surfaced as a note (no value ever displayed).
 *
 * Toast note: the task mandates sonner; the root layout mounts only the radix
 * <Toaster/>, so the sonner <Toaster/> is mounted at this card's root (same
 * pattern as durability-card).
 */

type StatusResponse = { ok: true; status: VyceStatusPayload };

const ROLE_LABELS: Record<string, string> = {
  router: "ROUTER",
  worker: "WORKER",
  frontier: "FRONTIER",
  free: "FREE",
  batch: "BATCH",
  image: "IMAGE",
};

function reachability(s: VyceStatusPayload): { label: string; badgeClass: string; detail: string } {
  if (!s.configured && s.keySource === null) {
    return {
      label: "NOT CONFIGURED",
      badgeClass: "text-muted-foreground border-border",
      detail: "No Vyce key stored in the vault yet.",
    };
  }
  if (s.connected) {
    return {
      label: "CONNECTED",
      badgeClass: "border-primary/40 text-primary",
      detail: `GET /v1/models accepted the key${s.modelCount !== null ? ` · ${s.modelCount} model(s) on offer` : ""}.`,
    };
  }
  const code = s.error?.code ?? "";
  if (code === "VAULT_UNREADABLE") {
    return { label: "VAULT ERROR", badgeClass: "border-accent/60 text-accent", detail: s.error?.message ?? "Vault unreadable." };
  }
  if (code === "UNAUTHORIZED") {
    return { label: "KEY REJECTED", badgeClass: "border-destructive/50 text-destructive", detail: s.error?.message ?? "Vyce did not accept the key." };
  }
  if (code === "NETWORK_ERROR" || code === "FORBIDDEN") {
    return { label: "UNREACHABLE", badgeClass: "border-destructive/50 text-destructive", detail: s.error?.message ?? "Probe failed before an HTTP answer." };
  }
  if (code === "RATE_LIMITED") {
    return { label: "RATE LIMITED", badgeClass: "border-accent/60 text-accent", detail: s.error?.message ?? "Vyce asked to slow down." };
  }
  if (code) {
    return { label: code, badgeClass: "border-destructive/50 text-destructive", detail: s.error?.message ?? "Probe error." };
  }
  return { label: "NOT CONFIGURED", badgeClass: "text-muted-foreground border-border", detail: "No Vyce key stored in the vault yet." };
}

function tierBadgeClass(state: string | null): string {
  if (state === "available") return "border-primary/40 text-primary";
  if (state === "missing") return "border-destructive/40 text-destructive";
  return "border-border text-muted-foreground";
}

export function VyceCard() {
  const queryClient = useQueryClient();
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState("");

  const status = useQuery<StatusResponse>({
    queryKey: ["connector-vyce-status"],
    queryFn: async () => {
      const res = await fetch("/api/vyce/status", { cache: "no-store" });
      if (!res.ok) throw new Error("status unavailable");
      return res.json() as Promise<StatusResponse>;
    },
    refetchInterval: 30_000,
  });

  const saveKey = useMutation({
    mutationFn: async () => {
      const body: Record<string, string> = { key: apiKeyInput.trim() };
      if (baseUrlInput.trim().length > 0) body.baseUrl = baseUrlInput.trim();
      const res = await fetch("/api/vyce/key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(errBody?.error?.message ?? `Save failed (HTTP ${res.status})`);
      }
      return res.json() as Promise<{ probe?: { ok?: boolean; code?: string | null } }>;
    },
    onSuccess: (data) => {
      setApiKeyInput("");
      setBaseUrlInput("");
      void queryClient.invalidateQueries({ queryKey: ["connector-vyce-status"] });
      toast.success(
        "Vyce key stored",
        {
          description:
            data.probe?.ok === false
              ? "Encrypted in the vault — but the live probe did not accept it. See status."
              : "Encrypted in the vault. Probing the gateway…",
        },
      );
    },
    onError: (e: Error) => toast.error("Save failed", { description: e.message }),
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/vyce/key", { method: "DELETE" });
      if (!res.ok) throw new Error(`Disconnect failed (HTTP ${res.status})`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connector-vyce-status"] });
      toast.success("Vyce disconnected", { description: "Stored key removed from the vault." });
    },
    onError: (e: Error) => toast.error("Disconnect failed", { description: e.message }),
  });

  const s = status.data?.status ?? null;
  const reach = s ? reachability(s) : null;
  const showForm = s !== null && !s.configured && s.keySource !== "supabase-edge-secret";

  return (
    <Card>
      <Toaster position="bottom-right" richColors closeButton />
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 font-mono">
            <BrainCircuit className="size-5 text-primary" aria-hidden="true" />
            Vyce
          </CardTitle>
          <CardDescription>
            Brain LLM gateway (OpenAI-compatible). Key lives encrypted in the vault — masked
            previews only; it never enters the conversation chat.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="icon"
          className="size-11 shrink-0"
          aria-label="Refresh Vyce status"
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

            {s.keySource === "supabase-edge-secret" && (
              <p className="rounded-md border border-accent/40 bg-accent/10 p-2 text-xs text-accent">
                Using the Supabase Edge-Function secret fallback (VYCE_API_KEY on the harness
                project). Paste a vault key below to make it primary.
              </p>
            )}

            {s.configured && s.maskedKey ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 p-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-mono text-sm">
                    <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
                    vault key <span className="text-muted-foreground">{s.maskedKey}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    key source: <span className="font-mono">{s.keySource ?? "unknown"}</span>
                  </p>
                </div>
                <Button
                  variant="ghost"
                  className="min-h-11 shrink-0 text-destructive hover:text-destructive"
                  disabled={disconnect.isPending}
                  aria-label="Disconnect Vyce and remove the stored key"
                  onClick={() => disconnect.mutate()}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Disconnect
                </Button>
              </div>
            ) : showForm ? (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (apiKeyInput.trim().length >= 8) saveKey.mutate();
                }}
              >
                <Label htmlFor="vyce-api-key">Vyce API key</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="vyce-api-key"
                    type="password"
                    inputMode="text"
                    autoComplete="off"
                    spellCheck={false}
                    className="min-h-11 font-mono"
                    placeholder="vyce_… or sk-…"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    aria-describedby="vyce-key-note"
                  />
                  <Button
                    type="submit"
                    className="min-h-11 shrink-0 font-mono"
                    disabled={apiKeyInput.trim().length < 8 || saveKey.isPending}
                  >
                    {saveKey.isPending ? "Saving…" : "Save key"}
                  </Button>
                </div>
                <Label htmlFor="vyce-base-url">
                  Base URL <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="vyce-base-url"
                  type="text"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  className="min-h-11 font-mono"
                  placeholder="https://vyceai.com/v1 (default)"
                  value={baseUrlInput}
                  onChange={(e) => setBaseUrlInput(e.target.value)}
                  aria-describedby="vyce-key-note"
                />
                <p id="vyce-key-note" className="text-xs text-muted-foreground">
                  Stored AES-256-GCM in the local vault — never displayed again, never sent to
                  the chat surface. Probe target:{" "}
                  <span className="font-mono">{s.probeTarget} · GET /v1/models · 8s timeout</span>
                </p>
              </form>
            ) : null}

            {s.connected && (
              <div className="space-y-1.5">
                <p className="font-mono text-xs text-muted-foreground">tier availability</p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(s.tiers).map(([role, state]) => (
                    <Badge
                      key={role}
                      variant="outline"
                      className={cn("font-mono text-[10px]", tierBadgeClass(state))}
                      title={`${ROLE_LABELS[role] ?? role}: ${state ?? "unknown"}`}
                    >
                      {ROLE_LABELS[role] ?? role} · {state ?? "?"}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {s.configured || s.keySource === "supabase-edge-secret" ? (
              <p className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] [overflow-wrap:anywhere] text-muted-foreground">
                <PlugZap className="size-3" aria-hidden="true" />
                probe {s.probeTarget} · GET /v1/models
                {s.probedAt ? (
                  <>
                    {" · "}
                    <time dateTime={s.probedAt} suppressHydrationWarning>
                      {formatDistanceToNow(new Date(s.probedAt), { addSuffix: true })}
                    </time>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
