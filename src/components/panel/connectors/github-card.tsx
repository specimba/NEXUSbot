"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
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
import {
  Copy,
  Eye,
  EyeOff,
  Fingerprint,
  Github,
  KeyRound,
  Loader2,
  Save,
  ShieldAlert,
  Unplug,
} from "lucide-react";

type GitHubStatus = {
  ok: boolean;
  appConfigured: boolean;
  credentialSource: "vault" | "env" | "none";
  webFlowConfigured: boolean;
  deviceFlowConfigured: boolean;
  connected: boolean;
  login: string | null;
  probe: { ok: boolean; httpStatus: number } | null;
  scopes: string[];
  callbackUrl: string;
  tokenMirror: string;
  patPolicy: string;
};

type DeviceFlowStartResp = {
  ok: boolean;
  flow?: { flowId: string; userCode: string; verificationUri: string; interval: number; expiresIn: number };
  error?: { code: string; message: string };
};

type DevicePollResp = {
  ok: boolean;
  status?: "connected" | "pending" | "slow_down" | "expired" | "denied" | "error";
  error?: { code: string; message: string };
};

/** Honest human text for the callback ?reason= codes (short codes, no secrets). */
const CALLBACK_REASONS: Record<string, string> = {
  code_reused_or_invalid:
    "The GitHub authorization code is single-use and was already consumed (or expired). Press Connect again.",
  app_credentials_rejected:
    "GitHub rejected the Client ID / Client Secret — correct them in the GitHub card, then connect again.",
  redirect_uri_mismatch:
    "The OAuth App callback URL does not match the panel callback URL shown on the card.",
  not_configured: "GitHub App credentials are missing on the server.",
};

/**
 * T-202 — GitHub connector card (12-b vault upgrade).
 * A8: the OAuth CONNECT click is always the first path; device flow is the
 * documented fallback; any PAT entry attempt is refused with a visible reason
 * and the value is never transmitted anywhere. App credentials (Client ID +
 * Client Secret) are entered HERE and stored encrypted in the vault — the old
 * ".env setup instructions" block is gone.
 */
export function GitHubCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const status = useQuery<GitHubStatus>({
    queryKey: ["connectors", "github"],
    queryFn: async () => {
      const res = await fetch("/api/github/status", { cache: "no-store" });
      if (!res.ok) throw new Error("status unavailable");
      return res.json();
    },
  });

  // OAuth callback lands back on "/" with ?github=<flag> — surface it once.
  const flagHandled = useRef(false);
  useEffect(() => {
    if (flagHandled.current) return;
    flagHandled.current = true;
    const params = new URLSearchParams(window.location.search);
    const flag = params.get("github");
    if (!flag) return;
    const reason = params.get("reason");
    window.history.replaceState(null, "", window.location.pathname);
    if (flag === "connected") {
      toast({ title: "GitHub connected", description: "Access token stored in the encrypted vault." });
    } else if (flag === "denied") {
      toast({ title: "GitHub authorization denied", description: reason ?? "You declined on github.com.", variant: "destructive" });
    } else if (flag === "state_error") {
      toast({ title: "OAuth state check failed", description: "Link expired (>10 min) or replayed — press Connect again.", variant: "destructive" });
    } else {
      toast({
        title: "GitHub connection failed",
        description: (reason && CALLBACK_REASONS[reason]) || reason || "Token exchange failed.",
        variant: "destructive",
      });
    }
    void queryClient.invalidateQueries({ queryKey: ["connectors", "github"], exact: true });
  }, [toast, queryClient]);

  // ---- App credentials form (vault-backed, 12-b) ----
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);

  const saveApp = useMutation({
    mutationFn: async (vars: { clientId: string; clientSecret: string }) => {
      const res = await fetch("/api/github/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: { code: string; message: string } }
        | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error?.message ?? "Save failed.");
      }
      return data;
    },
    onSuccess: () => {
      setClientId("");
      setClientSecret("");
      setShowSecret(false);
      void queryClient.invalidateQueries({ queryKey: ["connectors", "github"], exact: true });
      toast({
        title: "GitHub App credentials saved",
        description: "Client ID + Secret are encrypted in the vault — never in .env, never echoed.",
      });
    },
    onError: (e: Error) =>
      toast({ title: "Could not save App credentials", description: e.message, variant: "destructive" }),
  });

  const removeApp = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/github/app", { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: { code: string; message: string } }
        | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error?.message ?? "Removal failed.");
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connectors", "github"], exact: true });
      toast({ title: "GitHub App credentials removed", description: "Both vault rows deleted (idempotent)." });
    },
    onError: (e: Error) =>
      toast({ title: "Removal failed", description: e.message, variant: "destructive" }),
  });

  const [deviceOpen, setDeviceOpen] = useState(false);
  const [flow, setFlow] = useState<NonNullable<DeviceFlowStartResp["flow"]> | null>(null);
  const [patValue, setPatValue] = useState("");
  const [patRefused, setPatRefused] = useState(false);
  // Round-9 fix: once a terminal poll status is observed, later 404s caused by
  // invalidation races are suppressed client-side (the server also replays
  // terminal flows via tombstones instead of answering 404).
  const terminalSeenRef = useRef(false);

  const startDevice = useMutation({
    mutationFn: async (): Promise<DeviceFlowStartResp> => {
      const res = await fetch("/api/github/device-flow", { method: "POST" });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.ok && data.flow) {
        terminalSeenRef.current = false;
        setFlow(data.flow);
      } else {
        toast({
          title: data.error?.code === "APP_CREDENTIALS_REJECTED" ? "App credentials rejected" : "Device flow unavailable",
          description: data.error?.message ?? "Not configured.",
          variant: "destructive",
        });
      }
    },
    onError: (e: Error) =>
      toast({ title: "Device flow failed", description: e.message, variant: "destructive" }),
  });

  const pollInterval = (flow?.interval ?? 5) * 1000;
  const poll = useQuery<DevicePollResp>({
    queryKey: ["connectors", "github", "device-flow", flow?.flowId ?? "none"],
    enabled: deviceOpen && flow !== null,
    queryFn: async () => {
      const res = await fetch(`/api/github/device-flow?flow=${flow?.flowId ?? ""}`, { cache: "no-store" });
      const data = (await res.json()) as DevicePollResp;
      // Terminal states are handled at the fetch boundary (not in an effect)
      // so polling stops cleanly and the dialog closes on success.
      if (data.status === "connected") {
        terminalSeenRef.current = true;
        void queryClient.invalidateQueries({ queryKey: ["connectors", "github"], exact: true });
        toast({ title: "GitHub connected", description: "Access token stored in the encrypted vault." });
        setDeviceOpen(false);
        setFlow(null);
      } else if (data.status === "expired") {
        terminalSeenRef.current = true;
        toast({ title: "Device code expired", description: "Start the device flow again.", variant: "destructive" });
        setFlow(null);
      } else if (data.status === "denied") {
        terminalSeenRef.current = true;
        toast({ title: "Device authorization denied", variant: "destructive" });
        setFlow(null);
      } else if (data.status === "error") {
        // Honest terminal failure (e.g. GitHub rejected the stored Client ID) —
        // surface it and STOP polling instead of spinning forever.
        terminalSeenRef.current = true;
        toast({
          title: "Device flow failed",
          description: data.error?.message ?? "GitHub rejected the request.",
          variant: "destructive",
        });
        setFlow(null);
      }
      return data;
    },
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === "connected" || s === "expired" || s === "denied" || s === "error" ? false : pollInterval;
    },
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/github/disconnect", { method: "POST" });
      if (!res.ok) throw new Error("disconnect failed");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connectors", "github"], exact: true });
      toast({ title: "GitHub disconnected", description: "Vault credential deleted." });
    },
    onError: (e: Error) =>
      toast({ title: "Disconnect failed", description: e.message, variant: "destructive" }),
  });

  /** A8: PAT input is refused locally — the value is NEVER sent anywhere. */
  const refusePat = (e: React.FormEvent) => {
    e.preventDefault();
    setPatValue("");
    setPatRefused(true);
    toast({
      title: "PAT refused by A8 — use OAuth",
      description: "Personal access tokens are permanently refused. Input discarded, nothing was sent.",
      variant: "destructive",
    });
  };

  const copyCallback = async () => {
    if (!s?.callbackUrl) return;
    await navigator.clipboard.writeText(s.callbackUrl);
    toast({ title: "Callback URL copied" });
  };

  const s = status.data;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 font-mono">
            <Github className="size-5 text-primary" aria-hidden="true" />
            GitHub
            <span className="text-xs font-normal text-muted-foreground">T-202 · OAuth 2.0</span>
          </CardTitle>
          {status.isLoading ? (
            <Skeleton className="h-6 w-24" />
          ) : s?.connected ? (
            s.probe && !s.probe.ok ? (
              <Badge variant="outline" className="border-destructive/50 text-destructive">
                PROBE FAILED ({s.probe.httpStatus || "network"})
              </Badge>
            ) : (
              <Badge className="bg-primary/15 font-mono text-primary text-glow">CONNECTED</Badge>
            )
          ) : s?.appConfigured ? (
            <Badge variant="outline" className="font-mono text-accent">
              READY
            </Badge>
          ) : (
            <Badge variant="outline" className="font-mono text-accent">
              NOT CONFIGURED
            </Badge>
          )}
        </div>
        <CardDescription>
          Vault-backed OAuth App · web-flow first · device flow fallback · PAT permanently refused (directive A8).
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {status.isLoading ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-10 rounded-md" />
            <Skeleton className="h-10 rounded-md" />
          </div>
        ) : status.isError ? (
          <p className="text-sm text-destructive" role="alert">
            GitHub connector status unavailable — retrying automatically.
          </p>
        ) : !s!.appConfigured ? (
          /* -------- NOT CONFIGURED: vault App credentials form (12-b) -------- */
          <div className="space-y-4 rounded-md border border-border/60 p-4">
            <p className="flex items-start gap-2 text-sm font-medium">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
              <span>
                Register an OAuth App at{" "}
                <a
                  className="text-primary underline underline-offset-2"
                  href="https://github.com/settings/developers"
                  target="_blank"
                  rel="noreferrer"
                >
                  github.com/settings/developers
                </a>
                . Callback URL:
              </span>
            </p>
            <div className="flex items-start gap-2">
              <code
                className="min-w-0 flex-1 break-all rounded bg-background/60 px-1.5 py-0.5 font-mono text-xs text-foreground"
                aria-label="Panel OAuth callback URL"
              >
                {s.callbackUrl}
              </code>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-11 shrink-0"
                aria-label="Copy callback URL to clipboard"
                onClick={copyCallback}
              >
                <Copy className="size-4" aria-hidden="true" />
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              The Client Secret lives encrypted in the vault — never in <code className="font-mono">.env</code>, never
              echoed.
            </p>

            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (clientId.trim().length >= 8 && clientSecret.trim().length >= 16) {
                  saveApp.mutate({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
                }
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="github-app-client-id">Client ID</Label>
                <Input
                  id="github-app-client-id"
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  spellCheck={false}
                  className="min-h-11 font-mono"
                  placeholder="Iv1.… or 20-char hex"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  required
                  minLength={8}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="github-app-client-secret">Client Secret</Label>
                <div className="flex gap-2">
                  <Input
                    id="github-app-client-secret"
                    type={showSecret ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    className="min-h-11 font-mono"
                    placeholder="paste secret — encrypted on arrival"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    required
                    minLength={16}
                    aria-describedby="github-app-secret-note"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-11 shrink-0"
                    aria-label={showSecret ? "Hide client secret" : "Show client secret"}
                    aria-pressed={showSecret}
                    onClick={() => setShowSecret((v) => !v)}
                  >
                    {showSecret ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
                  </Button>
                </div>
                <p id="github-app-secret-note" className="text-xs text-muted-foreground">
                  Stored AES-256-GCM (service github, labels app-client-id / app-client-secret). Shown once here, never
                  displayed again.
                </p>
              </div>
              <Button
                type="submit"
                className="min-h-11 font-mono"
                disabled={saveApp.isPending || clientId.trim().length < 8 || clientSecret.trim().length < 16}
              >
                {saveApp.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Save className="size-4" aria-hidden="true" />
                )}
                {saveApp.isPending ? "Saving…" : "Save credentials"}
              </Button>
            </form>

            <PatRefusalForm patValue={patValue} setPatValue={setPatValue} patRefused={patRefused} onSubmit={refusePat} />
          </div>
        ) : !s!.connected ? (
          /* -------- CONFIGURED, NOT CONNECTED: OAuth click first -------- */
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                className="min-h-11 font-mono"
                onClick={() => window.location.assign("/api/github/authorize")}
                aria-label="Connect GitHub via OAuth"
              >
                <Github className="size-4" aria-hidden="true" />
                Connect with GitHub
              </Button>

              <Dialog
                open={deviceOpen}
                onOpenChange={(open) => {
                  setDeviceOpen(open);
                  if (!open) setFlow(null);
                }}
              >
                <DialogTrigger asChild>
                  <Button variant="outline" className="min-h-11 font-mono">
                    <Fingerprint className="size-4" aria-hidden="true" />
                    Device flow (fallback)
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle className="font-mono">Device flow — documented fallback</DialogTitle>
                    <DialogDescription>
                      For headless setups. Enter the code below at the GitHub activation page.
                    </DialogDescription>
                  </DialogHeader>
                  {!flow ? (
                    <div className="space-y-2">
                      <Button
                        className="min-h-11 w-full font-mono"
                        onClick={() => startDevice.mutate()}
                        disabled={startDevice.isPending}
                      >
                        {startDevice.isPending ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <Fingerprint className="size-4" aria-hidden="true" />
                        )}
                        Start device flow
                      </Button>
                      {startDevice.isError && (
                        <p className="text-center text-xs text-destructive" role="alert">
                          Could not start — check server config, then retry.
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <code
                          className="flex-1 rounded-md border border-primary/40 bg-primary/10 p-3 text-center font-mono text-xl tracking-[0.3em] text-primary"
                          aria-label="GitHub device code"
                        >
                          {flow.userCode}
                        </code>
                        <Button
                          variant="outline"
                          size="icon"
                          className="size-11 shrink-0"
                          aria-label="Copy device code to clipboard"
                          onClick={async () => {
                            await navigator.clipboard.writeText(flow.userCode);
                            toast({ title: "Device code copied" });
                          }}
                        >
                          <Copy className="size-4" aria-hidden="true" />
                        </Button>
                      </div>
                      <Button asChild variant="outline" className="min-h-11 w-full font-mono">
                        <a href={flow.verificationUri} target="_blank" rel="noreferrer">
                          Open {flow.verificationUri.replace(/^https?:\/\//, "")}
                        </a>
                      </Button>
                      <p className="text-center font-mono text-xs text-muted-foreground" role="status" aria-live="polite">
                        {poll.isFetching ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Loader2 className="size-3 animate-spin" aria-hidden="true" /> asking GitHub…
                          </span>
                        ) : poll.data?.status === "slow_down" ? (
                          "slowing down per GitHub request…"
                        ) : (
                          `waiting for authorization (every ${flow.interval}s)…`
                        )}
                      </p>
                    </div>
                  )}
                </DialogContent>
              </Dialog>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    className="min-h-11 font-mono text-destructive hover:text-destructive"
                    aria-label="Remove stored GitHub App credentials"
                  >
                    <Unplug className="size-4" aria-hidden="true" />
                    Remove credentials
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Remove the GitHub App credentials?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Deletes the Client ID + Client Secret vault rows. The card returns to the credential-entry form
                      until you paste them again.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="min-h-11 bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() => removeApp.mutate()}
                    >
                      Remove
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>

            <p className="font-mono text-xs text-muted-foreground">
              App credentials:{" "}
              <span className="text-foreground">
                {s.credentialSource === "vault" ? "vault (encrypted)" : s.credentialSource}
              </span>{" "}
              · scope: <span className="text-foreground">{s.scopes.join(" ")}</span> · token → encrypted vault +{" "}
              <span className="text-foreground">{s.tokenMirror}</span>
            </p>

            <PatRefusalForm patValue={patValue} setPatValue={setPatValue} patRefused={patRefused} onSubmit={refusePat} />
          </div>
        ) : (
          /* -------- CONNECTED: identity + disconnect -------- */
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 p-4">
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-mono text-sm">
                  <KeyRound className="size-4 text-primary" aria-hidden="true" />
                  {s.login ?? "unknown login"}
                </p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {s.probe
                    ? `MEASURED · GET api.github.com/user → ${s.probe.httpStatus}${s.probe.ok ? "" : " (token stale?)"}`
                    : "probe pending"}
                </p>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    className="min-h-11 font-mono text-destructive hover:text-destructive"
                    aria-label="Disconnect GitHub"
                  >
                    <Unplug className="size-4" aria-hidden="true" />
                    Disconnect
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Disconnect GitHub?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Deletes the OAuth token from the encrypted vault. The ops/vault/github.token mirror used by the
                      backup script stays in place. GitHub-side authorization stays active until revoked — remove it
                      under github.com/settings/applications.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="min-h-11 bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() => disconnect.mutate()}
                    >
                      Disconnect
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            <p className="font-mono text-xs text-muted-foreground">
              vault credential: service <span className="text-foreground">github</span> · label{" "}
              <span className="text-foreground">user-token</span> · value never displayed
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** A8 enforcement surface: a PAT affordance that always refuses, never sends. */
function PatRefusalForm(props: {
  patValue: string;
  setPatValue: (v: string) => void;
  patRefused: boolean;
  onSubmit: (e: React.FormEvent) => void;
}) {
  return (
    <form className="space-y-2" onSubmit={props.onSubmit} aria-label="Paste a PAT instead (refused)">
      <Label htmlFor="github-pat-input" className="text-xs text-muted-foreground">
        Prefer a PAT instead? (permanently refused)
      </Label>
      <div className="flex gap-2">
        <Input
          id="github-pat-input"
          type="password"
          inputMode="text"
          autoComplete="off"
          className="min-h-11 font-mono"
          placeholder="ghp_… (discarded locally)"
          value={props.patValue}
          onChange={(e) => props.setPatValue(e.target.value)}
          aria-describedby="github-pat-note"
        />
        <Button type="submit" variant="outline" className="min-h-11 shrink-0 font-mono">
          Use PAT
        </Button>
      </div>
      {props.patRefused ? (
        <Alert variant="destructive" id="github-pat-note" role="alert">
          <ShieldAlert className="size-4" aria-hidden="true" />
          <AlertTitle>PAT refused by A8 — use OAuth</AlertTitle>
          <AlertDescription>
            The input was discarded on your machine. Nothing was transmitted, stored, or logged.
          </AlertDescription>
        </Alert>
      ) : (
        <p id="github-pat-note" className="text-xs text-muted-foreground">
          Directive A8: the value never leaves this form — OAuth only.
        </p>
      )}
    </form>
  );
}
