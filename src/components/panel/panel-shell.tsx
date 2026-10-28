"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { clearSessionToken } from "@/lib/client-auth";
import { cn } from "@/lib/utils";
import {
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Moon,
  PlugZap,
  SlidersHorizontal,
  Sun,
  Radio,
  AppWindow,
  ScrollText,
} from "lucide-react";

/**
 * Tab registry (frozen order). G6 opened by owner directive 2026-10-29:
 * the Eval tab is now the RSI Lab (L3 frozen suites + L4 gated cycles).
 * The Widgets tab replaces the old Variables registry tab: widgets are what
 * viewers SEE — the {{namespace.field}} template dialect moves into the
 * bot-commands work where it actually executes.
 */
const TABS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "stream", label: "Stream", icon: Radio },
  { id: "pipeline", label: "Pipeline", icon: ScrollText },
  { id: "widgets", label: "Widgets", icon: AppWindow },
  { id: "connectors", label: "Connectors", icon: PlugZap },
  { id: "settings", label: "Settings", icon: SlidersHorizontal },
  { id: "eval", label: "Eval · RSI", icon: FlaskConical },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function PanelShell() {
  const [tab, setTab] = useState<TabId>("overview");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { resolvedTheme, setTheme } = useTheme();

  const logout = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (!res.ok) throw new Error("Logout failed");
      clearSessionToken();
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["session"] });
      toast({ title: "Signed out" });
    },
    onError: (e: Error) => {
      toast({ title: "Logout failed", description: e.message, variant: "destructive" });
    },
  });

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/70 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-2 px-4">
          <div className="flex items-center gap-2">
            <span
              className="size-2 rounded-full bg-primary shadow-[0_0_8px_rgba(16,185,129,0.8)]"
              aria-hidden="true"
            />
            <span className="sr-only">Server online</span>
            <span className="font-mono text-sm font-semibold tracking-[0.2em] text-primary text-glow">
              NEXUS OS
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              aria-label="Toggle light / dark theme"
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            >
              <Moon className="size-4 dark:hidden" aria-hidden="true" />
              <Sun className="hidden size-4 dark:block" aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              aria-label="Sign out"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              <LogOut className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
        <nav
          aria-label="Panel sections"
          className="mx-auto w-full max-w-5xl overflow-x-auto px-4 pb-2"
        >
          <div className="flex gap-1" role="tablist">
            {TABS.map(({ id, label, icon: Icon }) => {
              const active = tab === id;
              return (
                <button
                  key={id}
                  role="tab"
                  aria-selected={active}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setTab(id)}
                  className={cn(
                    "flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-mono transition-colors",
                    active
                      ? "border border-primary/30 bg-primary/15 text-primary"
                      : "border border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {label}
                </button>
              );
            })}
          </div>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        {tab === "overview" && <OverviewTab />}
        {tab === "stream" && <StreamTab />}
        {tab === "pipeline" && <PipelineTab />}
        {tab === "widgets" && <WidgetsTab />}
        {tab === "connectors" && <ConnectorsTab />}
        {tab === "settings" && <SettingsTab />}
        {tab === "eval" && <EvalTab />}
      </main>

      <footer className="mt-auto border-t border-border/70 bg-background/70 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-1 px-4 py-3 font-mono text-[11px] text-muted-foreground">
          <span>NEXUS OS · owner speci</span>
          <span>L0 stream · local-first · zero external spend</span>
        </div>
      </footer>
    </div>
  );
}

/* Tab contents are split below to keep this file focused on the shell. */

import { OverviewTab } from "./overview";
import { StreamTab } from "./stream";
import { PipelineTab } from "./pipeline";
import { WidgetsTab } from "./widgets";
import { ConnectorsTab } from "./connectors";
import { SettingsTab } from "./settings";
import { EvalTab } from "./eval/rsi-lab";
