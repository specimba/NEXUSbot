"use client";

import { useCallback, useEffect, useState } from "react";

type State =
  | "pending"
  | "authorized"
  | "backup-ok"
  | "backup-failed"
  | "error";

interface StatusResp {
  state: State;
  userCode?: string;
  verificationUri?: string;
  expiresAt?: string;
  note?: string;
  backup?: { lastResult?: string; lastAt?: string; head?: string } | null;
  tokenPresent: boolean;
  remote: string;
}

const STATE_STYLES: Record<string, string> = {
  pending: "border-amber-700/40 bg-amber-950/30",
  authorized: "border-emerald-700/40 bg-emerald-950/30",
  "backup-ok": "border-emerald-700/40 bg-emerald-950/30",
  "backup-failed": "border-rose-700/40 bg-rose-950/30",
  error: "border-rose-700/40 bg-rose-950/30",
};

const STATE_TEXT: Record<string, string> = {
  pending: "text-amber-400",
  authorized: "text-emerald-400",
  "backup-ok": "text-emerald-400",
  "backup-failed": "text-rose-400",
  error: "text-rose-400",
};

export default function BackupTile() {
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/backup/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus((await res.json()) as StatusResp);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (!cancelled) await load();
    };
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(id);
    };
  }, [load]);

  const state = (status?.state ?? "pending") as State;
  const heading = `Durability · GitHub remote bootstrap`;

  const copyCode = async () => {
    if (!status?.userCode) return;
    try {
      await navigator.clipboard.writeText(status.userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <section
      aria-labelledby="durability"
      className={`mb-6 rounded-xl border p-5 ${STATE_STYLES[state] ?? "border-zinc-800 bg-zinc-900/50"}`}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 id="durability" className={`text-sm font-semibold ${STATE_TEXT[state] ?? "text-zinc-100"}`}>
          {heading}
        </h2>
        <span className="text-xs text-zinc-500">
          live · refreshes every 30s {error ? `· poll error: ${error}` : ""}
        </span>
      </div>

      {state === "pending" && (
        <div className="space-y-3 text-sm text-zinc-200">
          <p>
            The sandbox reset proved the risk: work that is not pushed dies with
            the sandbox. Approve the one-time GitHub device flow below to
            activate the public backup repo{" "}
            <span className="text-zinc-400">{status?.remote}</span> — snapshots
            then push automatically, sanitized and secret-scanned.
          </p>
          {status?.userCode ? (
            <div className="flex flex-wrap items-center gap-3">
              <a
                href={status.verificationUri ?? "https://github.com/login/device"}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white"
              >
                Open github.com/login/device
              </a>
              <button
                onClick={copyCode}
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 font-mono text-lg tracking-[0.3em] text-zinc-100 transition-colors hover:border-zinc-500"
                aria-label="Copy device code"
              >
                {status.userCode}
              </button>
              <span className="text-xs text-zinc-500">
                {copied ? "copied ✓" : "click code to copy"}
                {status.expiresAt
                  ? ` · refreshes automatically on expiry`
                  : ""}
              </span>
            </div>
          ) : (
            <p className="text-xs text-zinc-500">minting a fresh device code…</p>
          )}
        </div>
      )}

      {state === "authorized" && (
        <p className="text-sm text-zinc-200">
          Device flow authorized — running first sanitized snapshot…
        </p>
      )}

      {state === "backup-ok" && (
        <div className="text-sm text-zinc-200">
          <p>
            Backup active · last push {status?.backup?.lastAt ?? "—"} · head{" "}
            <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs">
              {status?.backup?.head?.slice(0, 12) ?? "—"}
            </code>{" "}
            · repo{" "}
            <a
              className="underline decoration-dotted hover:text-zinc-100"
              href={status?.remote}
              target="_blank"
              rel="noreferrer"
            >
              specimba/NEXUSbot
            </a>
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Sanitized snapshot chain on public main · upload/ + PNGs excluded ·
            secret scan fail-closed · no force push
          </p>
        </div>
      )}

      {(state === "backup-failed" || state === "error") && (
        <p className="text-sm text-zinc-200">
          State: {state} — {status?.note ?? "check .zscripts/backup-log.txt"}
        </p>
      )}
    </section>
  );
}
