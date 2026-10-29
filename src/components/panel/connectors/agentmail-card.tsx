"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle,
  Loader2,
  Mail,
  MailOpen,
  RefreshCw,
  Send,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";

/**
 * v37.1 — AGENT POSTA card: the bot's own email as an agent (AgentMail).
 * nexusagent1@agentmail.to — pull-based inbox feed with Agent Armor verdict
 * badges + a send-lane test. Docs: docs/agentmail-deep-dive.md.
 * Honest states only — a failed probe is a failed probe, never dressed up.
 */

type AgentMailStatus = {
  ok: true;
  status: {
    configured: boolean;
    reachable: boolean | null;
    apiOk: boolean | null;
    error: string | null;
    credential: { masked: string; keyId: string; updatedAt: string } | null;
    probedAt: string | null;
    inbox: { inbox_id: string; email: string; display_name: string } | null;
    labsEnabled: boolean | null;
  };
};

type InboxFeed = {
  ok: true;
  count: number;
  messages: Array<{
    messageId: string;
    threadId: string;
    from: string;
    to: string;
    subject: string;
    preview: string;
    labels: string[];
    timestamp: string;
    armor: { status: string; verdict: string; reason: string } | null;
  }>;
};

function armorBadge(armor: InboxFeed["messages"][number]["armor"]) {
  if (!armor) return <Badge variant="outline" className="text-muted-foreground">taranmadı</Badge>;
  if (armor.verdict === "clear") {
    return (
      <Badge className="gap-1 bg-emerald-600 text-white hover:bg-emerald-600">
        <ShieldCheck className="h-3 w-3" /> armor: temiz
      </Badge>
    );
  }
  if (armor.verdict === "review") {
    return (
      <Badge className="gap-1 bg-red-600 text-white hover:bg-red-600">
        <ShieldAlert className="h-3 w-3" /> armor: incele
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1">
      <ShieldAlert className="h-3 w-3" /> armor: {armor.verdict || armor.status}
    </Badge>
  );
}

export function AgentMailCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [to, setTo] = useState("nexusagent1@agentmail.to");
  const [subject, setSubject] = useState("NEXUS OS — test mesajı");
  const [text, setText] = useState("Bu bir panel test mesajıdır. — VYCE");

  const status = useQuery<AgentMailStatus>({
    queryKey: ["connectors", "agentmail", "status"],
    queryFn: async () => {
      const res = await fetch("/api/connectors/agentmail/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
  });

  const inbox = useQuery<InboxFeed>({
    queryKey: ["connectors", "agentmail", "inbox"],
    queryFn: async () => {
      const res = await fetch("/api/connectors/agentmail/inbox?limit=10");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: status.data?.status.configured === true,
    staleTime: 30_000,
  });

  const sendTest = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/connectors/agentmail/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, subject, text }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      return body.sent as { messageId: string; threadId: string; tookMs: number };
    },
    onSuccess: (sent) => {
      toast({
        title: "AGENT POSTA — gönderildi",
        description: `${sent.tookMs}ms · thread ${sent.threadId.slice(0, 8)}…`,
      });
      queryClient.invalidateQueries({ queryKey: ["connectors", "agentmail", "inbox"] });
    },
    onError: (err: Error) => {
      toast({ title: "AGENT POSTA — gönderilemedi", description: err.message, variant: "destructive" });
    },
  });

  const st = status.data?.status;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-4 w-4" aria-hidden />
          AGENT POSTA — nexusagent1@agentmail.to
        </CardTitle>
        <CardDescription>
          Bot artık bir e-posta adresine sahip — gelen kutusu Agent Armor ile
          prompt-injection taramasından geçer, giden hat panel test edilebilir.
          Ücretsiz katman: 3 inbox / 100 gönderim/gün.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.isLoading && <Skeleton className="h-8 w-full" />}
        {status.isError && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" /> durum alınamadı:{" "}
            {(status.error as Error).message}
          </div>
        )}
        {st && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {!st.configured ? (
              <Badge variant="outline" className="text-muted-foreground">anahtar yok (vault)</Badge>
            ) : st.apiOk ? (
              <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">bağlı</Badge>
            ) : (
              <Badge variant="destructive">hatayı gör</Badge>
            )}
            {st.labsEnabled === true && (
              <Badge variant="outline" className="gap-1">
                <ShieldCheck className="h-3 w-3" /> Agent Armor AKTİF
              </Badge>
            )}
            {st.error && <span className="text-destructive text-xs">{st.error}</span>}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 gap-1"
              onClick={() => {
                status.refetch();
                inbox.refetch();
              }}
            >
              <RefreshCw className="h-3 w-3" /> yenile
            </Button>
          </div>
        )}

        {/* Inbox feed — long-list rule: max-h-96 + custom scrollbar via Tailwind */}
        {st?.configured && (
          <div>
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <MailOpen className="h-3 w-3" aria-hidden /> gelen kutusu
                {inbox.data ? ` — ${inbox.data.count} mesaj (son 10)` : ""}
              </span>
            </div>
            {inbox.isLoading && <Skeleton className="h-40 w-full" />}
            {inbox.isError && (
              <div className="text-xs text-destructive">
                gelen kutusu okunamadı: {(inbox.error as Error).message}
              </div>
            )}
            {inbox.data && inbox.data.messages.length === 0 && (
              <div className="text-xs text-muted-foreground">gelen kutusu boş.</div>
            )}
            {inbox.data && inbox.data.messages.length > 0 && (
              <ul
                className="max-h-96 space-y-2 overflow-y-auto pr-1"
                role="feed"
                aria-label="AgentMail gelen kutusu"
              >
                {inbox.data.messages.map((m) => (
                  <li
                    key={m.messageId}
                    className="rounded-md border border-border/60 p-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium truncate max-w-[45%]" title={m.from}>
                        {m.from}
                      </span>
                      {armorBadge(m.armor)}
                      <span className="ml-auto text-muted-foreground">
                        {m.timestamp.slice(0, 16).replace("T", " ")}
                      </span>
                    </div>
                    <div className="mt-1 font-medium truncate">{m.subject || "(konusuz)"}</div>
                    <p className="mt-1 line-clamp-2 text-muted-foreground whitespace-pre-line">
                      {m.preview}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Send test */}
        {st?.configured && (
          <div className="space-y-2 rounded-md border border-border/60 p-3">
            <div className="text-xs font-medium">Gönderi hattı testi</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="kime@ornek.com"
                aria-label="Alıcı e-posta"
                className="text-xs"
              />
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Konu"
                aria-label="Konu"
                className="text-xs"
              />
            </div>
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Metin"
              aria-label="Mesaj metni"
              className="text-xs"
            />
            <Button
              size="sm"
              className="gap-1"
              disabled={sendTest.isPending}
              onClick={() => sendTest.mutate()}
            >
              {sendTest.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Send className="h-3 w-3" />
              )}
              gönder
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
