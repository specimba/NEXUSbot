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
