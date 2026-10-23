"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Toaster } from "@/components/ui/sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  CloudUpload,
  ExternalLink,
  Github,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";

/**
 * Task 10-c — snapshot durability card (GitHub snapshot chain control).
 *
 * Honest states only, driven by GET /api/backup/status:
 *   OK        — last push time + short head hash + repo link + run button
 *   NEVER RUN — no .zscripts/backup-state.json yet
 *   FAILED    — push-failed or scan-failed, with the real reason
 *   NO_TOKEN  — ops/vault/github.token missing: honest device-flow CTA
 *   RUNNING   — POST /api/backup/run in flight (spinner, controls disabled)
 *
 * P7: no token value is ever requested, stored or rendered here — the card
 * only ever sees a boolean `tokenPresent`. Log tails are server-scrubbed.
 *
 * Note on toasts: the task mandates sonner; the root layout mounts only the
 * radix <Toaster/> and layout edits are outside this task's file scope, so the
 * sonner <Toaster/> is mounted once at this card's root instead.
 */

type BackupStatus = {
  ok: boolean;
  lastResult: "ok" | "failed" | "scan-failed" | "no-token" | "diverged" | "never" | string;
  lastAt?: string;
  head?: string;
  tag?: string;
  lastAttemptAt?: string;
  tokenPresent: boolean;
  remoteConfigured: boolean;
  remote: string;
  recentLog?: string[];
};

type RunResponse = {
  ok: boolean;
  lastResult?: BackupStatus["lastResult"];
  skipped?: boolean;
  exitCode?: number;
  message?: string;
  error?: { code: string; message: string };
};

const STATUS_KEY = ["backup", "status"] as const;

async function fetchBackupStatus(): Promise<BackupStatus> {
  const res = await fetch("/api/backup/status", { cache: "no-store" });
  if (res.status === 401) throw new Error("Panel session expired — sign in again.");
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(json?.error?.message ?? "Backup status unavailable");
  }
  return res.json() as Promise<BackupStatus>;
}

export function DurabilityCard() {
  const queryClient = useQueryClient();

  const status = useQuery<BackupStatus>({
    queryKey: STATUS_KEY,
    queryFn: fetchBackupStatus,
    refetchInterval: 30_000,
  });

  const run = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/backup/run", { method: "POST" });
      const json = (await res.json().catch(() => null)) as RunResponse | null;
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error?.message ?? `Backup run failed (HTTP ${res.status})`);
      }
      return json;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: STATUS_KEY, exact: true });
    },
    onSuccess: (data) => {
      if (data.skipped) {
        toast.info("Backup skipped — nothing new", { description: data.message });
      } else if (data.lastResult === "ok") {
        toast.success("Snapshot pushed", { description: data.message });
      } else {
        toast.error("Backup did not push", { description: data.message });
      }
    },
    onError: (e: Error) => toast.error("Backup run failed", { description: e.message }),
  });

  const d = status.data;
  const running = run.isPending;
  const tokenMissing = d?.tokenPresent === false;
  const lastResult = d?.lastResult;
  const failed =
    lastResult === "failed" || lastResult === "scan-failed" || lastResult === "diverged";
  const okState = lastResult === "ok";
  const neverState = !okState && !failed && !tokenMissing; // "never" (or unknown) + token present

  const stateLabel = running
    ? "RUNNING"
    : tokenMissing
      ? "NO_TOKEN"
      : failed
        ? "FAILED"
        : okState
          ? "OK"
          : "NEVER RUN";

  const stateBadgeClass = running || tokenMissing
    ? "border-accent/60 text-accent"
    : failed
      ? "border-destructive/50 text-destructive"
      : okState
        ? "border-primary/40 text-primary"
        : "text-muted-foreground";

  return (
    <Card>
      {/* Sonner toaster (see note above) — scoped to this card per task file scope. */}
      <Toaster position="bottom-right" closeButton />

      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 font-mono">
            <Github className="size-5 text-primary" aria-hidden="true" />
            Snapshot durability
            <span className="text-xs font-normal text-muted-foreground">GitHub · 10-c</span>
          </CardTitle>
          <CardDescription>
            Sanitized snapshot chain pushed fast-forward-only to{" "}
            <a
              href={d?.remote ?? "https://github.com/specimba/NEXUSbot"}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 underline decoration-dotted underline-offset-2 hover:text-foreground"
              aria-label="Open the public snapshot repository on GitHub (opens in a new tab)"
            >
              specimba/NEXUSbot
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
            . Fail-closed secret scan; upload/, db/ and the vault never leave the sandbox.
          </CardDescription>
        </div>
        {status.isLoading ? (
          <Skeleton className="h-6 w-28 rounded-full" />
        ) : (
          <Badge
            variant="outline"
            aria-label={`Backup state: ${stateLabel.toLowerCase()}`}
            className={cn("shrink-0 font-mono text-[10px]", stateBadgeClass)}
          >
            {stateLabel}
          </Badge>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {status.isLoading ? (
          <div className="space-y-3" aria-hidden="true">
            <Skeleton className="h-16 w-full rounded-md" />
            <Skeleton className="h-11 w-full rounded-md" />
            <Skeleton className="h-11 w-40 rounded-md" />
          </div>
        ) : status.isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3" role="alert">
            <p className="text-sm text-destructive">{(status.error as Error).message}</p>
            <Button
              variant="outline"
              className="mt-3 min-h-11 font-mono"
              onClick={() => void status.refetch()}
              aria-label="Retry reading backup status"
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              Retry
            </Button>
          </div>
        ) : d && !d.remoteConfigured ? (
          <p className="text-sm text-destructive" role="alert">
            scripts/snapshot-backup.sh is missing — durability is disabled. Restore the script first.
          </p>
        ) : (
          <>
            {/* NO_TOKEN — honest CTA explaining the device-flow step (P7: no token input here). */}
            {tokenMissing && (
              <div className="rounded-md border border-accent/50 bg-accent/10 p-3">
                <p className="flex items-center gap-2 font-mono text-xs text-accent" role="alert">
                  <KeyRound className="size-4" aria-hidden="true" />
                  NO_TOKEN — snapshot pushes are locked
                </p>
                <p className="mt-2 text-sm text-foreground">
                  The backup script refuses to run until a GitHub token exists at
                  <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    ops/vault/github.token
                  </code>
                  . Complete the one-time GitHub device flow (Connectors tab → GitHub → Connect):
                  GitHub shows a short code, you approve it in the browser, and the minted token is
                  stored server-side only — it is never displayed, echoed or sent to this panel.
                  Then press &ldquo;Run backup now&rdquo;.
                </p>
              </div>
            )}

            {/* Status row */}
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/60 p-3"
              role="status"
              aria-live="polite"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-md border border-primary/25 bg-primary/10">
                  {failed || tokenMissing ? (
                    <ShieldAlert
                      className={cn("size-5", tokenMissing ? "text-accent" : "text-destructive")}
                      aria-hidden="true"
                    />
                  ) : (
                    <CloudUpload
                      className={cn("size-5", okState ? "text-primary" : "text-muted-foreground")}
                      aria-hidden="true"
                    />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Last snapshot push
                  </p>
                  {okState && d?.lastAt ? (
                    <p className="truncate font-mono text-sm text-primary" suppressHydrationWarning>
                      {d.lastAt}
                      {d.head && (
                        <>
                          {" · "}
                          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                            {d.head.slice(0, 12)}
                          </code>
                        </>
                      )}
                      {/* 12-d: immutable daily tag of the last successful push (script state). */}
                      {d.tag && <span className="text-xs text-muted-foreground"> · {d.tag}</span>}
                    </p>
                  ) : tokenMissing ? (
                    <p className="font-mono text-sm text-accent">no token — cannot push</p>
                  ) : failed ? (
                    <p className="font-mono text-sm text-destructive">
                      {lastResult === "scan-failed"
                        ? "secret scan failed — push aborted"
                        : lastResult === "diverged"
                          ? "remote diverged — push refused, no force push"
                          : "push failed — no force push, resolve manually"}
                    </p>
                  ) : (
                    <p className="font-mono text-sm text-muted-foreground">never run yet</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="size-11 shrink-0"
                  aria-label="Refresh backup status"
                  disabled={running}
                  onClick={() => void status.refetch()}
                >
                  <RefreshCw
                    className={cn("size-4", status.isFetching && "animate-spin")}
                    aria-hidden="true"
                  />
                </Button>
                <Button
                  className="min-h-11 min-w-44 font-mono"
                  aria-label="Run the sanitized snapshot backup now"
                  disabled={running || status.isLoading}
                  onClick={() => run.mutate()}
                >
                  {running ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      Running…
                    </>
                  ) : (
                    <>
                      <CloudUpload className="size-4" aria-hidden="true" />
                      Run backup now
                    </>
                  )}
                </Button>
              </div>
            </div>

            {failed && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
                <p className="font-mono text-xs text-destructive" role="alert">
                  {lastResult === "scan-failed"
                    ? "SCAN_FAILED"
                    : lastResult === "diverged"
                      ? "DIVERGED"
                      : "PUSH_FAILED"}
                </p>
                <p className="mt-1 text-sm text-destructive">
                  {lastResult === "scan-failed"
                    ? "The fail-closed secret scan found hits before any push. Resolve the flagged content, then run again."
                    : lastResult === "diverged"
                      ? "Remote main moved on its own and is no longer an ancestor of the local snapshot chain — the push was refused (fast-forward-only). The directive forbids force pushes — resolve the remote state manually, then run again."
                      : "The push was rejected (non-fast-forward). The directive forbids force pushes — resolve the remote state manually, then run again."}
                </p>
              </div>
            )}

            {/* Server-scrubbed log tail (defensive filter even though the log holds no secrets). */}
            <details className="rounded-md border border-border/60">
              <summary className="flex min-h-11 cursor-pointer select-none items-center gap-2 px-3 font-mono text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground">
                Backup log (last 8 lines)
              </summary>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-border/60 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {d.recentLog && d.recentLog.length > 0
                  ? d.recentLog.join("\n")
                  : "no log lines yet — run the backup to populate .zscripts/backup-log.txt"}
              </pre>
            </details>
          </>
        )}
      </CardContent>
    </Card>
  );
}
