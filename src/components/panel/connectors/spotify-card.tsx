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
import { Toaster } from "@/components/ui/sonner";
import { Music4, PlugZap, Link2Off, Trash2, Copy, AlertTriangle, Check } from "lucide-react";

/**
 * v37 — Spotify connector card (Phase G1, plan §10).
 *
 * The grounding source for "şu an ne çalıyor": read-only, PKCE public client
 * (NO client secret — least privilege), the streamer's own account. State
 * machine, honest by design (the deterministic lane renders the same enum):
 *
 *   NOT CONFIGURED → dashboard steps + Client ID save (vault-encrypted)
 *   APP READY      → "Connect with Spotify" (accounts.spotify.com, PKCE S256)
 *   CONNECTED      → account, scopes, live now-playing row, disconnect
 *   NEEDS REAUTH   → expired grant — one-click reconnect
 *
 * The redirect URL shown here is the EXACT string to register in the Spotify
 * dashboard (server-computed from the panel's public origin — multiple URIs
 * are allowed, so dev + prod origins can coexist).
 */

type SpotifyStatus = {
  ok: true;
  status: {
    configured: boolean;
    app: { clientIdMasked: string } | null;
    connected: boolean;
    account: { id: string; name: string } | null;
    scope: string | null;
    expiresAt: number | null;
    redirectUri: string;
    needsReauth: boolean;
    snapshot: {
      state: "NOT_CONFIGURED" | "NEEDS_REAUTH" | "IDLE" | "PAUSED" | "PLAYING" | "DEGRADED";
      isPlaying: boolean;
      track: { name: string; artists: string; album: string; year: string; url: string | null; isLocal: boolean; kind: "track" | "episode" } | null;
      device: string | null;
      fetchedAt: number;
    } | null;
    historyCount: number;
    scopes: string[];
    scopeHints: Record<string, string>;
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

const STATE_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "muted" }> = {
  PLAYING: { text: "PLAYING", tone: "ok" },
  PAUSED: { text: "PAUSED", tone: "warn" },
  IDLE: { text: "IDLE", tone: "muted" },
  NOT_CONFIGURED: { text: "NOT CONFIGURED", tone: "muted" },
  NEEDS_REAUTH: { text: "NEEDS REAUTH", tone: "warn" },
  DEGRADED: { text: "DEGRADED", tone: "warn" },
};

export function SpotifyCard() {
  const queryClient = useQueryClient();
  const [clientId, setClientId] = useState("");
  const toastForUrl = useRef(false);

  const status = useQuery<SpotifyStatus>({
    queryKey: ["connector-spotify-status"],
    queryFn: async () => {
      const res = await fetch("/api/connectors/spotify/status", { cache: "no-store" });
      if (!res.ok) throw new Error("status unavailable");
      return res.json() as Promise<SpotifyStatus>;
    },
    refetchInterval: 30_000,
  });

  // OAuth return flags (?spotify=connected|error) — toast once, clean the URL.
  useEffect(() => {
    if (toastForUrl.current) return;
    const params = new URLSearchParams(window.location.search);
    const flag = params.get("spotify");
    if (!flag) return;
    toastForUrl.current = true;
    params.delete("spotify");
    params.delete("reason");
    const clean = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${clean ? `?${clean}` : ""}`);
    if (flag === "connected") {
      toast.success("Spotify connected", { description: "Now-playing grounding is live — the plak lane sees the stream." });
      void queryClient.invalidateQueries({ queryKey: ["connector-spotify-status"] });
    } else {
      toast.error("Spotify connection failed", {
        description: "Check the Client ID and that the Redirect URI in the Spotify dashboard matches exactly.",
      });
    }
  }, [queryClient]);

  const saveApp = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/connectors/spotify/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: clientId.trim() }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(errBody?.error?.message ?? `Save failed (HTTP ${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      setClientId("");
      void queryClient.invalidateQueries({ queryKey: ["connector-spotify-status"] });
      toast.success("Client ID stored", { description: "PKCE public client — no secret needed, nothing else leaves the panel." });
    },
    onError: (e: Error) => toast.error("Save failed", { description: e.message }),
  });

  const connect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/connectors/spotify/authorize", { method: "POST" });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(errBody?.error?.message ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as { authorizeUrl: string };
    },
    onSuccess: (data) => {
      toast.info("Redirecting to Spotify", { description: "Approve the read-only scopes — you return here automatically." });
      window.location.href = data.authorizeUrl;
    },
    onError: (e: Error) => toast.error("Could not start connection", { description: e.message }),
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/connectors/spotify/disconnect", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connector-spotify-status"] });
      toast.success("Account disconnected", { description: "The plak lane falls back to its honest not-connected answers." });
    },
    onError: (e: Error) => toast.error("Disconnect failed", { description: e.message }),
  });

  const deleteApp = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/connectors/spotify/app", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connector-spotify-status"] });
      toast.success("Spotify vault cleared", { description: "App + token records deleted." });
    },
    onError: (e: Error) => toast.error("Delete failed", { description: e.message }),
  });

  const s = status.data?.status;
  const snapState = s?.needsReauth ? "NEEDS_REAUTH" : s?.snapshot?.state ?? null;
  const stateInfo = snapState ? STATE_LABEL[snapState] ?? { text: snapState, tone: "muted" as const } : null;

  return (
    <>
      <Toaster richColors position="bottom-right" />
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Music4 className="h-4 w-4 text-primary" aria-hidden />
              Spotify Grounding
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
            Now-playing grounding for the stream (read-only, PKCE — no client secret). While music plays on stream, VYCE
            sees the track title from the panel and the deterministic plak lane answers &quot;şu an ne çalıyor&quot; with
            real data — no model, no guessing.
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
              {/* Step 0 — the exact URI for the Spotify dashboard */}
              <CopyRow label="Spotify Dashboard → Edit Settings → Redirect URIs (paste exactly)" value={s.redirectUri} />

              {!s.configured && (
                <div className="space-y-3">
                  <div className="rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
                    <ol className="list-decimal space-y-1 pl-4">
                      <li>
                        developer.spotify.com/dashboard → <span className="text-foreground">Create app</span> (free, no
                        card) → name it, Web API.
                      </li>
                      <li>
                        <span className="text-foreground">Edit Settings → Redirect URIs</span>: paste the exact value
                        above (https only; multiple URIs are allowed).
                      </li>
                      <li>
                        <span className="text-foreground">User Management</span>: your Spotify account email —
                        development-mode apps only serve listed users (your own account is auto-allowed).
                      </li>
                      <li>Copy the app&apos;s Client ID here and save — the PKCE flow needs nothing else.</li>
                    </ol>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="spotify-client-id">Client ID</Label>
                    <Input
                      id="spotify-client-id"
                      className="h-11 font-mono"
                      placeholder="Spotify app client id"
                      autoComplete="off"
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                    />
                  </div>
                  <Button
                    className="h-11 w-full sm:w-auto"
                    disabled={saveApp.isPending || !clientId.trim()}
                    onClick={() => saveApp.mutate()}
                  >
                    <PlugZap className="mr-2 h-4 w-4" aria-hidden />
                    {saveApp.isPending ? "Saving to vault…" : "Save Client ID"}
                  </Button>
                </div>
              )}

              {s.configured && !s.connected && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">{s.app?.clientIdMasked}</span>
                    <span>·</span>
                    <span>PKCE public client — no secret stored</span>
                  </div>
                  <Button className="h-11 w-full sm:w-auto" disabled={connect.isPending} onClick={() => connect.mutate()}>
                    <PlugZap className="mr-2 h-4 w-4" aria-hidden />
                    {connect.isPending ? "Redirecting…" : "Connect with Spotify"}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Read-only scopes: {s.scopes.map((sc) => s.scopeHints[sc]).filter(Boolean).join(", ")}. The consent
                    screen returns via {new URL(s.redirectUri).host} — the Redirect URI must match exactly.
                  </p>
                  <Button variant="outline" className="h-11" disabled={deleteApp.isPending} onClick={() => deleteApp.mutate()}>
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
                    {stateInfo && (
                      <Badge
                        variant="outline"
                        className={
                          stateInfo.tone === "ok"
                            ? "border-primary/40 text-primary"
                            : stateInfo.tone === "warn"
                              ? "border-amber-500/50 text-amber-600 dark:text-amber-400"
                              : "text-muted-foreground border-border"
                        }
                      >
                        {stateInfo.text}
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {s.snapshot?.track
                        ? `${s.snapshot.track.artists || "—"} · ${s.snapshot.track.name}`
                        : s.snapshot
                          ? `no track · updated ${Math.max(0, Math.round((Date.now() - s.snapshot.fetchedAt) / 1000))}s ago`
                          : "heartbeat starts on the Brain tab"}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(s.scope ?? "").split(/\s+/).filter(Boolean).map((sc) => (
                      <Badge key={sc} variant="outline" className="font-mono text-[10px] border-border">
                        {sc}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {s.historyCount > 0
                      ? `${s.historyCount} tracks in the play history ring (seal-covered)`
                      : "history ring starts filling as tracks change"}
                  </p>

                  {s.needsReauth && (
                    <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span>The stored grant expired — click Connect with Spotify again; the Client ID stays.</span>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    {!s.needsReauth && (
                      <Button variant="outline" className="h-11" disabled={connect.isPending} onClick={() => connect.mutate()}>
                        <PlugZap className="mr-2 h-4 w-4" aria-hidden />
                        Re-authorize
                      </Button>
                    )}
                    <Button variant="outline" className="h-11" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
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
                  Only the Client ID + OAuth tokens live in the vault (AES-256-GCM). Tokens auto-refresh; disconnect
                  revokes at Spotify best-effort and wipes the rows. Nothing is ever shown again in plaintext.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
