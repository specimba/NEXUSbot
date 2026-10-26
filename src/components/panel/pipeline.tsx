"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import {
  BrainCircuit,
  ChevronDown,
  Cloud,
  Globe,
  MemoryStick,
  ShieldAlert,
  Timer,
} from "lucide-react";

type InteractionRow = {
  id: string;
  createdAt: string;
  username: string;
  command: string;
  message: string;
  response: string;
  model: string;
  modelId: string;
  provider: string;
  route: string;
  status: string;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  webUsed: boolean;
  memoryUsed: boolean;
  flags: string[];
  injectionScore: number;
  error: string;
};

type Lesson = {
  id: string;
  technique: string;
  username: string;
  snippet: string;
  counter: string;
  hits: number;
  severity: number;
  lastSeenAt: string;
};

type MirrorPooler = {
  present: boolean;
  ok: boolean | null;
  note: string;
};

type MirrorStatus = {
  ok: boolean;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string;
  pushed: number;
  failed: number;
  configured: boolean;
  probedAt: string | null;
  probeNote: string;
  pooler: MirrorPooler;
};

type PipelinePayload = {
  ok: boolean;
  rows: InteractionRow[];
  stats: {
    total: number;
    byModel: Array<[string, number]>;
    byProvider: Array<[string, number]>;
    byCommand: Array<[string, number]>;
    byStatus: Array<[string, number]>;
    flaggedCount: number;
    webUsedCount: number;
    memoryUsedCount: number;
    latencyP50: number | null;
    latencyP95: number | null;
    flagCounts: Array<[string, number]>;
  };
  lessons: Lesson[];
  mirror: MirrorStatus;
};

const FILTERS = [
  { id: "all", label: "ALL" },
  { id: "flagged", label: "FLAGGED" },
  { id: "errors", label: "ERRORS" },
] as const;

function statusBadgeClass(status: string): string {
  switch (status) {
    case "ok":
      return "border-primary/40 text-primary";
    case "refused":
      return "border-accent/60 text-accent";
    case "direct":
      return "border-border text-muted-foreground";
    case "busy":
      return "border-accent/60 text-accent";
    default:
      return "border-destructive/50 text-destructive";
  }
}

function flagBadgeClass(technique: string): string {
  switch (technique) {
    case "FAKE_AUTHORITY":
      return "border-destructive/60 text-destructive";
    case "PROMPT_INJECTION":
    case "RESET_ATTEMPT":
      return "border-accent/60 text-accent";
    default:
      return "border-border text-muted-foreground";
  }
}

/**
 * Mirror status line (E1) — same Setting("brain.mirror.status") source of
 * truth the Connectors → Supabase card reads via /api/connectors/supabase/mirror.
 * Honest states: ONLINE (push path probed/working), NOT CONFIGURED (widget
 * supabase_url/anon_key missing), OFFLINE (probed and failing — with the REAL
 * error, never a bare label).
 */
function MirrorLine({ mirror }: { mirror: MirrorStatus }) {
  const state = !mirror.configured ? "NOT CONFIGURED" : mirror.ok ? "ONLINE" : "OFFLINE";
  const toneClass = mirror.configured && mirror.ok
    ? "border-primary/30 bg-primary/5 text-primary"
    : mirror.configured
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : "border-border bg-muted/30 text-muted-foreground";
  return (
    <div
      className={cn("rounded-md border p-2.5 font-mono text-[11px] leading-relaxed", toneClass)}
      role="status"
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Cloud className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="font-semibold">SUPABASE MIRROR {state}</span>
        <span>
          — pushed {mirror.pushed} rows
          {mirror.failed > 0 ? ` · ${mirror.failed} failed` : ""}
          {mirror.lastOkAt
            ? ` · last ok ${formatDistanceToNow(new Date(mirror.lastOkAt), { addSuffix: true })}`
            : ""}
        </span>
        {mirror.probeNote ? <span className="text-muted-foreground">· {mirror.probeNote}</span> : null}
      </p>
      {!mirror.ok && mirror.configured && mirror.lastError ? (
        <p className="mt-1 break-words text-destructive">last error: {mirror.lastError}</p>
      ) : null}
      {!mirror.configured ? (
        <p className="mt-1 text-muted-foreground">
          arm the widget variables supabase_url + supabase_anon_key (Connectors → Widgets → variables) to enable the
          push.
        </p>
      ) : null}
      {mirror.pooler.present && mirror.pooler.ok === false && mirror.pooler.note ? (
        <p className="mt-1 break-words text-muted-foreground">{mirror.pooler.note}</p>
      ) : null}
      <p className="mt-1 text-muted-foreground">
        (local panel DB stays the source of truth; every interaction + security lesson is appended to your
        Supabase project — tables nexus_mirror_*)
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  hint,
}: {
  label: string;
  value: string | number;
  icon: typeof BrainCircuit;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md border border-primary/25 bg-primary/10">
          <Icon className="size-5 text-primary" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          <p className="font-mono text-xl font-semibold text-primary text-glow">{value}</p>
          {hint ? <p className="truncate text-[10px] text-muted-foreground">{hint}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}

function Row({
  row,
}: {
  row: InteractionRow;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border/60 bg-card/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/40"
      >
        <ChevronDown
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
        <span className="w-20 shrink-0 font-mono text-[10px] text-muted-foreground">
          {formatDistanceToNow(new Date(row.createdAt), { addSuffix: true })}
        </span>
        <span className="w-28 shrink-0 truncate font-mono text-primary">@{row.username}</span>
        <span className="w-16 shrink-0 font-mono text-[10px] uppercase text-muted-foreground">
          {row.command}
        </span>
        <span className="min-w-0 flex-1 truncate text-foreground/90">
          {row.message || row.error || "(empty)"}
        </span>
        <span className="hidden w-36 shrink-0 truncate font-mono text-[10px] text-muted-foreground md:block">
          {row.model || "—"}
        </span>
        {typeof row.latencyMs === "number" ? (
          <span className="hidden w-14 shrink-0 text-right font-mono text-[10px] text-muted-foreground sm:block">
            {row.latencyMs}ms
          </span>
        ) : null}
        <Badge variant="outline" className={cn("shrink-0 text-[10px]", statusBadgeClass(row.status))}>
          {row.status}
        </Badge>
        {row.flags.length > 0 ? (
          <Badge variant="outline" className={cn("shrink-0 text-[10px]", flagBadgeClass(row.flags[0]))}>
            {row.flags.length} FLAG
          </Badge>
        ) : null}
      </button>
      {open ? (
        <div className="space-y-2 border-t border-border/50 px-4 py-3 text-xs">
          <div>
            <p className="mb-1 font-mono text-[10px] uppercase text-muted-foreground">message</p>
            <p className="whitespace-pre-wrap break-words text-foreground/90">{row.message || "(none)"}</p>
          </div>
          <div>
            <p className="mb-1 font-mono text-[10px] uppercase text-muted-foreground">response</p>
            <p className="whitespace-pre-wrap break-words text-foreground/90">{row.response || "(none)"}</p>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground">
            <span>model: {row.modelId || row.model || "—"}</span>
            <span>provider: {row.provider || "—"}</span>
            <span>route: {row.route || "—"}</span>
            <span>tokens: {row.promptTokens ?? "—"}/{row.completionTokens ?? "—"}</span>
            <span>web: {row.webUsed ? "yes" : "no"}</span>
            <span>memory: {row.memoryUsed ? "yes" : "no"}</span>
            {row.error ? <span className="text-destructive">error: {row.error}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function PipelineTab() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");

  const pipeline = useQuery<PipelinePayload>({
    queryKey: ["interactions", filter],
    queryFn: async () => {
      const res = await fetch(`/api/interactions?filter=${filter}&limit=80`, { cache: "no-store" });
      if (!res.ok) throw new Error("interactions unavailable");
      return res.json();
    },
    refetchInterval: 10_000,
  });

  const data = pipeline.data;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {pipeline.isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)
        ) : pipeline.isError ? (
          <p className="col-span-full text-sm text-destructive" role="alert">
            Pipeline log unavailable — is the API up?
          </p>
        ) : data ? (
          <>
            <Stat
              label="Interactions (500w)"
              value={data.stats.total}
              icon={BrainCircuit}
              hint={`p50 ${data.stats.latencyP50 ?? "—"}ms · p95 ${data.stats.latencyP95 ?? "—"}ms`}
            />
            <Stat
              label="Flagged attempts"
              value={data.stats.flaggedCount}
              icon={ShieldAlert}
              hint={data.stats.flagCounts.slice(0, 2).map(([t, n]) => `${t}×${n}`).join(" · ") || "no techniques yet"}
            />
            <Stat
              label="Web research used"
              value={data.stats.webUsedCount}
              icon={Globe}
              hint="/api/brain/search attachments"
            />
            <Stat
              label="Memory ladder used"
              value={data.stats.memoryUsedCount}
              icon={MemoryStick}
              hint="server-side dialogue turns"
            />
          </>
        ) : null}
      </div>

      {data?.mirror ? (
        <MirrorLine mirror={data.mirror} />
      ) : null}

      <NewsDigestCard />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="font-mono text-sm uppercase tracking-wider">Interaction Log</CardTitle>
          <div className="flex gap-1" role="group" aria-label="Log filters">
            {FILTERS.map((f) => (
              <Button
                key={f.id}
                size="sm"
                variant={filter === f.id ? "default" : "ghost"}
                className={cn("h-8 px-2.5 font-mono text-[11px]", filter !== f.id && "text-muted-foreground")}
                onClick={() => setFilter(f.id)}
                aria-pressed={filter === f.id}
              >
                {f.label}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {pipeline.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 rounded-md" />
              ))}
            </div>
          ) : data && data.rows.length > 0 ? (
            <div className="max-h-96 space-y-2 overflow-y-auto pr-1 [scrollbar-color:theme(colors.primary/40)_transparent] [scrollbar-width:thin]">
              {data.rows.map((row) => (
                <Row key={row.id} row={row} />
              ))}
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No interactions logged yet — they appear the moment the OBS brain handles a{" "}
              <span className="font-mono text-primary">!ai</span> message.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="font-mono text-sm uppercase tracking-wider">Security Memory</CardTitle>
        </CardHeader>
        <CardContent>
          {data && data.lessons.length > 0 ? (
            <div className="max-h-96 space-y-2 overflow-y-auto pr-1 [scrollbar-color:theme(colors.primary/40)_transparent] [scrollbar-width:thin]">
              {data.lessons.map((lesson) => (
                <div
                  key={lesson.id}
                  className="flex items-start gap-3 rounded-md border border-border/60 bg-card/40 px-3 py-2 text-xs"
                >
                  <Badge
                    variant="outline"
                    className={cn("shrink-0 text-[10px]", flagBadgeClass(lesson.technique))}
                  >
                    {lesson.technique}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-[11px] text-primary">@{lesson.username}</p>
                    <p className="truncate text-muted-foreground">“{lesson.snippet}”</p>
                  </div>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    ×{lesson.hits} · {formatDistanceToNow(new Date(lesson.lastSeenAt), { addSuffix: true })}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No security lessons yet — when viewers try prompt injection / fake-mod tricks, the brain
              remembers and refuses consistently.
            </p>
          )}
        </CardContent>
      </Card>

      {data ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="font-mono text-sm uppercase tracking-wider">Routing Mix (last 500)</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 text-xs md:grid-cols-3">
            {(
              [
                ["byModel", "Models"],
                ["byProvider", "Providers"],
                ["byStatus", "Statuses"],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <p className="mb-2 font-mono text-[10px] uppercase text-muted-foreground">{label}</p>
                <div className="space-y-1">
                  {data.stats[key].length === 0 ? (
                    <p className="text-muted-foreground">—</p>
                  ) : (
                    data.stats[key].map(([name, count]) => (
                      <div key={name} className="flex items-center justify-between gap-2 font-mono">
                        <span className="truncate text-foreground/80">{name || "—"}</span>
                        <span className="text-primary">{count}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * AI News Digest (v29.12) — the on-demand answer pool for the stream's most
 * common research question ("bugün yapay zekada ne var?"). Built Exa-first
 * (falls back to z-ai) with a 30-min cache + URL dedup ledger, so VYCE can
 * pull today's reality at zero marginal search spend. VYCE reads this digest
 * whenever a viewer asks for daily news — no more answering from stale priors.
 */
type DigestPayload = {
  ok: boolean;
  provider: string;
  builtAt: string;
  items: Array<{ title: string; url: string; summary: string; date: string; source: string }>;
  freshCount: number;
  error: string;
};

function NewsDigestCard() {
  const digest = useQuery<{ ok: boolean; digest: DigestPayload }>({
    queryKey: ["exa-digest"],
    queryFn: async () => {
      const res = await fetch("/api/exa", { cache: "no-store" });
      if (!res.ok) throw new Error("digest unavailable");
      return res.json();
    },
    refetchInterval: 120_000,
  });

  const d = digest.data?.digest ?? null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="font-mono text-sm uppercase tracking-wider">
            AI News Digest — VYCE&apos;s daily answer pool
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Exa-first (30 min cache, deduped). Viewers asking &quot;bugün ne var&quot; get THIS, not
            stale model priors.
          </p>
        </div>
        {d ? (
          <Badge variant="outline" className={cn("font-mono", d.ok ? "border-primary/40 text-primary" : "border-destructive/50 text-destructive")}>
            {d.ok ? d.provider.toUpperCase() : "ERROR"}
            {d.builtAt ? ` · ${formatDistanceToNow(new Date(d.builtAt), { addSuffix: true })}` : ""}
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent>
        {digest.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : d?.ok && d.items?.length ? (
          <ul className="max-h-64 space-y-2 overflow-y-auto pr-1 text-xs leading-relaxed">
            {d.items.slice(0, 8).map((item, i) => (
              <li key={`${item.url}-${i}`} className="border-b border-border/40 pb-2 last:border-0 last:pb-0">
                <a href={item.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                  {item.title}
                </a>
                <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                  [{item.source}
                  {item.date ? ` · ${item.date}` : ""}]
                </span>
                {item.summary ? (
                  <p className="mt-0.5 line-clamp-2 text-muted-foreground">{item.summary}</p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            {d && !d.ok ? `Digest error: ${d.error?.slice(0, 100) || "no items"}` : "No digest yet — arm the Exa key in Connectors to enable the Exa-first tier."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
