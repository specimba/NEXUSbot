"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PlugZap } from "lucide-react";

const QUEUED = [
  { service: "GitHub", task: "T-202 · OAuth 2.0 web-flow (never PAT)" },
  { service: "Supabase", task: "T-203 · Brain Cortex Mgmt API + health" },
  { service: "Upstash", task: "T-204 · REST streams (XADD/XREADGROUP)" },
  { service: "Hyperbrowser", task: "T-205 · REST + CDP sessions" },
  { service: "Webshare", task: "T-206 · proxy pool, probe-first" },
] as const;

/**
 * PLACEHOLDER (honest): connector cards land one-by-one as wave-2 tasks are
 * verified and committed. This screen disappears when the last card is wired.
 */
export function ConnectorsTab() {
  return (
    <div className="space-y-4">
      <Card className="border-dashed">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 font-mono">
            <PlugZap className="size-5 text-primary" aria-hidden="true" />
            Connectors — wave-2 in progress
          </CardTitle>
          <CardDescription>
            Each connector appears here once its build is verified and committed. No fake
            &ldquo;connected&rdquo; states.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {QUEUED.map((c) => (
            <div
              key={c.service}
              className="flex items-center justify-between gap-2 rounded-md border border-border/60 p-3"
            >
              <div>
                <p className="font-mono text-sm">{c.service}</p>
                <p className="text-xs text-muted-foreground">{c.task}</p>
              </div>
              <Badge variant="outline" className="font-mono text-[10px] text-accent">
                QUEUED
              </Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
