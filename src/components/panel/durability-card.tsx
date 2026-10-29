"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Toaster } from "@/components/ui/sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  Check,
  CloudUpload,
  Copy,
  Download,
  ExternalLink,
  Github,
  KeyRound,
  Link2,
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

/** v29.13 — the owner's working "Download workspace": source-only zip with a
 * RECOVERY.txt (panel password) inside. Replaces the platform's failing
 * full-workspace archive.
 *
 * v29.15 — the embedded preview iframe can SILENTLY swallow programmatic
 * downloads (sandboxed frames without allow-downloads block <a download>
 * clicks with no error and no toast — exactly the "button not responsive"
 * report). So the flow is now:
 *   1. POST /api/backup/workspace → mint a ONE-TIME download token (5 min).
 *   2. Try the automatic blob download (works when the context allows it).
 *   3. ALWAYS render a fallback panel with a REAL anchor link + a copyable
 *      URL that downloads with NO cookie at all — paste it into any tab.
 */
type PreparedDownload = {
  url: string;
  filename: string;
  expiresAt: number;
};

async function requestWorkspaceDownload(): Promise<PreparedDownload> {
  const res = await fetch("/api/backup/workspace", {
    method: "POST",
    cache: "no-store",
  });
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    url?: string;
    filename?: string;
    expiresInSec?: number;
    error?: { message?: string };
  } | null;
  if (!res.ok || !body?.ok || !body.url) {
    throw new Error(body?.error?.message ?? `Export failed (HTTP ${res.status})`);
  }
  return {
    url: body.url,
    filename: body.filename ?? `NEXUS-OS-source-${new Date().toISOString().slice(0, 10)}.zip`,
    expiresAt: Date.now() + (body.expiresInSec ?? 300) * 1000,
  };
}

/** Best-effort automatic save — resolves even when the frame blocks it
 * (a blocked <a download>.click() throws nothing, which is the whole bug). */
function tryAutomaticDownload(prepared: PreparedDownload): void {
  try {
    const a = document.createElement("a");
    a.href = prepared.url;
    a.download = prepared.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    // Silent by design — the fallback panel below is the guaranteed path.
  }
}

/** True when the panel is rendered inside the platform's embedded preview
 * frame — the context that silently swallows file downloads. Cross-origin
 * frames throw on window.self access; catching means we ARE framed. */
function detectIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

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

  // Iframe detection happens at click time (event handler — no effect, no
  // hydration mismatch): before the first download there is nothing to show.
  const [inIframe, setInIframe] = useState(false);
  const [prepared, setPrepared] = useState<PreparedDownload | null>(null);
  const [copied, setCopied] = useState(false);

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
        // Description carries the real reason (content-unchanged OR 30-min push throttle).
        toast.info("Backup skipped", { description: data.message });
      } else if (data.lastResult === "ok") {
        toast.success("Snapshot pushed", { description: data.message });
      } else {
        toast.error("Backup did not push", { description: data.message });
      }
    },
    onError: (e: Error) => toast.error("Backup run failed", { description: e.message }),
  });

  const exportWorkspace = useMutation({
    mutationFn: requestWorkspaceDownload,
    onSuccess: (data) => {
      const framed = detectIframe();
      setInIframe(framed);
      setPrepared(data);
      setCopied(false);
      tryAutomaticDownload(data);
      toast.success("Download ready", {
        description: framed
          ? "The embedded preview often blocks file saves — if nothing landed, use the link panel below."
          : "If the file did not appear, use the fallback link in the panel below.",
      });
    },
    onError: (e: Error) => toast.error("Workspace export failed", { description: e.message }),
  });
  const exporting = exportWorkspace.isPending;

  const absoluteDownloadUrl = prepared
    ? typeof window !== "undefined"
      ? new URL(prepared.url, window.location.origin).toString()
      : prepared.url
    : "";

  async function copyDownloadLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(absoluteDownloadUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_500);
    } catch {
      // Clipboard blocked — the input below is selectable as the fallback.
      const input = document.getElementById("nexus-download-link") as HTMLInputElement | null;
      input?.select();
      document.execCommand?.("copy");
      setCopied(true);
      setTimeout(() => setCopied(false), 2_500);
    }
  }

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
                      {/* 12-d: immutable per-run tag of the last successful push (script state). */}
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
              <div className="flex flex-wrap items-center gap-1">
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
                  variant="outline"
                  className="min-h-11 font-mono"
                  aria-label="Download the source workspace as a zip (includes RECOVERY.txt with the panel password)"
                  disabled={exporting}
                  onClick={() => exportWorkspace.mutate()}
                >
                  {exporting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      Zipping…
                    </>
                  ) : (
                    <>
                      <Download className="size-4" aria-hidden="true" />
                      Download workspace
                    </>
                  )}
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

            {/* v29.15 — ALWAYS-VISIBLE download fallback: a real anchor (not a
                programmatic blob) plus a cookie-free one-time URL. This is the
                guaranteed delivery path when the preview iframe swallows
                downloads silently. */}
            {prepared && (
              <div
                className="rounded-md border border-primary/30 bg-primary/5 p-3"
                role="region"
                aria-label="Workspace download fallback link"
              >
                <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-wide text-primary">
                  <Download className="size-4" aria-hidden="true" />
                  Download ready — {prepared.filename}
                </p>
                {inIframe ? (
                  <p className="mt-2 text-sm text-foreground">
                    You are viewing the panel inside the <strong>embedded preview</strong>, which can
                    silently block file downloads. Two guaranteed paths:
                    <span className="mt-1 block">
                      1. Click <strong>&ldquo;Open in New Tab&rdquo;</strong> above the preview, then press
                      &ldquo;Download workspace&rdquo; there — or
                    </span>
                    <span className="block">2. copy the link below and paste it into any browser tab.</span>
                  </p>
                ) : (
                  <p className="mt-2 text-sm text-foreground">
                    If the automatic download did not start, click the button below or paste the link
                    into a browser tab (works without sign-in).
                  </p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <a
                    href={prepared.url}
                    download={prepared.filename}
                    className="inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-4 py-2 font-mono text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                    aria-label="Save the workspace zip now"
                  >
                    <Download className="size-4" aria-hidden="true" />
                    Save zip
                  </a>
                  <Button
                    variant="outline"
                    className="min-h-11 font-mono"
                    onClick={() => void copyDownloadLink()}
                    aria-label="Copy the one-time download link"
                  >
                    {copied ? (
                      <Check className="size-4 text-primary" aria-hidden="true" />
                    ) : (
                      <Copy className="size-4" aria-hidden="true" />
                    )}
                    {copied ? "Copied" : "Copy link"}
                  </Button>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Link2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <input
                    id="nexus-download-link"
                    readOnly
                    value={absoluteDownloadUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    className="min-w-0 flex-1 rounded border border-border/60 bg-background px-2 py-1.5 font-mono text-[11px] text-muted-foreground"
                    aria-label="One-time workspace download URL (expires in 5 minutes)"
                  />
                </div>
                <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                  Single-use link, valid 5 minutes. Zip = clean source + RECOVERY.txt (panel
                  password) — never .env, db, node_modules or vault files.
                </p>
              </div>
            )}

            {/* Server-scrubbed log tail (defensive filter even though the log holds no secrets). */}
            <details className="rounded-md border border-border/60">
              <summary className="flex min-h-11 cursor-pointer select-none items-center gap-2 px-3 font-mono text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground">
                Backup log (last 8 lines)
              </summary>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-border/60 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {d?.recentLog && d.recentLog.length > 0
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
