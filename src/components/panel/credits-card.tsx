"use client";

import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
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
 * Honest states only, driven by GET /api/usage:
 *   loading → skeleton · error → retry box (never fake data) · empty → honest
 *   neutral empty state · data → per-@username ledger + totals.
 */

type UsageByUserRow = { userHandle: string; credits: number; count: number };
type UsageModelRow = { model: string; count: number };
type UsageResponse = {
  ok: boolean;
  image: { byUser: UsageByUserRow[]; totalCredits: number; totalCount: number };
  llm: { todayCalls: number; todayModels: UsageModelRow[]; note: string };
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

export function CreditsCard() {
  const usage = useQuery<UsageResponse>({
    queryKey: ["usage", "credits"],
    queryFn: fetchUsage,
    refetchInterval: 30_000,
  });

  const d = usage.data;

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
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge
                  variant="outline"
                  className="font-mono text-[10px] text-muted-foreground"
                  aria-label={`LLM calls today: ${d.llm.todayCalls}`}
                >
                  {d.llm.todayCalls} calls today
                </Badge>
                {d.llm.todayModels.map((m) => (
                  <Badge
                    key={m.model}
                    variant="outline"
                    className={cn("max-w-44 font-mono text-[10px] text-muted-foreground")}
                    aria-label={`Model ${m.model}: ${m.count} calls today`}
                  >
                    <span className="truncate">{m.model}</span>
                    <span className="shrink-0 opacity-70">×{m.count}</span>
                  </Badge>
                ))}
              </div>
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
