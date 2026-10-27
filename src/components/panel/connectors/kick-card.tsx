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
        aria-label={`${label} kopyala`}
        onClick={() => {
          void navigator.clipboard
            .writeText(value)
            .then(() => toast.success("Kopyalandı", { description: label }))
            .catch(() => toast.error("Kopyalanamadı", { description: "Panoya erişilemedi." }));
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
      toast.success("Kick bağlandı", { description: "Hesap panel kasasında, tokenlar otomatik yenileniyor." });
      void queryClient.invalidateQueries({ queryKey: ["connector-kick-status"] });
    } else {
      toast.error("Kick bağlantısı kurulamadı", {
        description: "App bilgilerini ve redirect URL'ini Kick formuyla birebir kontrol et.",
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
      toast.success("App bilgileri kasada", { description: "Client secret AES-256-GCM ile şifrelendi." });
    },
    onError: (e: Error) => toast.error("Kaydedilemedi", { description: e.message }),
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
      toast.info("Kick'e yönlendiriliyorsun", { description: "Yetki ekranında izin ver, paneye otomatik dönülür." });
      window.location.href = data.authorizeUrl;
    },
    onError: (e: Error) => toast.error("Bağlantı başlatılamadı", { description: e.message }),
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/kick/oauth", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connector-kick-status"] });
      toast.success("Hesap bağlantısı kesildi", { description: "App bilgileri duruyor — tek tıkla tekrar bağlanır." });
    },
    onError: (e: Error) => toast.error("Kesilemedi", { description: e.message }),
  });

  const deleteApp = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/kick/app", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connector-kick-status"] });
      toast.success("Kick kasası temizlendi", { description: "App + token kayıtları silindi." });
    },
    onError: (e: Error) => toast.error("Silinemedi", { description: e.message }),
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
      toast.success("Webhook kaydedildi", { description: `chat.message.sent → ${data.url}` });
    },
    onError: (e: Error) => toast.error("Webhook kurulamadı", { description: e.message }),
  });

  const hookTeardown = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/kick/webhook-setup", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connector-kick-status"] });
      toast.success("Webhook kaldırıldı");
    },
    onError: (e: Error) => toast.error("Kaldırılamadı", { description: e.message }),
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
    onError: (e: Error) => toast.error("Toggle hatası", { description: e.message }),
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
    onSuccess: () => toast.success("Test mesajı Kick sohbetinde", { description: "kanalda kontrol et" }),
    onError: (e: Error) => toast.error("Test gönderilemedi", { description: e.message }),
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
            Official Kick app (OAuth 2.1 + PKCE) — sohbet okuma zaten canlı (anonim köprü, port 3010). Bu bağlantı
            yazma tarafını açar: VYCE cevaplarını canlı sohbete bot olarak yazar, imzalı webhook'larla !ai akışını
            resmî hattan alır.
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
                <CopyRow label="Kick Create-an-App → Redirect URL (birebir yapıştır)" value={s.redirectUri} />
                <CopyRow label="Kick Create-an-App → Webhooks URL (https zorunlu)" value={s.webhookUrl} />
              </div>

              {!s.configured && (
                <div className="space-y-3">
                  <div className="rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
                    kick.com → <span className="text-foreground">Ayarlar → Developer → Create an App</span>:
                    Redirect URL ve Webhooks URL'e yukarıdaki iki değeri birebir yapıştır (eski
                    <span className="font-mono text-foreground"> http://ws-ef-…fcapp.run</span> satırı hata
                    verir — Kick yalnızca https kabul eder), şu kutucukları işaretle —{" "}
                    {s.scopes.map((sc) => s.scopeHints[sc]).filter(Boolean).join(", ")} — sonra Client ID/Secret'i
                    buraya gir.
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
                    {saveApp.isPending ? "Kasaya yazılıyor…" : "App bilgilerini kaydet"}
                  </Button>
                </div>
              )}

              {s.configured && !s.connected && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">{s.app?.clientIdMasked}</span>
                    <span>·</span>
                    <span>secret kasada ({s.app?.clientSecretMasked})</span>
                  </div>
                  <Button className="h-11 w-full sm:w-auto" disabled={connect.isPending} onClick={() => connect.mutate()}>
                    <PlugZap className="mr-2 h-4 w-4" aria-hidden />
                    {connect.isPending ? "Yönlendiriliyor…" : "Connect with Kick"}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Yetki ekranı {new URL(s.redirectUri).host} üzerinden döner — Kick formundaki Redirect URL bu
                    panelin adresiyle birebir aynı olmalı.
                  </p>
                  <Button
                    variant="outline"
                    className="h-11"
                    disabled={deleteApp.isPending}
                    onClick={() => deleteApp.mutate()}
                  >
                    <Trash2 className="mr-2 h-4 w-4" aria-hidden />
                    App kaydını sil
                  </Button>
                </div>
              )}

              {s.connected && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Check className="h-4 w-4 text-primary" aria-hidden />
                    <span className="font-medium">{s.account?.name ?? "bağlı hesap"}</span>
                    <span className="text-xs text-muted-foreground">
                      {s.account ? `@${s.account.userId}` : ""} · tokenlar otomatik döner (rotating refresh)
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
                          <Webhook className="h-4 w-4" aria-hidden /> Resmî webhook akışı
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {s.webhooks.subs && s.webhooks.subs.length > 0
                            ? `${s.webhooks.subs.length} abonelik canlı (chat.message.sent)`
                            : s.webhooks.error
                              ? `abonelik listesi alınamadı: ${s.webhooks.error}`
                              : "kayıtlı abonelik yok — kur, !ai akışı imzalı hattan gelsin"}
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
                            Kaldır
                          </Button>
                        ) : (
                          <Button
                            className="h-11"
                            disabled={hookSetup.isPending}
                            onClick={() => hookSetup.mutate()}
                          >
                            {hookSetup.isPending ? "Kaydediliyor…" : "Webhook kur"}
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">Bot cevapları sohbette</p>
                        <p className="text-xs text-muted-foreground">
                          webhook'tan gelen !ai mesajlarının cevabı canlı sohbete yazılır
                        </p>
                      </div>
                      <Switch
                        checked={s.chatReplies}
                        onCheckedChange={(v) => toggleReplies.mutate(v)}
                        aria-label="Bot cevapları sohbette"
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
                      {testChat.isPending ? "Gönderiliyor…" : "Test mesajı gönder"}
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
                      Hesabı bağlantıdan çıkar
                    </Button>
                    <Button
                      variant="outline"
                      className="h-11 text-destructive hover:text-destructive"
                      disabled={deleteApp.isPending}
                      onClick={() => deleteApp.mutate()}
                    >
                      <Trash2 className="mr-2 h-4 w-4" aria-hidden />
                      Her şeyi sil
                    </Button>
                  </div>
                </div>
              )}

              {!s.connected && (
                <p className="flex items-start gap-2 text-xs text-muted-foreground">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  Client secret yalnızca kasada durur (AES-256-GCM), panele asla geri gösterilmez. Token yenileme
                  otomatiktir; refresh token tek kullanımlık olduğu için her yenilemede yeni çift anında kasaya
                  yazılır.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
