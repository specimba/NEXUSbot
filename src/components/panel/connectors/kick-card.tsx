"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Check,
  Copy,
  Link2Off,
  PlugZap,
  Radio,
  Send,
  Trash2,
  Webhook,
} from "lucide-react";

/**
 * Task 30 — the OFFICIAL Kick connection card.
 *
 * The panel already READS live Kick chat anonymously (the :3010 bridge feeds
 * the widgets). This card is the missing WRITE half: the Kick app OAuth 2.1
 * connection so VYCE posts replies INTO the chat and receives signed
 * webhooks. State machine, honest by design:
 *
 *   NOT CONFIGURED → save the Create-an-App credentials (vault-encrypted)
 *   APP READY      → "Connect with Kick" (id.kick.com, PKCE S256)
 *   CONNECTED      → account, webhook feed control, bot-reply toggle,
 *                    test message, disconnect/delete
 *
 * The redirect URL shown here is the EXACT string to paste into the Kick
 * Create-an-App form (server-computed from the panel's public origin).
 */

type KickStatus = {
  ok: true;
  status: {
    configured: boolean;
    app: { clientIdMasked: string; clientSecretMasked: string } | null;
    connected: boolean;
    account: { userId: number; name: string } | null;
    scope: string | null;
    expiresAt: number | null;
    redirectUri: string;
    webhookUrl: string;
    scopes: string[];
    scopeHints: Record<string, string>;
    webhooks: { subs: Array<{ id: string; event: string; version: number }> | null; error: string | null };
    chatReplies: boolean;
  };
};

function CopyRow({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 min-w-0 rounded-md border border-border bg-muted/40 px-3 py-2">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="truncate font-mono text-xs text-foreground">{value}</p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-11 w-11 shrink-0"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard
            .writeText(value)
            .then(() => toast.success("Copied", { description: label }))
            .catch(() => toast.error("Copy failed", { description: "Clipboard unavailable." }));
        }}
      >
        <Copy className="h-4 w-4" />
      </Button>
    </div>
  );
}

export function KickCard() {
  const queryClient = useQueryClient();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [secretVisible, setSecretVisible] = useState(false);
  const toastForUrl = useRef(false);

  const status = useQuery<KickStatus>({
    queryKey: ["connector-kick-status"],
    queryFn: async () => {
      const res = await fetch("/api/kick/status", { cache: "no-store" });
      if (!res.ok) throw new Error("status unavailable");
      return res.json() as Promise<KickStatus>;
    },
    refetchInterval: 30_000,
  });

  // OAuth return flags (?kick=connected|error) — toast once, clean the URL.
  useEffect(() => {
    if (toastForUrl.current) return;
    const params = new URLSearchParams(window.location.search);
    const flag = params.get("kick");
    if (!flag) return;
    toastForUrl.current = true;
    params.delete("kick");
    params.delete("reason");
    const clean = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${clean ? `?${clean}` : ""}`);
    if (flag === "connected") {
      toast.success("Kick connected", { description: "Account stored in the panel vault — tokens rotate automatically." });
      void queryClient.invalidateQueries({ queryKey: ["connector-kick-status"] });
    } else {
      toast.error("Kick connection failed", {
        description: "Check the app credentials and that the redirect URL matches the Kick form exactly.",
      });
    }
  }, [queryClient]);

  const saveApp = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/kick/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(errBody?.error?.message ?? `Save failed (HTTP ${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      setClientId("");
      setClientSecret("");
      setSecretVisible(false);
      void queryClient.invalidateQueries({ queryKey: ["connector-kick-status"] });
      toast.success("App credentials stored", { description: "Client secret encrypted with AES-256-GCM." });
    },
    onError: (e: Error) => toast.error("Save failed", { description: e.message }),
  });

  const connect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/kick/state", { method: "POST" });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(errBody?.error?.message ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as { authorizeUrl: string };
    },
    onSuccess: (data) => {
      toast.info("Redirecting to Kick", { description: "Approve on the consent screen — you return to the panel automatically." });
      window.location.href = data.authorizeUrl;
    },
    onError: (e: Error) => toast.error("Could not start connection", { description: e.message }),
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/kick/oauth", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connector-kick-status"] });
      toast.success("Account disconnected", { description: "App credentials stay — reconnect with one click." });
    },
    onError: (e: Error) => toast.error("Disconnect failed", { description: e.message }),
  });

  const deleteApp = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/kick/app", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connector-kick-status"] });
      toast.success("Kick vault cleared", { description: "App + token records deleted." });
    },
    onError: (e: Error) => toast.error("Delete failed", { description: e.message }),
  });

  const hookSetup = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/kick/webhook-setup", { method: "POST" });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(errBody?.error?.message ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as { url: string; subs: Array<{ event: string }> };
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["connector-kick-status"] });
      toast.success("Webhook registered", { description: `chat.message.sent → ${data.url}` });
    },
    onError: (e: Error) => toast.error("Webhook setup failed", { description: e.message }),
  });

  const hookTeardown = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/kick/webhook-setup", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connector-kick-status"] });
      toast.success("Webhook removed");
    },
    onError: (e: Error) => toast.error("Removal failed", { description: e.message }),
  });

  const toggleReplies = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await fetch("/api/kick/replies", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["connector-kick-status"] }),
    onError: (e: Error) => toast.error("Toggle failed", { description: e.message }),
  });

  const testChat = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/kick/test-chat", { method: "POST" });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
        throw new Error(errBody?.error?.message ?? errBody?.error?.code ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      const identity = (data as { identity?: string } | null)?.identity;
      toast.success("Test message sent to Kick chat", {
        description:
          identity === "user"
            ? "Posted from YOUR account — the bot identity was rejected by Kick."
            : identity
              ? "Posted as the BOT account (not your streamer identity)."
              : "check the channel",
      });
    },
    onError: (e: Error) => toast.error("Test send failed", { description: e.message }),
  });

  const s = status.data?.status;

  return (
    <>
      <Toaster richColors position="bottom-right" />
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Radio className="h-4 w-4 text-primary" aria-hidden />
              Kick Connection
            </CardTitle>
            {status.isPending ? (
              <Skeleton className="h-6 w-24" />
            ) : status.isError ? (
              <Badge variant="outline" className="border-destructive/50 text-destructive">
                STATUS ERROR
              </Badge>
            ) : s?.connected ? (
              <Badge variant="outline" className="border-primary/40 text-primary">CONNECTED</Badge>
            ) : s?.configured ? (
              <Badge variant="outline" className="border-accent/60 text-accent">APP READY</Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground border-border">NOT CONFIGURED</Badge>
            )}
          </div>
          <CardDescription>
            Official Kick app (OAuth 2.1 + PKCE) — chat reading is already live (anonymous bridge, port 3010). This
            connection opens the WRITE side: VYCE posts replies into the live chat as a bot and receives the !ai flow
            on the signed webhook lane.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {status.isPending && (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-2/3" />
            </div>
          )}

          {!status.isPending && s && (
            <>
              {/* Step 0 — the exact URLs for the Kick Create-an-App form */}
              <div className="space-y-2">
                <CopyRow label="Kick Create-an-App → Redirect URL (paste exactly)" value={s.redirectUri} />
                <CopyRow label="Kick Create-an-App → Webhooks URL (https required)" value={s.webhookUrl} />
              </div>

              {!s.configured && (
                <div className="space-y-3">
                  <div className="rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
                    kick.com → <span className="text-foreground">Settings → Developer → Create an App</span>: paste the
                    two values above into Redirect URL and Webhooks URL exactly (the old
                    <span className="font-mono text-foreground"> http://ws-ef-…fcapp.run</span> line is what triggers
                    the HTTPS error — Kick only accepts https), tick these boxes —{" "}
                    {s.scopes.map((sc) => s.scopeHints[sc]).filter(Boolean).join(", ")} — then enter the Client ID/Secret
                    here.
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="kick-client-id">Client ID</Label>
                    <Input
                      id="kick-client-id"
                      className="h-11 font-mono"
                      placeholder="Kick app client id"
                      autoComplete="off"
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="kick-client-secret">Client Secret</Label>
                    <Input
                      id="kick-client-secret"
                      className="h-11 font-mono"
                      type={secretVisible ? "text" : "password"}
                      placeholder="Kick app client secret"
                      autoComplete="off"
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                    />
                  </div>
                  <Button
                    className="h-11 w-full sm:w-auto"
                    disabled={saveApp.isPending || !clientId.trim() || !clientSecret.trim()}
                    onClick={() => saveApp.mutate()}
                  >
                    <PlugZap className="mr-2 h-4 w-4" aria-hidden />
                    {saveApp.isPending ? "Saving to vault…" : "Save app credentials"}
                  </Button>
                </div>
              )}

              {s.configured && !s.connected && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">{s.app?.clientIdMasked}</span>
                    <span>·</span>
                    <span>secret in the vault ({s.app?.clientSecretMasked})</span>
                  </div>
                  <Button className="h-11 w-full sm:w-auto" disabled={connect.isPending} onClick={() => connect.mutate()}>
                    <PlugZap className="mr-2 h-4 w-4" aria-hidden />
                    {connect.isPending ? "Redirecting…" : "Connect with Kick"}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    The consent screen returns via {new URL(s.redirectUri).host} — the Redirect URL in the Kick form
                    must match this panel's address exactly.
                  </p>
                  <Button
                    variant="outline"
                    className="h-11"
                    disabled={deleteApp.isPending}
                    onClick={() => deleteApp.mutate()}
                  >
                    <Trash2 className="mr-2 h-4 w-4" aria-hidden />
                    Delete app record
                  </Button>
                </div>
              )}

              {s.connected && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Check className="h-4 w-4 text-primary" aria-hidden />
                    <span className="font-medium">{s.account?.name ?? "connected account"}</span>
                    <span className="text-xs text-muted-foreground">
                      {s.account ? `@${s.account.userId}` : ""} · tokens rotate automatically (rotating refresh)
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(s.scope ?? "").split(/\s+/).filter(Boolean).map((sc) => (
                      <Badge key={sc} variant="outline" className="font-mono text-[10px] border-border">
                        {sc}
                      </Badge>
                    ))}
                  </div>

                  <div className="rounded-md border border-border p-3 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium flex items-center gap-2">
                          <Webhook className="h-4 w-4" aria-hidden /> Official webhook feed
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {s.webhooks.subs && s.webhooks.subs.length > 0
                            ? `${s.webhooks.subs.length} subscription live (chat.message.sent)`
                            : s.webhooks.error
                              ? `subscription list unavailable: ${s.webhooks.error}`
                              : "no subscriptions yet — set it up so the !ai flow arrives on the signed lane"}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        {s.webhooks.subs && s.webhooks.subs.length > 0 ? (
                          <Button
                            variant="outline"
                            className="h-11"
                            disabled={hookTeardown.isPending}
                            onClick={() => hookTeardown.mutate()}
                          >
                            Remove
                          </Button>
                        ) : (
                          <Button
                            className="h-11"
                            disabled={hookSetup.isPending}
                            onClick={() => hookSetup.mutate()}
                          >
                            {hookSetup.isPending ? "Registering…" : "Set up webhook"}
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">Bot replies in chat</p>
                        <p className="text-xs text-muted-foreground">
                          replies to !ai messages arriving on the webhook are posted into the live chat
                        </p>
                      </div>
                      <Switch
                        checked={s.chatReplies}
                        onCheckedChange={(v) => toggleReplies.mutate(v)}
                        aria-label="Bot replies in chat"
                        className={cn(s.chatReplies && "data-[state=checked]:bg-primary")}
                      />
                    </div>

                    <Button
                      variant="outline"
                      className="h-11 w-full sm:w-auto"
                      disabled={testChat.isPending}
                      onClick={() => testChat.mutate()}
                    >
                      <Send className="mr-2 h-4 w-4" aria-hidden />
                      {testChat.isPending ? "Sending…" : "Send test message"}
                    </Button>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      className="h-11"
                      disabled={disconnect.isPending}
                      onClick={() => disconnect.mutate()}
                    >
                      <Link2Off className="mr-2 h-4 w-4" aria-hidden />
                      Disconnect account
                    </Button>
                    <Button
                      variant="outline"
                      className="h-11 text-destructive hover:text-destructive"
                      disabled={deleteApp.isPending}
                      onClick={() => deleteApp.mutate()}
                    >
                      <Trash2 className="mr-2 h-4 w-4" aria-hidden />
                      Delete everything
                    </Button>
                  </div>
                </div>
              )}

              {!s.connected && (
                <p className="flex items-start gap-2 text-xs text-muted-foreground">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  The client secret lives only in the vault (AES-256-GCM) and is never shown in the panel again. Token
                  renewal is automatic; refresh tokens are single-use, so every renewal immediately writes the fresh
                  pair to the vault.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
