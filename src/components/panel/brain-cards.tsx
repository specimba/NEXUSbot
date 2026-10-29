"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { BookOpenText, Music4, Plus, Trash2, History, ShieldOff } from "lucide-react";

/**
 * v37 — Brain tab grounding cards (Phase G2/G3, plan §10).
 *
 * NowPlayingCard doubles as THE HEARTBEAT: its 20s refetchInterval on
 * /api/brain/nowplaying keeps the in-process Spotify snapshot warm with no
 * background timer and no new mini-service (plan critique #4). Honest
 * states only — the card renders the same enum the deterministic lane uses.
 *
 * LoreBookCard is the owner's channel-wisdom CRUD: inside jokes ("DJ
 * Nikolina") become grounded facts instead of Exa pipe-smoking guides.
 * Entries live in Setting KV brain.lore → seal-covered automatically.
 */

type NowPlayingResponse = {
  ok: true;
  connected: boolean;
  fresh: boolean;
  snapshot: {
    state: "NOT_CONFIGURED" | "NEEDS_REAUTH" | "IDLE" | "PAUSED" | "PLAYING" | "DEGRADED";
    isPlaying: boolean;
    track: { name: string; artists: string; album: string; year: string; url: string | null; isLocal: boolean; kind: "track" | "episode" } | null;
    device: string | null;
    fetchedAt: number;
    ageS: number;
  } | null;
  history: Array<{ ts: number; name: string; artists: string; album: string }>;
};

const NP_STATE_TONE: Record<string, "ok" | "warn" | "muted"> = {
  PLAYING: "ok",
  PAUSED: "warn",
  IDLE: "muted",
  NOT_CONFIGURED: "muted",
  NEEDS_REAUTH: "warn",
  DEGRADED: "warn",
};

export function NowPlayingCard() {
  const np = useQuery<NowPlayingResponse>({
    queryKey: ["brain-nowplaying"],
    queryFn: async () => {
      const res = await fetch("/api/brain/nowplaying", { cache: "no-store" });
      if (!res.ok) throw new Error("now-playing unavailable");
      return res.json() as Promise<NowPlayingResponse>;
    },
    // THE HEARTBEAT (plan critique #4): keeps the snapshot warm while the
    // Brain tab is open; the plak lane reads the same in-process cache.
    refetchInterval: 20_000,
  });

  const snap = np.data?.snapshot;
  const tone = snap ? NP_STATE_TONE[snap.state] ?? "muted" : "muted";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Music4 className="h-4 w-4 text-primary" aria-hidden />
            Now Playing — Yayın Müziği
          </CardTitle>
          {np.isPending ? (
            <Skeleton className="h-6 w-20" />
          ) : snap ? (
            <Badge
              variant="outline"
              className={
                tone === "ok"
                  ? "border-primary/40 text-primary"
                  : tone === "warn"
                    ? "border-amber-500/50 text-amber-600 dark:text-amber-400"
                    : "text-muted-foreground border-border"
              }
            >
              {snap.state}
            </Badge>
          ) : null}
        </div>
        <CardDescription>
          The Spotify grounding feed — the same data the &quot;şu an ne çalıyor&quot; deterministic lane answers from.
          This tab&apos;s 20s poll IS the heartbeat that keeps the cache warm; the chat path itself never waits on
          Spotify.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {np.isPending && (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-6 w-2/3" />
          </div>
        )}

        {!np.isPending && !np.data?.connected && (
          <div className="rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
            Spotify grounding is <span className="text-foreground">not connected</span> — Connectors tab → Spotify
            Grounding. Until then the bot honestly says &quot;bağlantım yok&quot; on music questions; nothing is faked.
          </div>
        )}

        {!np.isPending && np.data?.connected && snap && (
          <div className="space-y-3">
            {snap.track ? (
              <div className="rounded-md border border-border p-3">
                <p className="truncate text-sm font-medium">
                  {snap.track.artists ? `${snap.track.artists} — ` : ""}
                  {snap.track.name}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {snap.track.kind === "episode" ? "podcast episode" : snap.track.album}
                  {snap.track.year ? ` · ${snap.track.year}` : ""} · {snap.isPlaying ? "çalıyor" : "duraklatılmış"}
                  {snap.device ? ` · ${snap.device}` : ""}
                  {snap.track.isLocal ? " · local file (no link)" : ""}
                </p>
                {snap.track.url && (
                  <a
                    href={snap.track.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-block break-all text-xs text-primary underline underline-offset-2"
                  >
                    open in Spotify
                  </a>
                )}
              </div>
            ) : (
              <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                {snap.state === "IDLE"
                  ? "Şu an Spotify'da çalan parça yok (204 / no active device)."
                  : snap.state === "DEGRADED"
                    ? "Spotify hattı şu an aksıyor — cached snapshot ya da honest DEGRADED cevabı."
                    : "Snapshot boş — ilk heartbeat dolduracak."}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              snapshot age {snap.ageS}s · {np.data.fresh ? "fresh (YAYIN card active)" : "stale (card omitted)"} — the
              YAYIN MÜZİĞİ prompt card only injects while fresh (&lt;5 min).
            </p>
          </div>
        )}

        {np.data?.history && np.data.history.length > 0 && (
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <History className="h-3.5 w-3.5" aria-hidden /> Recent plays (seal-covered ring)
            </p>
            <ul className="max-h-48 space-y-1.5 overflow-y-auto pr-1 text-xs" role="list">
              {np.data.history.map((h, i) => (
                <li key={`${h.ts}-${i}`} className="flex items-baseline justify-between gap-2 rounded-md border border-border/60 px-2 py-1.5">
                  <span className="min-w-0 truncate">
                    <span className="text-muted-foreground">{h.artists || "—"} · </span>
                    {h.name}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {formatDistanceToNow(new Date(h.ts), { addSuffix: false })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// LoreBookCard
// ---------------------------------------------------------------------------

type LoreEntry = {
  id: string;
  aliases: string[];
  text: string;
  blockResearch?: boolean;
  createdAt: number;
  updatedAt: number;
};

type LoreResponse = { ok: true; entries: LoreEntry[]; count: number; caps: { maxEntries: number; maxText: number; maxAliases: number } };

export function LoreBookCard() {
  const queryClient = useQueryClient();
  const [aliases, setAliases] = useState("");
  const [text, setText] = useState("");
  const [blockResearch, setBlockResearch] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const lore = useQuery<LoreResponse>({
    queryKey: ["lore-book"],
    queryFn: async () => {
      const res = await fetch("/api/lore", { cache: "no-store" });
      if (!res.ok) throw new Error("lore unavailable");
      return res.json() as Promise<LoreResponse>;
    },
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["lore-book"] });

  const add = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/lore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aliases: aliases.split(/[,\n]/).map((a) => a.trim()).filter(Boolean),
          text: text.trim(),
          blockResearch,
        }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(errBody?.error?.message ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      setAliases("");
      setText("");
      setBlockResearch(false);
      invalidate();
      toast.success("Lore added", { description: "The bot sees it on the next matching message." });
    },
    onError: (e: Error) => toast.error("Lore add failed", { description: e.message }),
  });

  const toggleBlock = useMutation({
    mutationFn: async (entry: LoreEntry) => {
      const res = await fetch("/api/lore", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id, aliases: entry.aliases, text: entry.text, blockResearch: !entry.blockResearch }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: invalidate,
    onError: (e: Error) => toast.error("Update failed", { description: e.message }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/lore?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: invalidate,
    onError: (e: Error) => toast.error("Delete failed", { description: e.message }),
  });

  const clearAll = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/lore?all=1", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      setConfirmClear(false);
      invalidate();
      toast.success("Lore Book cleared");
    },
    onError: (e: Error) => toast.error("Clear failed", { description: e.message }),
  });

  const entries = lore.data?.entries ?? [];
  const caps = lore.data?.caps;

  return (
    <>
      <Toaster richColors position="bottom-right" />
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <BookOpenText className="h-4 w-4 text-primary" aria-hidden />
              Lore Book — Kanal Bilgeliği
            </CardTitle>
            {lore.isPending ? (
              <Skeleton className="h-6 w-14" />
            ) : (
              <Badge variant="outline" className="text-muted-foreground border-border">
                {entries.length}/{caps?.maxEntries ?? 40}
              </Badge>
            )}
          </div>
          <CardDescription>
            Channel facts the web will never know: inside jokes, running bits, nicknames. Matched aliases inject the
            entry into the bot&apos;s prompt as ground truth — &quot;DJ Nikolina&quot; stops coming back as
            pipe-smoking guides. Entries flagged <span className="font-mono">web&apos;e kapat</span> also keep the
            question OUT of web research (pure in-jokes); unflagged ones still allow research with lore context.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {lore.isPending && (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}

          {!lore.isPending && (
            <>
              <div className="space-y-2">
                <Label htmlFor="lore-aliases">Aliases (comma separated — diacritics don&apos;t matter)</Label>
                <Input
                  id="lore-aliases"
                  className="h-11"
                  placeholder="nikolina, dj nikolina, nikolına"
                  value={aliases}
                  onChange={(e) => setAliases(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lore-text">Fact (what the bot should know)</Label>
                <textarea
                  id="lore-text"
                  className="min-h-[72px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  maxLength={400}
                  placeholder="DJ Nikolina, specimba'nın uydurduğu hayalet DJ — 26 Aralık şakasının parçası; gerçek bir DJ değildir."
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <p className="text-right text-[10px] text-muted-foreground">{text.length}/{caps?.maxText ?? 400}</p>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    <ShieldOff className="h-3.5 w-3.5" aria-hidden /> Web&apos;e kapat (blockResearch)
                  </p>
                  <p className="text-xs text-muted-foreground">alias match + this flag = question answered from lore, never sent to web research</p>
                </div>
                <Switch checked={blockResearch} onCheckedChange={setBlockResearch} aria-label="Block web research for this lore" />
              </div>
              <Button
                className="h-11 w-full sm:w-auto"
                disabled={add.isPending || !aliases.trim() || text.trim().length < 3}
                onClick={() => add.mutate()}
              >
                <Plus className="mr-2 h-4 w-4" aria-hidden />
                {add.isPending ? "Saving…" : "Add lore"}
              </Button>
            </>
          )}

          {entries.length > 0 && (
            <ul className="max-h-96 space-y-2 overflow-y-auto pr-1" role="list">
              {entries.map((entry) => (
                <li key={entry.id} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {entry.aliases.map((a) => (
                      <Badge key={a} variant="outline" className="font-mono text-[10px] border-border">
                        {a}
                      </Badge>
                    ))}
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {formatDistanceToNow(new Date(entry.updatedAt), { addSuffix: false })}
                    </span>
                  </div>
                  <p className="mt-2 break-words text-xs leading-relaxed text-foreground/90">{entry.text}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
                      <Switch
                        checked={entry.blockResearch === true}
                        onCheckedChange={() => toggleBlock.mutate(entry)}
                        aria-label={`Toggle web block for ${entry.aliases[0]}`}
                        className="scale-90"
                      />
                      web&apos;e kapat
                    </label>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-8 px-2 text-xs text-destructive hover:text-destructive"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(entry.id)}
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden />
                      delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {entries.length > 0 && (
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-muted-foreground">
                Entries live in the encrypted seal automatically (Setting KV) — cold-boot restore keeps them.
              </p>
              {confirmClear ? (
                <div className="flex gap-2">
                  <Button variant="destructive" size="sm" className="h-9" disabled={clearAll.isPending} onClick={() => clearAll.mutate()}>
                    confirm clear
                  </Button>
                  <Button variant="outline" size="sm" className="h-9" onClick={() => setConfirmClear(false)}>
                    cancel
                  </Button>
                </div>
              ) : (
                <Button variant="outline" size="sm" className="h-9 text-xs" onClick={() => setConfirmClear(true)}>
                  <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden />
                  clear all
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
