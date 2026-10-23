"use client";

import { useQuery } from "@tanstack/react-query";
import { LoginGate } from "./login-gate";
import { PanelShell } from "./panel-shell";
import { installSessionAuthInterceptor } from "@/lib/client/session-token";

// Patch fetch at MODULE SCOPE (before any react-query/effect fetch fires):
// the preview panel renders this app inside a cross-site iframe where the
// session cookie is dropped, so same-origin /api/ requests must be able to
// present the session token as a bearer header.
installSessionAuthInterceptor();

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
