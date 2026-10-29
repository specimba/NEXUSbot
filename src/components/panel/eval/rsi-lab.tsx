"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { FlaskConical } from "lucide-react";
import { RsiOverviewTab } from "./overview-tab";
import { RsiResearchTab } from "./research-tab";
import { RsiSuitesRunsTab } from "./suites-runs-tab";
import { RsiCyclesTab } from "./cycles-tab";

/**
 * RSI LAB — v35.0 (experimental, owner directive 2026-10-29).
 *
 * Replaces the G6-locked placeholder. L3 frozen suites (configHash-sealed)
 * + L4 gated evolution cycles. Every number rendered in this tab is
 * live-measured [MEASURED]; nothing is synthetic; promotion requires the
 * owner human gate and deploy remains a manual Edge Cortex Deploy action.
 */
export function EvalTab() {
  const [inner, setInner] = useState<string>("overview");

  return (
    <div className="space-y-4">
      <Card className="border-primary/25 bg-primary/5">
        <CardContent className="flex flex-wrap items-center gap-2 p-4">
          <FlaskConical className="size-5 shrink-0 text-primary" aria-hidden="true" />
          <p className="min-w-0 flex-1 font-mono text-xs leading-relaxed text-foreground">
            RSI LAB · EXPERIMENTAL · L3 frozen suites v1.0 + L4 gated cycles · every number is live-measured
            <span className="text-primary"> [MEASURED]</span>; nothing synthetic; promotion requires the owner gate
          </p>
          <Badge variant="outline" className="shrink-0 border-accent/60 font-mono text-[10px] text-accent text-glow-amber">
            G4 + G6 PENDING
          </Badge>
        </CardContent>
      </Card>

      <Tabs value={inner} onValueChange={setInner} className="gap-4">
        <TabsList className="grid h-auto w-full grid-cols-2 sm:grid-cols-4" role="tablist">
          <TabsTrigger value="overview" className="min-h-11 font-mono text-xs" role="tab">
            Overview
          </TabsTrigger>
          <TabsTrigger value="research" className="min-h-11 font-mono text-xs" role="tab">
            Research
          </TabsTrigger>
          <TabsTrigger value="suites-runs" className="min-h-11 font-mono text-xs" role="tab">
            Suites &amp; Runs
          </TabsTrigger>
          <TabsTrigger value="cycles" className="min-h-11 font-mono text-xs" role="tab">
            Cycles
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <RsiOverviewTab />
        </TabsContent>
        <TabsContent value="research">
          <RsiResearchTab />
        </TabsContent>
        <TabsContent value="suites-runs">
          <RsiSuitesRunsTab />
        </TabsContent>
        <TabsContent value="cycles">
          <RsiCyclesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
