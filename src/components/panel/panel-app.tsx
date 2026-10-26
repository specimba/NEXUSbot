"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { LoginGate } from "./login-gate";
import { PanelShell } from "./panel-shell";

type SessionInfo = {
  ok: boolean;
  authenticated: boolean;
  passwordConfigured: boolean;
};

export function PanelApp() {
  const { data, isLoading, isError } = useQuery<SessionInfo>({
    queryKey: ["session"],
    queryFn: async () => {
      const res = await fetch("/api/auth/session", { cache: "no-store" });
      if (!res.ok) throw new Error("session check failed");
      return (await res.json()) as SessionInfo;
    },
  });

  // Auto-publish the CURRENT panel origin so the GitHub-hosted OBS bridge
  // (obs.html) always points at the live panel after every address rotation.
  // Fire-and-forget: the server compares + skips when unchanged; a 401 (dead
  // session) is silently ignored — the next authenticated load publishes.
  useEffect(() => {
    if (!data?.authenticated) return;
    const origin = window.location.origin;
    void fetch("/api/obs/publish-origin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origin }),
    }).catch(() => undefined);
  }, [data?.authenticated]);

  if (isLoading) {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background"
        aria-live="polite"
        aria-busy="true"
      >
        <div className="size-8 animate-pulse rounded-full bg-primary/25" />
        <p className="font-mono text-xs tracking-widest text-muted-foreground">
          NEXUS OS · checking session…
        </p>
      </div>
    );
  }

  if (isError || !data) {
    return <LoginGate passwordConfigured={true} sessionCheckFailed />;
  }

  return data.authenticated ? (
    <PanelShell />
  ) : (
    <LoginGate passwordConfigured={data.passwordConfigured} />
  );
}
