"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { storeSessionToken } from "@/lib/client-auth";
import { Eye, TerminalSquare } from "lucide-react";

type LoginGateProps = {
  passwordConfigured: boolean;
  sessionCheckFailed?: boolean;
};

export function LoginGate({ passwordConfigured, sessionCheckFailed }: LoginGateProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<string | null>(null);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const revealRecovery = async () => {
    setRecoveryLoading(true);
    try {
      const res = await fetch("/api/auth/recovery", { cache: "no-store" });
      const body = (await res.json()) as { password?: string | null; visible?: boolean };
      setRecovery(body.password ?? null);
      if (!body.password) {
        toast({
          title: "No recovery value",
          description: "On-screen reveal is disabled or unset — see docs/runbook.md §0.",
        });
      }
    } catch {
      setRecovery(null);
      toast({ title: "Reveal failed", description: "Could not read the recovery value.", variant: "destructive" });
    } finally {
      setRecoveryLoading(false);
    }
  };

  const login = useMutation({
    mutationFn: async (pwd: string) => {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwd }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(body?.error?.message ?? `Login failed (${res.status})`);
      }
      return (await res.json()) as { ok: boolean; token?: string };
    },
    onSuccess: (data) => {
      setError(null);
      setPassword("");
      // Persist the Bearer fallback — preview iframes drop SameSite=Lax cookies.
      if (data.token) storeSessionToken(data.token);
      void queryClient.invalidateQueries({ queryKey: ["session"] });
      toast({ title: "Signed in", description: "Welcome back, speci." });
    },
    onError: (e: Error) => {
      setError(e.message);
      toast({ title: "Sign-in failed", description: e.message, variant: "destructive" });
    },
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm border-border/70">
        <CardHeader className="items-center text-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-lg border border-primary/30 bg-primary/10">
            <TerminalSquare className="size-6 text-primary" aria-hidden="true" />
          </div>
          <CardTitle className="font-mono text-lg tracking-widest text-primary text-glow">
            NEXUS OS
          </CardTitle>
          <CardDescription>Owner-only control panel</CardDescription>
        </CardHeader>
        <CardContent>
          {!passwordConfigured && (
            <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              PANEL_PASSWORD is not set on the server. Run{" "}
              <code className="font-mono">scripts/ensure-env.sh</code> and restart the dev server.
            </p>
          )}
          {sessionCheckFailed && (
            <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              Session check failed — the API may be restarting. Try again shortly.
            </p>
          )}
          {recovery && (
            <div className="mb-3 rounded-md border border-primary/40 bg-primary/10 p-2 text-xs">
              <p className="mb-1 font-semibold text-primary">Recovery password</p>
              <p className="break-all font-mono text-[13px] leading-relaxed">{recovery}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Copy it, sign in, then rotate in Settings → Panel access.
              </p>
            </div>
          )}
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              login.mutate(password);
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="panel-password">Panel password</Label>
              <Input
                id="panel-password"
                type="password"
                inputMode="text"
                autoComplete="current-password"
                required
                minLength={1}
                className="h-11 font-mono"
                placeholder="••••••••••••"
                aria-label="Panel password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="h-11 w-full font-mono" disabled={login.isPending}>
              {login.isPending ? "Authenticating…" : "Sign in"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-9 w-full font-mono text-xs text-muted-foreground"
              onClick={revealRecovery}
              disabled={recoveryLoading}
            >
              <Eye className="mr-1 size-3.5" aria-hidden="true" />
              {recoveryLoading ? "Reading…" : "Locked out? Show recovery password"}
            </Button>
          </form>
          <p className="mt-4 text-center text-[11px] leading-relaxed text-muted-foreground">
            The password is stored durably in the panel database — it survives sandbox
            resets. The button above reveals the current recovery copy on this screen,
            so a reset can never lock you out again. Rotate in Settings → Panel access.{" "}
            See <code className="font-mono">docs/runbook.md</code> §0.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
