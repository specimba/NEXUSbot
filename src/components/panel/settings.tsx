"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import type { BudgetRow } from "@/lib/types";

const BUDGET_LABELS: Record<string, string> = {
  "budget.daily.llmCalls": "LLM calls / day",
  "budget.daily.evalRuns": "Eval runs / day",
  "budget.daily.eventIngest": "Event ingests / day",
};

export function SettingsTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Draft holds only user-edited fields; server data remains the base truth.
  const [draft, setDraft] = useState<Record<string, string>>({});

  const budgets = useQuery<{ budgets: BudgetRow[] }>({
    queryKey: ["budgets"],
    queryFn: async () => {
      const res = await fetch("/api/settings", { cache: "no-store" });
      if (!res.ok) throw new Error("budgets unavailable");
      return res.json();
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      const payload = (budgets.data?.budgets ?? []).map((b) => ({
        key: b.key,
        value: Number(draft[b.key] ?? b.value),
      }));
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ budgets: payload }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(body?.error?.message ?? "Save failed");
      }
      return res.json();
    },
    onSuccess: () => {
      setDraft({});
      void queryClient.invalidateQueries({ queryKey: ["budgets"] });
      toast({ title: "Budgets saved" });
    },
    onError: (e: Error) =>
      toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Daily budgets (spend gates)
          </CardTitle>
          <CardDescription>
            Hard caps enforced in L3–L4 agent/eval phases. Zero external spend is the default
            posture; these caps are the circuit breakers.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {budgets.isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16 rounded-md" />
              ))}
            </div>
          ) : budgets.isError ? (
            <p className="text-sm text-destructive" role="alert">
              Budgets unavailable.
            </p>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              {budgets.data?.budgets.map((b) => (
                <div key={b.key} className="space-y-1.5">
                  <Label htmlFor={`budget-${b.key}`}>{BUDGET_LABELS[b.key] ?? b.key}</Label>
                  <Input
                    id={`budget-${b.key}`}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={1_000_000}
                    className="h-11 max-w-40 font-mono"
                    value={draft[b.key] ?? String(b.value)}
                    onChange={(e) => setDraft((v) => ({ ...v, [b.key]: e.target.value }))}
                    aria-label={BUDGET_LABELS[b.key] ?? b.key}
                  />
                </div>
              ))}
              <Button type="submit" className="min-h-11 font-mono" disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save budgets"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <PanelAccessCard />
      <SealCard />
    </div>
  );
}

/**
 * Panel access (v29.12) — durable password rotation. The password lives in the
 * panel DB (survives sandbox .env regeneration — the lockout bug this panel
 * once had); .env stays as the documented recovery channel.
 */
function PanelAccessCard() {
  const { toast } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");

  const rotate = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: { message?: string } }
        | null;
      if (!res.ok || !body?.ok) {
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      return body;
    },
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setRepeat("");
      toast({
        title: "Panel password updated",
        description: "Stored durably in the panel DB. Use the new password at the next sign-in.",
      });
    },
    onError: (e: Error) =>
      toast({ title: "Rotation failed", description: e.message, variant: "destructive" }),
  });

  const canSubmit =
    current.length > 0 && next.length >= 8 && next === repeat && !rotate.isPending;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Panel access
        </CardTitle>
        <CardDescription>
          The password is stored durably in the panel database and survives sandbox resets — even
          when <code className="font-mono text-[11px]">.env</code> is regenerated. The{" "}
          <code className="font-mono text-[11px]">.env</code> value (key{" "}
          <code className="font-mono text-[11px]">PANEL_PASSWORD</code>) remains the documented
          recovery channel.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) rotate.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="panel-pass-current">Current password</Label>
            <Input
              id="panel-pass-current"
              type="password"
              autoComplete="current-password"
              className="h-11 max-w-sm font-mono"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="panel-pass-new">New password (min 8 chars)</Label>
              <Input
                id="panel-pass-new"
                type="password"
                autoComplete="new-password"
                className="h-11 font-mono"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="panel-pass-repeat">Repeat new password</Label>
              <Input
                id="panel-pass-repeat"
                type="password"
                autoComplete="new-password"
                className="h-11 font-mono"
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
                aria-invalid={repeat.length > 0 && next !== repeat}
              />
              {repeat.length > 0 && next !== repeat ? (
                <p className="text-xs text-destructive">Passwords do not match.</p>
              ) : null}
            </div>
          </div>
          <Button type="submit" className="min-h-11 font-mono" disabled={!canSubmit}>
            {rotate.isPending ? "Updating…" : "Update password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Sandbox seal (v29.18, Task 25) — the cold-boot durability feature. The seal
 * is a passphrase-encrypted snapshot of the durability-critical state (.env
 * keys, vault credentials, widgets + variables, settings, ingest-token
 * hashes) written to .seal/nexus-seal.v1.json — a GIT-TRACKED file, so the
 * GitHub snapshot chain carries it through any sandbox reset. After a cold
 * boot wiped .env + the DB, one passphrase restores the running panel in
 * place (hot-applied env, upserted rows) instead of re-filling ten secrets.
 *
 * Honest threat model: the file rides a PUBLIC repo — its strength is exactly
 * the passphrase. Use a long one. Re-seal after every credential/widget
 * change; a stale seal restores stale state.
 */
type SealState = {
  ok: boolean;
  path: string;
  exists: boolean;
  meta: { sealedAt: string; counts: Record<string, number> } | null;
  error: string | null;
};

function SealCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [pass, setPass] = useState("");
  const [confirmRestore, setConfirmRestore] = useState(false);

  const state = useQuery<SealState>({
    queryKey: ["seal-state"],
    queryFn: async () => {
      const res = await fetch("/api/backup/seal", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const seal = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/backup/seal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase: pass }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: { message?: string } }
        | null;
      if (!res.ok || !body?.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      return body;
    },
    onSuccess: () => {
      setPass("");
      setConfirmRestore(false);
      void queryClient.invalidateQueries({ queryKey: ["seal-state"] });
      toast({
        title: "Seal created",
        description: "Encrypted state is ready for the snapshot chain. Re-seal after every credential or widget change.",
      });
    },
    onError: (e: Error) =>
      toast({ title: "Seal failed", description: e.message, variant: "destructive" }),
  });

  const unseal = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/backup/unseal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase: pass }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: { message?: string } }
        | null;
      if (!res.ok || !body?.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      return body;
    },
    onSuccess: () => {
      setPass("");
      setConfirmRestore(false);
      // Env keys + vault + widgets + settings may ALL have changed — drop the
      // entire query cache so every card refetches under the restored state.
      void queryClient.invalidateQueries();
      toast({
        title: "Restored from seal",
        description: "Env keys hot-applied, rows upserted. The next snapshot push carries the seal file.",
      });
    },
    onError: (e: Error) =>
      toast({ title: "Restore failed", description: e.message, variant: "destructive" }),
  });

  const meta = state.data?.meta ?? null;
  const counts = meta?.counts ?? null;
  const passReady = pass.length >= 12;
  const busy = seal.isPending || unseal.isPending;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Sandbox seal (cold-boot durability)
        </CardTitle>
        <CardDescription>
          A cold boot regenerates <code className="font-mono text-[11px]">.env</code> and wipes the
          DB — that is how today&apos;s password change + ten re-entered credentials happened. The
          seal is an AES-256-GCM file (git-tracked, rides the GitHub snapshot chain) holding the
          four critical env keys, the vault, widgets + variables, settings, and token hashes. Its
          strength IS the passphrase — use a long one. Re-seal after every change.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs font-mono" role="status">
          {state.isLoading ? (
            <Skeleton className="h-4 w-64" />
          ) : state.isError ? (
            <span className="text-destructive">Seal state unavailable.</span>
          ) : state.data?.exists && meta ? (
            <span>
              sealed {new Date(meta.sealedAt).toLocaleString()}
              {counts ? (
                <> · {counts.credentials} credentials · {counts.widgets} widgets · {counts.settings} settings · {counts.ingestTokens} tokens</>
              ) : null}
            </span>
          ) : (
            <span className="text-amber-600 dark:text-amber-500">
              No seal yet — the next cold boot wipes everything re-entered today.
            </span>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="seal-passphrase">Seal passphrase (min 12 chars)</Label>
          <Input
            id="seal-passphrase"
            type="password"
            autoComplete="off"
            className="h-11 max-w-sm font-mono"
            value={pass}
            onChange={(e) => {
              setPass(e.target.value);
              setConfirmRestore(false);
            }}
            aria-label="Seal passphrase"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            className="min-h-11 font-mono"
            disabled={!passReady || busy}
            onClick={() => seal.mutate()}
          >
            {seal.isPending ? "Sealing…" : "Seal now"}
          </Button>
          {state.data?.exists ? (
            confirmRestore ? (
              <Button
                type="button"
                variant="destructive"
                className="min-h-11 font-mono"
                disabled={!passReady || busy}
                onClick={() => unseal.mutate()}
              >
                {unseal.isPending ? "Restoring…" : "Confirm restore"}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 font-mono"
                disabled={!passReady || busy}
                onClick={() => setConfirmRestore(true)}
              >
                Restore from seal…
              </Button>
            )
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Restore hot-applies the sealed env keys to the running panel (no restart), re-derives the
          vault key cache, and upserts settings → credentials → tokens → widgets. Rows created
          after the seal survive (upsert merge).
        </p>
      </CardContent>
    </Card>
  );
}
