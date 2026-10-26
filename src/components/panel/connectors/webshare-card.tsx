"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import { Eye, EyeOff, Globe, KeyRound, Loader2, Network, PlugZap, Radar, RefreshCw, Route, Trash2 } from "lucide-react";

type WebshareStatus = {
  ok: true;
  configured: boolean;
  routing: "off";
  apiOk?: boolean;
  checkedAt?: string;
  pool?: {
    count: number | null;
    validCount: number;
    sampled: number;
    sample: { country: string | null; valid: boolean | null }[];
  };
  error?: { code: string; message: string };
};

type ConnState = "loading" | "not-configured" | "checking" | "connected" | "error";

// --- Task 13-a: egress routing types (mirror of the API contracts, P7-safe —
// statuses / classifications / country codes / counts only, never secrets) ---

type EgressMode = "direct" | "proxy";

type EgressRoutingResponse = {
  ok: true;
  routing: Record<string, EgressMode>;
  targets: string[];
};

type EgressProbeSide = {
  status: number | null;
  reachable: boolean;
  classification: string;
  country?: string | null;
  error?: { code: string; message: string };
};

type EgressProbeResponse = {
  ok: true;
  target: string;
  checkedAt: string;
  /** Which key the probe sent ("keyless" when none could be resolved). */
  keyState?: "vault" | "edge-secret" | "keyless";
  /** Honest reason no key could be attached (e.g. the Groq edge secret is a
   *  SHA-256 hash) — never key material. */
  keyNote?: string | null;
  direct: EgressProbeSide;
  proxied: EgressProbeSide & { attempts: number };
  egressChanged: boolean;
  routing: { mode: EgressMode };
  pool: { count: number | null; validCount: number } | null;
};

const EGRESS_LABELS: Record<string, string> = {
  groq: "Groq API",
  vyce: "Vyce API",
  "generic-echo": "Generic egress",
  default: "Default",
};

const EGRESS_FALLBACK_ROWS: readonly string[] = ["groq", "vyce", "generic-echo"];

/** Honest badge colors — token classes only, never a fabricated success. */
function egressBadgeCls(side: EgressProbeSide): string {
  if (side.error) {
    return side.error.code === "NOT_CONFIGURED" ? "text-muted-foreground" : "text-destructive";
  }
  switch (side.classification) {
    case "OK":
      return "text-primary"; // measured success only
    case "KEY_REJECTED": // upstream answered + rejected the VAULT key — reachable
    case "UNAUTH_PROBE": // upstream answered a KEYLESS probe with 401 — not a key verdict
    case "UNREACHABLE_WAF":
    case "NOT_FOUND":
    case "RATE_LIMITED":
    case "UPSTREAM_ERROR":
    case "HTTP_OTHER":
      return "text-accent"; // warn: an answer, but not a usable one
    default:
      return "text-destructive"; // transport-level failure
  }
}

/**
 * T-206 — Webshare proxy-pool connector card.
 * Honest states only: a failed probe is shown as a failed probe, never dressed up.
 */
export function WebshareCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [apiToken, setApiToken] = useState("");
  const [showToken, setShowToken] = useState(false);

  const status = useQuery<WebshareStatus>({
    queryKey: ["connectors", "webshare", "status"],
    queryFn: async () => {
      const res = await fetch("/api/connectors/webshare/status", { cache: "no-store" });
      if (!res.ok) throw new Error("status unavailable");
      return res.json();
    },
    staleTime: 30_000,
    refetchInterval: 120_000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["connectors", "webshare"] });
  };

  const saveToken = useMutation({
    mutationFn: async (token: string) => {
      const res = await fetch("/api/connectors/webshare/token", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiToken: token }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? "Saving token failed");
      }
      return res.json();
    },
    onSuccess: () => {
      setApiToken("");
      invalidate();
      toast({ title: "Webshare token saved", description: "Encrypted in the vault. Probing the pool…" });
    },
    onError: (e: Error) =>
      toast({ title: "Token save failed", description: e.message, variant: "destructive" }),
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/connectors/webshare/token", { method: "DELETE" });
      if (!res.ok) throw new Error("Disconnect failed");
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Webshare token removed", description: "The connector is now NOT CONFIGURED." });
    },
    onError: (e: Error) =>
      toast({ title: "Disconnect failed", description: e.message, variant: "destructive" }),
  });

  const s = status.data;
  const state: ConnState = status.isLoading
    ? "loading"
    : !s
      ? "error"
      : !s.configured
        ? "not-configured"
        : s.apiOk === undefined
          ? "checking"
          : s.apiOk
            ? "connected"
            : "error";

  const stateBadge = {
    loading: { label: "…", cls: "text-muted-foreground" },
    "not-configured": { label: "NOT CONFIGURED", cls: "text-muted-foreground" },
    checking: { label: "PROBING…", cls: "text-accent" },
    connected: { label: "CONNECTED", cls: "text-primary" },
    error: { label: "PROBE FAILED", cls: "text-destructive" },
  }[state];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 font-mono">
          <Network className="size-5 text-primary" aria-hidden="true" />
          Webshare — proxy pool
          <Badge variant="outline" className={`ml-auto font-mono text-[10px] ${stateBadge.cls}`}>
            {stateBadge.label}
          </Badge>
        </CardTitle>
        <CardDescription>
          Owner pool of 30 authenticated direct proxies. Token lives encrypted in the vault;
          the panel only ever shows pool counts and reachability — never IPs or credentials.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {state === "loading" && (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-11 w-full rounded-md" />
            <Skeleton className="h-11 w-2/3 rounded-md" />
            <Skeleton className="h-14 w-full rounded-md" />
          </div>
        )}

        {state === "not-configured" && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (apiToken.trim().length >= 8) saveToken.mutate(apiToken.trim());
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="webshare-api-token">Webshare API token</Label>
              <div className="flex gap-2">
                <Input
                  id="webshare-api-token"
                  type={showToken ? "text" : "password"}
                  className="min-h-11 font-mono"
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  placeholder="paste token — shown once, stored encrypted"
                  autoComplete="off"
                  minLength={8}
                  required
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-11 shrink-0"
                  aria-label={showToken ? "Hide token" : "Show token"}
                  aria-pressed={showToken}
                  onClick={() => setShowToken((v) => !v)}
                >
                  {showToken ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" className="min-h-11 font-mono" disabled={saveToken.isPending || apiToken.trim().length < 8}>
                <KeyRound className="size-4" aria-hidden="true" />
                {saveToken.isPending ? "Saving…" : "Save token"}
              </Button>
              <p className="text-xs text-muted-foreground">
                Webshare Dashboard → API keys. Stored AES-256-GCM, never displayed again (P7).
              </p>
            </div>
          </form>
        )}

        {/* Routing decisions are independent of the connector state (task 13-a):
            toggles stay live even while NOT CONFIGURED — proxied probes then
            honestly report NOT_CONFIGURED instead of being gated. */}
        {state === "not-configured" && <EgressRoutingSection />}

        {state === "error" && (
          <div className="space-y-3">
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3" role="alert">
              <p className="font-mono text-sm text-destructive">
                Probe failed — honest result, no fake success.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {s?.error ? (
                  <>
                    <span className="font-mono">{s.error.code}</span>: {s.error.message}
                  </>
                ) : (
                  "Status endpoint unreachable — is the panel session still valid?"
                )}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                className="min-h-11 font-mono"
                onClick={() => status.refetch()}
                disabled={status.isFetching}
              >
                <RefreshCw className={`size-4 ${status.isFetching ? "animate-spin" : ""}`} aria-hidden="true" />
                Retry probe
              </Button>
              <DisconnectButton onConfirm={() => disconnect.mutate()} pending={disconnect.isPending} />
            </div>
          </div>
        )}

        {state === "error" && <EgressRoutingSection />}

        {state === "connected" && s?.pool && (
          <div className="space-y-4" aria-live="polite">
            <dl className="grid grid-cols-3 gap-3" aria-label="Pool summary">
              <div className="rounded-md border border-border/60 p-3">
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Pool count</dt>
                <dd className="font-mono text-xl text-primary text-glow">
                  {s.pool.count ?? "—"}
                </dd>
              </div>
              <div className="rounded-md border border-border/60 p-3">
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Valid</dt>
                <dd className="font-mono text-xl">{s.pool.validCount}</dd>
              </div>
              <div className="rounded-md border border-border/60 p-3">
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Sampled</dt>
                <dd className="font-mono text-xl">{s.pool.sampled}</dd>
              </div>
            </dl>

            {s.pool.sample.length > 0 && (
              <div className="flex flex-wrap gap-1.5" aria-label="Sampled countries">
                {s.pool.sample.map((p, i) => (
                  <Badge
                    key={`${p.country ?? "unknown"}-${i}`}
                    variant="outline"
                    className="border-border/60 font-mono text-[11px] text-muted-foreground"
                  >
                    <Globe className="size-3" aria-hidden="true" />
                    {p.country ?? "unknown"}
                    {p.valid === null ? " ?" : p.valid ? " ✓" : " ✗"}
                  </Badge>
                ))}
              </div>
            )}

            <p className="font-mono text-xs text-muted-foreground">
              reachability: API OK — live probe [MEASURED]
              {s.checkedAt && (
                <span suppressHydrationWarning>
                  {" "}
                  {formatDistanceToNow(new Date(s.checkedAt), { addSuffix: true })}
                </span>
              )}
            </p>

            <EgressRoutingSection />

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                className="min-h-11 font-mono"
                onClick={() => status.refetch()}
                disabled={status.isFetching}
              >
                <PlugZap className={`size-4 ${status.isFetching ? "animate-pulse" : ""}`} aria-hidden="true" />
                Re-probe now
              </Button>
              <DisconnectButton onConfirm={() => disconnect.mutate()} pending={disconnect.isPending} />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DisconnectButton({ onConfirm, pending }: { onConfirm: () => void; pending: boolean }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          className="min-h-11 font-mono text-destructive hover:text-destructive"
          disabled={pending}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          Disconnect
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove the stored Webshare token?</AlertDialogTitle>
          <AlertDialogDescription>
            The encrypted token is deleted from the vault and the connector returns to NOT
            CONFIGURED. Saved egress routing decisions persist — proxied paths will honestly
            report the missing token until it is saved again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
          <AlertDialogAction className="min-h-11" onClick={onConfirm}>
            Remove token
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Task 13-a — live per-upstream egress routing control (replaces the static
 * "routing OFF by default" notice). Talks to GET/POST /api/egress/routing and
 * POST /api/egress/probe only; renders honest classifications as badges.
 * Independent of the connector's configured state by design: the routing map
 * is a plain KV, so toggles stay live while the vault is empty and the probe's
 * proxied side honestly reports NOT_CONFIGURED.
 */
function EgressRoutingSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [probeResults, setProbeResults] = useState<Record<string, EgressProbeResponse>>({});

  const routing = useQuery<EgressRoutingResponse>({
    queryKey: ["egress", "routing"],
    queryFn: async () => {
      const res = await fetch("/api/egress/routing", { cache: "no-store" });
      if (!res.ok) throw new Error("routing map unavailable");
      return res.json();
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const setMode = useMutation({
    mutationFn: async ({ upstream, mode }: { upstream: string; mode: EgressMode }) => {
      const res = await fetch("/api/egress/routing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upstream, mode }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok: true; routing: Record<string, EgressMode> }
        | { ok: false; error?: { message?: string } }
        | null;
      if (!res.ok || !body || body.ok !== true) {
        throw new Error(
          (body as { error?: { message?: string } } | null)?.error?.message ?? "Routing update failed",
        );
      }
      return body;
    },
    onSuccess: (data, vars) => {
      queryClient.setQueryData<EgressRoutingResponse>(["egress", "routing"], {
        ok: true,
        routing: data.routing,
        targets: routing.data?.targets ?? [...EGRESS_FALLBACK_ROWS],
      });
      void queryClient.invalidateQueries({ queryKey: ["egress", "routing"], exact: true });
      toast({
        title: "Egress routing updated",
        description: `${EGRESS_LABELS[vars.upstream] ?? vars.upstream} → ${vars.mode}.`,
      });
    },
    onError: (e: Error) =>
      toast({ title: "Routing update failed", description: e.message, variant: "destructive" }),
  });

  const runProbe = useMutation({
    mutationFn: async (target: string) => {
      const res = await fetch("/api/egress/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target }),
      });
      const body = (await res.json().catch(() => null)) as
        | EgressProbeResponse
        | { ok: false; error?: { message?: string } }
        | null;
      if (!res.ok || !body || body.ok !== true) {
        throw new Error(
          (body as { error?: { message?: string } } | null)?.error?.message ?? "Egress probe failed",
        );
      }
      return body;
    },
    onSuccess: (data) => {
      setProbeResults((prev) => ({ ...prev, [data.target]: data }));
    },
    onError: (e: Error) =>
      toast({ title: "Egress probe failed", description: e.message, variant: "destructive" }),
  });

  const targetKeys =
    routing.data?.targets && routing.data.targets.length > 0
      ? routing.data.targets.filter((t) => t !== "default")
      : EGRESS_FALLBACK_ROWS;
  const rows = [...targetKeys, "default"];
  const busy = setMode.isPending || runProbe.isPending;

  return (
    <section className="space-y-2 rounded-md border border-border/60 p-3" aria-label="Egress routing">
      <div className="flex flex-wrap items-center gap-2">
        <Route className="size-4 text-primary" aria-hidden="true" />
        <h3 className="font-mono text-sm">Egress routing</h3>
        <Badge variant="outline" className="ml-auto border-border/60 font-mono text-[10px] text-muted-foreground">
          {routing.isError ? "MAP UNAVAILABLE" : routing.isLoading ? "…" : "per-upstream"}
        </Badge>
      </div>

      <p className="text-xs text-muted-foreground">
        direct = sandbox egress IP · proxy = owner&apos;s paid Webshare pool (30 direct proxies) —
        used to bypass region/WAF blocks (e.g. Groq 403 WAF from this sandbox).
      </p>

      {routing.isLoading && (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-14 w-full rounded-md" />
          <Skeleton className="h-14 w-5/6 rounded-md" />
        </div>
      )}

      {routing.isError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3" role="alert">
          <p className="text-xs text-destructive">
            Routing map unavailable — is the panel session still valid?{" "}
            <button
              type="button"
              className="min-h-11 underline underline-offset-2"
              onClick={() => routing.refetch()}
            >
              Retry
            </button>
          </p>
        </div>
      )}

      {routing.data && (
        <div className="space-y-2">
          {rows.map((key) => {
            const label = EGRESS_LABELS[key] ?? key;
            // routeFor semantics: explicit entry → default → direct.
            const mode: EgressMode =
              routing.data?.routing[key] ?? routing.data?.routing["default"] ?? "direct";
            const result = probeResults[key];
            const probing = runProbe.isPending && runProbe.variables === key;
            const notes: string[] = [];
            if (result) {
              if (result.keyNote) notes.push(`key: ${result.keyNote}`);
              else if (result.keyState && result.keyState !== "keyless") notes.push(`probed with the ${result.keyState} key`);
              if (result.proxied.error?.message) notes.push(result.proxied.error.message);
              else {
                if (result.direct.country) notes.push(`direct egress: ${result.direct.country}`);
                if (result.proxied.country) notes.push(`proxy egress: ${result.proxied.country}`);
              }
            }
            return (
              <div key={key} className="space-y-1.5 rounded-md border border-border/60 p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 max-w-full truncate font-mono text-xs" title={label}>
                    {label}
                  </span>
                  <div className="ml-auto flex shrink-0 items-center gap-1.5">
                    <div
                      role="group"
                      aria-label={`${label} egress mode`}
                      className="flex overflow-hidden rounded-md border border-border/60"
                    >
                      {(["direct", "proxy"] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          aria-pressed={mode === m}
                          aria-label={`${label}: route ${m}`}
                          disabled={busy}
                          onClick={() => setMode.mutate({ upstream: key, mode: m })}
                          className={`min-h-11 px-3 font-mono text-[11px] transition-colors disabled:opacity-50 ${
                            mode === m
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:bg-accent/10 hover:text-foreground"
                          }`}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 px-3 font-mono text-xs"
                      aria-label={`Probe ${label} egress, direct and proxied`}
                      disabled={busy}
                      onClick={() => runProbe.mutate(key)}
                    >
                      {probing ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Radar className="size-4" aria-hidden="true" />
                      )}
                      Probe
                    </Button>
                  </div>
                </div>

                {result && (
                  <div className="flex flex-wrap items-center gap-1.5" aria-live="polite">
                    <Badge
                      variant="outline"
                      className={`border-border/60 font-mono text-[10px] ${egressBadgeCls(result.direct)}`}
                    >
                      direct {result.direct.status ?? "—"} · {result.direct.classification}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={`border-border/60 font-mono text-[10px] ${egressBadgeCls(result.proxied)}`}
                    >
                      proxy {result.proxied.status ?? "—"} ·{" "}
                      {result.proxied.error?.code ?? result.proxied.classification}
                    </Badge>
                    {result.egressChanged && (
                      <Badge variant="outline" className="border-accent/60 font-mono text-[10px] text-accent">
                        egress changed
                      </Badge>
                    )}
                    {notes.length > 0 && (
                      <span className="min-w-0 flex-1 break-words text-[11px] text-muted-foreground">
                        {notes.join(" · ")}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
