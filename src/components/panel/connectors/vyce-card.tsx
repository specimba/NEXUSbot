"use client";

import { useRef, useState } from "react";
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
 * UNREACHABLE / ORIGIN DOWN (R18-a: Vyce-side outage, distinct from key and
 * egress problems) / VAULT ERROR, with per-role tier availability badges once
 * the live /models probe succeeds.
 *
 * P7: the key is typed once into a password input, POSTed, and never rendered
 * again — the card only ever receives a masked ••••tail preview. The Supabase
 * edge-relay fallback path (nexus-relay Edge Function, task 17-b) is surfaced
 * as a note (no value ever displayed).
 *
 * Toast note: the task mandates sonner; the root layout mounts only the radix
 * <Toaster/>, so the sonner <Toaster/> is mounted at this card's root (same
 * pattern as durability-card).
 */

type StatusResponse = { ok: true; status: VyceStatusPayload };

/**
 * Copy-level source matcher: the edge-relay source ("supabase-edge-relay",
 * task 17-b) — with a defensive map for the pre-17-b "supabase-edge-secret"
 * string so a stale payload can never render as an unknown state.
 */
function isEdgeRelaySource(keySource: VyceStatusPayload["keySource"]): boolean {
  return keySource === "supabase-edge-relay" || keySource === "supabase-edge-secret";
}

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
  // R18-a: a measured Vyce-side outage — accent, NOT destructive: this is on
  // vyceai.com's side, not the owner's key and not our egress.
  if (code === "ORIGIN_DOWN" && s.origin !== "up") {
    return { label: "ORIGIN DOWN", badgeClass: "border-accent/60 text-accent", detail: s.error?.message ?? "vyceai.com's origin is not answering." };
  }
  // R18-a: the relay answers but its harness project has no VYCE_API_KEY set.
  if (code === "UPSTREAM_KEY_MISSING") {
    return { label: "RELAY KEY MISSING", badgeClass: "border-destructive/50 text-destructive", detail: s.error?.message ?? "The relay has no VYCE_API_KEY configured." };
  }
  if (code === "UNAUTHORIZED") {
    // Task 16-a/17-b: distinguish WHERE the rejected key lives — vault vs the
    // Supabase Edge-Function secret (reached via the nexus-relay edge function)
    // — so the guidance names the right place.
    if (isEdgeRelaySource(s.keySource)) {
      return {
        label: "KEY REJECTED",
        badgeClass: "border-destructive/50 text-destructive",
        detail:
          s.error?.message ??
          "Vyce rejected the Edge-Function secret VYCE_API_KEY — update it in the Supabase secrets (harness project) or paste a fresh key in the panel.",
      };
    }
    return {
      label: "KEY REJECTED",
      badgeClass: "border-destructive/50 text-destructive",
      detail: s.error?.message ?? "Vyce rejected the stored vault key — paste a fresh key or disconnect.",
    };
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
  // R19-a: manual Refresh = deliberate live re-check (?force=1 bypasses the
  // probe-cadence cache); the automatic 30s polls never set it. A ref (not
  // state) so the queryFn reads it synchronously at fetch time.
  const forceProbeRef = useRef(false);

  const status = useQuery<StatusResponse>({
    queryKey: ["connector-vyce-status"],
    queryFn: async () => {
      const force = forceProbeRef.current;
      forceProbeRef.current = false;
      const res = await fetch(`/api/vyce/status${force ? "?force=1" : ""}`, { cache: "no-store" });
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
              ? data.probe.code === "ORIGIN_DOWN"
                ? "Encrypted in the vault — but Vyce's origin is down right now, so the key could not be verified. See status."
                : "Encrypted in the vault — but the live probe did not accept it. See status."
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
  // R18-a: vault-first — the paste form also shows while the relay fallback is
  // the active source, so the owner can switch to the direct, EF-independent
  // path from this card (the secondary-path note below points at it).
  const showForm = s !== null && !s.configured;
  // R18-a: measured origin-down verdict — the distinct outage state block.
  const originDown = s !== null && ((s.error?.code === "ORIGIN_DOWN" && s.origin !== "up") || s.origin === "down");

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
          aria-label="Refresh Vyce status (live re-check)"
          disabled={status.isFetching}
          onClick={() => {
            forceProbeRef.current = true;
            void status.refetch();
          }}
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

            {originDown && (
              <p className="rounded-md border border-accent/40 bg-accent/10 p-2 text-xs text-accent">
                VYCE ORIGIN DOWN — vyceai.com&apos;s own origin server is not answering (Cloudflare 5xx). This is on
                Vyce&apos;s side — not your key, not our egress. Key verification resumes automatically once their
                origin returns; press Refresh to re-check.
              </p>
            )}

            {!s.connected && s.error?.code === "UNAUTHORIZED" && (
              <p className="rounded-md border border-border/60 p-2 text-xs text-muted-foreground">
                Vyce rejects an invalid key BEFORE metering — your Vyce dashboard will show 0 reqs for a rejected key.
                A successful probe WILL appear as a request on the Vyce dashboard, so you can always cross-check.
              </p>
            )}

            {isEdgeRelaySource(s.keySource) && (
              <p
                className={cn(
                  "rounded-md border p-2 text-xs",
                  s.connected
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : s.error?.code === "UNAUTHORIZED"
                      ? "border-destructive/40 bg-destructive/10 text-destructive"
                      : "border-border/60 text-muted-foreground",
                )}
              >
                {s.connected
                  ? "Working via the Supabase Edge-Function relay (nexus-relay on the harness project) — paste a vault key to make it primary"
                  : s.error?.code === "UNAUTHORIZED"
                    ? "The VYCE_API_KEY in the Supabase Edge-Function secrets was rejected by Vyce — update the secret there (harness project) or paste a fresh key in the panel below."
                    : "Probing via the Supabase Edge-Function relay (nexus-relay on the harness project) — the last probe did not reach a key verdict (Vyce maintenance / origin issues are on Vyce's side; see the outcome above). Paste a Vyce key below to switch to the direct, EF-independent path."}
              </p>
            )}

            {isEdgeRelaySource(s.keySource) && (
              <p className="rounded-md border border-border/60 p-2 text-xs text-muted-foreground">
                Secondary path — this depends on Supabase Edge Functions. Paste a Vyce key in the panel below to switch
                to the direct, EF-independent path (vault-first).
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
                  <span className="font-mono">{s.probeTarget} · GET /v1/models · timeout follows egress routing</span>
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

            {s.configured || isEdgeRelaySource(s.keySource) ? (
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
