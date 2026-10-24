"use client";

import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { Coins, Cpu, Image as ImageIcon, RefreshCw } from "lucide-react";

/**
 * Task 13-c — "Image credits" card (owner-facing tile for the credit doctrine).
 *
 * OWNER'S CREDIT DOCTRINE (encoded in the UsageEvent schema + /api/usage):
 *   - Image credits (grok-imagine creations) are the ONLY per-user surfaced
 *     number — a print shop charges per print, not per electricity. Surfaced
 *     per @username, never in currency.
 *   - LLM usage is internal telemetry only: totals + model chips, NO per-user
 *     attribution, NO currency. The API's own `note` string is rendered as-is.
 *
 * R18-d — telemetry truth: the internal LLM section is now fully traceable.
 * Headline shows today's calls split ok/failed; per-model chips carry the
 * ok/failed split; "Recent activity" lists the last 10 ledger rows with
 * timestamp, model, credential source, egress, ok/failed badge, error code
 * and latency — every number traces to a real UsageEvent row, so real
 * telemetry can never look like mock data again.
 *
 * Honest states only, driven by GET /api/usage:
 *   loading → skeleton · error → retry box (never fake data) · empty → honest
 *   neutral empty state · data → per-@username ledger + totals.
 */

type UsageByUserRow = { userHandle: string; credits: number; count: number };
type UsageModelRow = { model: string; count: number; ok: number; failed: number };
type UsageRecentRow = {
  ts: string; // ISO — full row timestamp (title tooltip keeps it inspectable)
  model: string;
  ok: boolean;
  latencyMs: number | null;
  source: string | null; // credential source: vault | supabase-edge-relay | groq | custom:<slug>
  role: string | null;
  egress: string | null; // direct | proxy
  error: string | null; // static error code only (never message bodies)
};
type UsageResponse = {
  ok: boolean;
  image: { byUser: UsageByUserRow[]; totalCredits: number; totalCount: number };
  llm: {
    todayCalls: number;
    todayOk: number;
    todayFailed: number;
    todayModels: UsageModelRow[];
    recent: UsageRecentRow[];
    note: string;
  };
};

async function fetchUsage(): Promise<UsageResponse> {
  const res = await fetch("/api/usage", { cache: "no-store" });
  if (res.status === 401) throw new Error("Panel session expired — sign in again.");
  const json = (await res.json().catch(() => null)) as
    | (UsageResponse & { error?: { message?: string } })
    | null;
  if (!res.ok || !json || json.ok !== true || !json.image || !json.llm) {
    // Honest failure — surface the API's own message when it has one, never fake data.
    throw new Error(json?.error?.message ?? "Usage ledger unavailable");
  }
  return json;
}

/**
 * Credential-source chip: the brain's vyce path stores "vault" or
 * "supabase-edge-relay" (both mean the Vyce key chain); groq rows carry "groq";
 * custom providers carry "custom:<slug>". Chip shows the readable name, the
 * title tooltip keeps the raw stored source for full traceability.
 */
function sourceChip(source: string | null): { label: string; title: string } | null {
  if (!source) return null;
  const label =
    source === "vault" || source === "supabase-edge-relay"
      ? "vyce"
      : source;
  return { label, title: `credential source: ${source}` };
}

export function CreditsCard() {
  const usage = useQuery<UsageResponse>({
    queryKey: ["usage", "credits"],
    queryFn: fetchUsage,
    refetchInterval: 30_000,
  });

  const d = usage.data;

  // Defensive local reads (card + API ship together; fallbacks keep an older
  // API response rendering without crashing the panel).
  const todayCalls = d?.llm.todayCalls ?? 0;
  const todayOk = d?.llm.todayOk ?? 0;
  const todayFailed = d?.llm.todayFailed ?? 0;
  const todayModels = d?.llm.todayModels ?? [];
  const recentRows = (d?.llm.recent ?? []).slice(0, 10);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div className="min-w-0 space-y-1.5">
          <CardTitle className="flex items-center gap-2 font-mono">
            <ImageIcon className="size-5 shrink-0 text-primary" aria-hidden="true" />
            Image credits
            <span className="hidden text-xs font-normal text-muted-foreground sm:inline">
              grok-imagine
            </span>
          </CardTitle>
          <CardDescription>
            grok-imagine creations · charged per print, not per electricity
          </CardDescription>
        </div>
        {usage.isLoading ? (
          <Skeleton className="h-6 w-24 shrink-0 rounded-full" aria-hidden="true" />
        ) : d ? (
          <Badge
            variant="outline"
            className="shrink-0 font-mono text-[10px] text-primary"
            aria-label={`Total image credits charged: ${d.image.totalCredits}`}
          >
            {d.image.totalCredits} credits
          </Badge>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-4">
        {usage.isLoading ? (
          <div className="space-y-3" aria-hidden="true">
            <Skeleton className="h-11 w-full rounded-md" />
            <Skeleton className="h-11 w-full rounded-md" />
            <Skeleton className="h-11 w-40 rounded-md" />
          </div>
        ) : usage.isError ? (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3"
            role="alert"
          >
            <p className="text-sm text-destructive">{(usage.error as Error).message}</p>
            <Button
              variant="outline"
              className="mt-3 min-h-11 font-mono"
              onClick={() => void usage.refetch()}
              aria-label="Retry reading the usage ledger"
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              Retry
            </Button>
          </div>
        ) : d ? (
          <>
            {/* Per-@username image-credit ledger (the only per-user surface). */}
            {d.image.byUser.length > 0 ? (
              <div
                className="rounded-md border border-border/60"
                role="table"
                aria-label="Image credits per chat username"
              >
                <div
                  role="row"
                  className="flex items-center gap-3 border-b border-border/60 px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground"
                >
                  <span role="columnheader" className="min-w-0 flex-1">
                    Chat user
                  </span>
                  <span role="columnheader" className="w-16 shrink-0 text-right">
                    Credits
                  </span>
                  <span role="columnheader" className="w-20 shrink-0 text-right">
                    Prints
                  </span>
                </div>
                <div className="max-h-48 overflow-y-auto" aria-label="Per-username credit rows">
                  {[...d.image.byUser]
                    .sort((a, b) => b.credits - a.credits)
                    .map((row) => (
                      <div
                        key={row.userHandle}
                        role="row"
                        className="flex items-center gap-3 px-3 py-2.5"
                      >
                        <span
                          role="cell"
                          className="min-w-0 flex-1 truncate font-mono text-sm"
                          title={row.userHandle}
                        >
                          {row.userHandle.startsWith("@")
                            ? row.userHandle
                            : `@${row.userHandle}`}
                        </span>
                        <span
                          role="cell"
                          className="w-16 shrink-0 text-right font-mono text-sm text-primary"
                        >
                          {row.credits}
                        </span>
                        <span
                          role="cell"
                          className="w-20 shrink-0 text-right font-mono text-xs text-muted-foreground"
                        >
                          {row.count}
                        </span>
                      </div>
                    ))}
                </div>
                <div
                  role="row"
                  className="flex items-center gap-3 border-t border-border/60 px-3 py-2.5"
                >
                  <span
                    role="cell"
                    className="min-w-0 flex-1 truncate text-[11px] uppercase tracking-wide text-muted-foreground"
                  >
                    Total
                  </span>
                  <span
                    role="cell"
                    className="w-16 shrink-0 text-right font-mono text-sm font-semibold text-primary"
                  >
                    {d.image.totalCredits}
                  </span>
                  <span
                    role="cell"
                    className="w-20 shrink-0 text-right font-mono text-xs text-muted-foreground"
                  >
                    {d.image.totalCount}
                  </span>
                </div>
              </div>
            ) : (
              <p className="flex items-start gap-2 py-4 text-center text-sm text-muted-foreground">
                <Coins className="mt-0.5 size-4 shrink-0 opacity-60" aria-hidden="true" />
                <span>
                  No image creations yet. Credits appear here per @username when a chat user runs a
                  grok-imagine creation.
                </span>
              </p>
            )}

            {/* LLM usage — owner-internal telemetry ONLY. No per-user rows, no currency. */}
            <section
              aria-label="Internal LLM telemetry — monitoring only, not user billing"
              className="rounded-md border border-dashed border-border/60 p-3"
            >
              <p className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                <Cpu className="size-3.5 shrink-0" aria-hidden="true" />
                LLM usage (internal)
              </p>

              {recentRows.length === 0 && todayCalls === 0 ? (
                /* Honest empty state — the ledger is genuinely empty (no llm row was
                 * ever written), so there is nothing to attribute yet. */
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  No LLM calls recorded yet — rows appear the moment the panel brain
                  actually calls a provider. Counters only, never content.
                </p>
              ) : (
                <>
                  {/* Headline — every count is a real UsageEvent row (today, server-local). */}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Badge
                      variant="outline"
                      className="font-mono text-[10px] text-muted-foreground"
                      aria-label={`LLM calls today: ${todayCalls} (${todayOk} ok, ${todayFailed} failed)`}
                    >
                      <span>
                        {todayCalls} calls today · {todayOk} ok ·
                      </span>
                      <span className={cn(todayFailed > 0 && "text-destructive/80")}>
                        {todayFailed} failed
                      </span>
                    </Badge>
                    {todayModels.map((m) => (
                      <Badge
                        key={m.model}
                        variant="outline"
                        className="max-w-44 font-mono text-[10px] text-muted-foreground"
                        aria-label={`Model ${m.model}: ${m.count} calls today (${m.ok} ok, ${m.failed} failed)`}
                      >
                        <span className="truncate">{m.model}</span>
                        <span className="shrink-0 opacity-70">×{m.count}</span>
                        {m.failed > 0 && m.ok > 0 && (
                          <span className="shrink-0 opacity-70">· {m.ok} ok</span>
                        )}
                        {m.failed > 0 && (
                          <span className="shrink-0 text-destructive/80">
                            {m.ok === 0 ? "failed" : `· ${m.failed} failed`}
                          </span>
                        )}
                      </Badge>
                    ))}
                  </div>

                  {/* Recent activity — last 10 llm ledger rows, newest first. */}
                  <div className="mt-3">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Recent activity
                      <span className="ml-1 normal-case tracking-normal opacity-70">
                        (last {recentRows.length} ledger row{recentRows.length === 1 ? "" : "s"})
                      </span>
                    </p>
                    <ul
                      className="mt-1 max-h-96 divide-y divide-border/60 overflow-y-auto pr-1 [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar]:w-1.5"
                      aria-label="Recent LLM ledger rows — timestamps, models, sources and outcomes"
                    >
                      {recentRows.map((r, i) => {
                        const chip = sourceChip(r.source);
                        return (
                          <li
                            key={`${r.ts}-${i}`}
                            className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2"
                          >
                            <time
                              dateTime={r.ts}
                              suppressHydrationWarning
                              title={r.ts}
                              className="shrink-0 font-mono text-xs text-muted-foreground"
                            >
                              {format(new Date(r.ts), "HH:mm")}
                            </time>
                            <span
                              className="min-w-0 max-w-full truncate font-mono text-xs"
                              title={r.model}
                            >
                              {r.model}
                            </span>
                            {chip && (
                              <Badge
                                variant="secondary"
                                title={chip.title}
                                className="shrink-0 font-mono text-[10px]"
                              >
                                {chip.label}
                              </Badge>
                            )}
                            {r.egress && (
                              <span
                                className="shrink-0 font-mono text-[10px] text-muted-foreground"
                                title={`egress: ${r.egress}`}
                              >
                                {r.egress}
                              </span>
                            )}
                            <span className="ml-auto flex shrink-0 items-center gap-1.5">
                              {!r.ok && r.error && (
                                <span
                                  className="font-mono text-[10px] text-destructive/80"
                                  title={`error code: ${r.error}`}
                                >
                                  {r.error}
                                </span>
                              )}
                              <Badge
                                variant="outline"
                                className={cn(
                                  "font-mono text-[10px]",
                                  r.ok ? "text-muted-foreground" : "border-destructive/40 text-destructive/80",
                                )}
                              >
                                {r.ok ? "ok" : "failed"}
                              </Badge>
                              {r.latencyMs !== null && (
                                <span
                                  className="font-mono text-[10px] text-muted-foreground"
                                  title={`latency: ${r.latencyMs} ms`}
                                >
                                  {r.latencyMs} ms
                                </span>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </>
              )}

              {d.llm.note && (
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{d.llm.note}</p>
              )}
            </section>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
