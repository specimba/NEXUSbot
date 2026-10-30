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
  CalendarClock,
  Loader2,
  Mail,
  MailOpen,
  MessagesSquare,
  RefreshCw,
  Send,
  ShieldCheck,
  ShieldAlert,
  Terminal,
} from "lucide-react";

/**
 * v37.3 — AGENT MAIL card: the bot's own email as an agent (AgentMail).
 * nexusagent1@agentmail.to — inbox + threads feeds with Agent Armor verdict
 * badges, a send-lane test, the daily digest trigger and the owner-only
 * mail→bot command lane poll. Docs: docs/agentmail-deep-dive.md.
 * Honest states only — a failed probe is a failed probe, never dressed up.
 * EN pass: v37.1 shipped the card in Turkish — the rest of the panel is EN,
 * this card now matches (owner ask 2026-10-30).
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

type ThreadFeed = {
  ok: true;
  count: number;
  threads: Array<{
    threadId: string;
    subject: string;
    preview: string;
    senders: string[];
    recipients: string[];
    labels: string[];
    messageCount: number | null;
    latestTimestamp: string | null;
  }>;
};

type CommandPoll = {
  ok: true;
  scanned: number;
  processed: Array<{
    messageId: string;
    command: string;
    subject: string;
    replySubject: string;
    replySent: boolean;
    replyError: string | null;
  }>;
  skipped: { notOwner: number; armorNotClear: number; noCommand: number; old: number; pending: number };
};

function armorBadge(armor: InboxFeed["messages"][number]["armor"]) {
  if (!armor) return <Badge variant="outline" className="text-muted-foreground">unscanned</Badge>;
  if (armor.verdict === "clear") {
    return (
      <Badge className="gap-1 bg-emerald-600 text-white hover:bg-emerald-600">
        <ShieldCheck className="h-3 w-3" /> armor: clear
      </Badge>
    );
  }
  if (armor.verdict === "review") {
    return (
      <Badge className="gap-1 bg-red-600 text-white hover:bg-red-600">
        <ShieldAlert className="h-3 w-3" /> armor: review
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
  const [view, setView] = useState<"inbox" | "threads">("inbox");
  const [to, setTo] = useState("nexusagent1@agentmail.to");
  const [subject, setSubject] = useState("NEXUS OS — test message");
  const [text, setText] = useState("This is a panel test message. — VYCE");

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

  const threads = useQuery<ThreadFeed>({
    queryKey: ["connectors", "agentmail", "threads"],
    queryFn: async () => {
      const res = await fetch("/api/connectors/agentmail/threads?limit=10");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: status.data?.status.configured === true && view === "threads",
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
        title: "AGENT MAIL — sent",
        description: `${sent.tookMs}ms · thread ${sent.threadId.slice(0, 8)}…`,
      });
      queryClient.invalidateQueries({ queryKey: ["connectors", "agentmail", "inbox"] });
    },
    onError: (err: Error) => {
      toast({ title: "AGENT MAIL — send failed", description: err.message, variant: "destructive" });
    },
  });

  const sendDigest = useMutation({
    mutationFn: async (preview: boolean) => {
      const res = await fetch("/api/connectors/agentmail/digest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preview }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      return body as {
        preview: boolean;
        digest: { dateLabel: string; interactions: { total: number }; subject: string };
      };
    },
    onSuccess: (body) => {
      toast({
        title: body.preview ? "Digest preview built" : "Daily digest sent to owner",
        description: `${body.digest.dateLabel} · ${body.digest.interactions.total} interactions · ${body.digest.subject}`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Digest failed", description: err.message, variant: "destructive" });
    },
  });

  const pollCommands = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/connectors/agentmail/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      return body as CommandPoll;
    },
    onSuccess: (poll) => {
      const done = poll.processed.filter((p) => p.replySent).length;
      toast({
        title: done > 0 ? `Command lane — ${done} executed` : "Command lane — nothing to run",
        description:
          done > 0
            ? poll.processed.map((p) => `${p.command} → ${p.replySubject}`).join(" · ")
            : `scanned ${poll.scanned} · skipped ${poll.skipped.notOwner} not-owner, ${poll.skipped.armorNotClear} armor-not-clear, ${poll.skipped.noCommand} no-command`,
      });
      queryClient.invalidateQueries({ queryKey: ["connectors", "agentmail", "inbox"] });
    },
    onError: (err: Error) => {
      toast({ title: "Command lane poll failed", description: err.message, variant: "destructive" });
    },
  });

  const st = status.data?.status;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-4 w-4" aria-hidden />
          AGENT MAIL — nexusagent1@agentmail.to
        </CardTitle>
        <CardDescription>
          The bot now owns an email address — inbound mail passes an Agent Armor
          prompt-injection scan, the outbound lane is panel-testable, and the
          owner can command the bot by mail (armor-gated). Free tier: 3 inboxes
          / 100 sends/day.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.isLoading && <Skeleton className="h-8 w-full" />}
        {status.isError && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" /> status fetch failed:{" "}
            {(status.error as Error).message}
          </div>
        )}
        {st && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {!st.configured ? (
              <Badge variant="outline" className="text-muted-foreground">no key (vault)</Badge>
            ) : st.apiOk ? (
              <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">connected</Badge>
            ) : (
              <Badge variant="destructive">see error</Badge>
            )}
            {st.labsEnabled === true && (
              <Badge variant="outline" className="gap-1">
                <ShieldCheck className="h-3 w-3" /> Agent Armor ACTIVE
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
                if (view === "threads") threads.refetch();
              }}
            >
              <RefreshCw className="h-3 w-3" /> refresh
            </Button>
          </div>
        )}

        {/* Feed — inbox | threads toggle; long-list rule: max-h-96 + scroll */}
        {st?.configured && (
          <div>
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                {view === "inbox" ? (
                  <>
                    <MailOpen className="h-3 w-3" aria-hidden /> inbox
                    {inbox.data ? ` — ${inbox.data.count} messages (latest 10)` : ""}
                  </>
                ) : (
                  <>
                    <MessagesSquare className="h-3 w-3" aria-hidden /> threads
                    {threads.data ? ` — ${threads.data.count} threads (latest 10)` : ""}
                  </>
                )}
              </span>
              <span className="flex gap-1">
                <Button
                  variant={view === "inbox" ? "secondary" : "ghost"}
                  size="sm"
                  className="h-6 px-2 text-xs"
                  aria-pressed={view === "inbox"}
                  onClick={() => setView("inbox")}
                >
                  inbox
                </Button>
                <Button
                  variant={view === "threads" ? "secondary" : "ghost"}
                  size="sm"
                  className="h-6 px-2 text-xs"
                  aria-pressed={view === "threads"}
                  onClick={() => setView("threads")}
                >
                  threads
                </Button>
              </span>
            </div>

            {view === "inbox" && (
              <>
                {inbox.isLoading && <Skeleton className="h-40 w-full" />}
                {inbox.isError && (
                  <div className="text-xs text-destructive">
                    inbox fetch failed: {(inbox.error as Error).message}
                  </div>
                )}
                {inbox.data && inbox.data.messages.length === 0 && (
                  <div className="text-xs text-muted-foreground">inbox is empty.</div>
                )}
                {inbox.data && inbox.data.messages.length > 0 && (
                  <ul
                    className="max-h-96 space-y-2 overflow-y-auto pr-1"
                    role="feed"
                    aria-label="AgentMail inbox"
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
                        <div className="mt-1 font-medium truncate">{m.subject || "(no subject)"}</div>
                        <p className="mt-1 line-clamp-2 text-muted-foreground whitespace-pre-line">
                          {m.preview}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {view === "threads" && (
              <>
                {threads.isLoading && <Skeleton className="h-40 w-full" />}
                {threads.isError && (
                  <div className="text-xs text-destructive">
                    threads fetch failed: {(threads.error as Error).message}
                  </div>
                )}
                {threads.data && threads.data.threads.length === 0 && (
                  <div className="text-xs text-muted-foreground">no threads yet.</div>
                )}
                {threads.data && threads.data.threads.length > 0 && (
                  <ul className="max-h-96 space-y-2 overflow-y-auto pr-1" role="list" aria-label="AgentMail threads">
                    {threads.data.threads.map((t) => (
                      <li
                        key={t.threadId}
                        className="rounded-md border border-border/60 p-2 text-xs"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <MessagesSquare className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="font-medium truncate max-w-[60%]" title={t.subject}>
                            {t.subject || "(no subject)"}
                          </span>
                          {t.messageCount !== null && (
                            <Badge variant="outline" className="text-muted-foreground">
                              {t.messageCount} msg
                            </Badge>
                          )}
                          <span className="ml-auto text-muted-foreground">
                            {t.latestTimestamp ? t.latestTimestamp.slice(0, 16).replace("T", " ") : ""}
                          </span>
                        </div>
                        <div className="mt-1 truncate text-muted-foreground" title={`${t.senders.join(", ")} → ${t.recipients.join(", ")}`}>
                          {t.senders.join(", ") || "—"} → {t.recipients.join(", ") || "—"}
                        </div>
                        {t.preview && (
                          <p className="mt-1 line-clamp-2 text-muted-foreground">{t.preview}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}

        {/* Send test */}
        {st?.configured && (
          <div className="space-y-2 rounded-md border border-border/60 p-3">
            <div className="text-xs font-medium">Send-lane test</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="to@example.com"
                aria-label="Recipient email"
                className="text-xs"
              />
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject"
                aria-label="Subject"
                className="text-xs"
              />
            </div>
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Body text"
              aria-label="Message body"
              className="text-xs"
            />
            <div className="flex flex-wrap gap-2">
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
                send
              </Button>
            </div>
          </div>
        )}

        {/* Digest + command lane (v37.3) */}
        {st?.configured && (
          <div className="space-y-2 rounded-md border border-border/60 p-3">
            <div className="text-xs font-medium">Owner lane — digest + mail commands</div>
            <p className="text-xs text-muted-foreground">
              Daily digest (06:00 Istanbul cron): yesterday&apos;s chat/LLM/durability
              stats emailed to the owner. Mail-command lane is triple-gated —
              sender = owner only · Agent Armor verdict must be
              &quot;clear&quot; · strict subject whitelist (help / status /
              digest / ping).
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1"
                disabled={sendDigest.isPending}
                onClick={() => sendDigest.mutate(false)}
              >
                {sendDigest.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <CalendarClock className="h-3 w-3" />
                )}
                send digest now
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1"
                disabled={sendDigest.isPending}
                onClick={() => sendDigest.mutate(true)}
              >
                preview
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1"
                disabled={pollCommands.isPending}
                onClick={() => pollCommands.mutate()}
              >
                {pollCommands.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Terminal className="h-3 w-3" />
                )}
                poll commands
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
