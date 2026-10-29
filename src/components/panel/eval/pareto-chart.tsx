"use client";

import {
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RsiRunRow } from "./api";

/**
 * Pareto scatter — one point per COMPLETED run: x = costUnits, y =
 * compositeScore, colored by variant. Only done runs are plotted (a
 * queued/running/error run has no honest point). Empty state is explicit:
 * "no completed runs yet" — never a fabricated axis.
 */

export function ParetoChart({ runs }: { runs: RsiRunRow[] }) {
  const completed = runs.filter((r) => r.status === "done" && r.costUnits !== null && r.compositeScore !== null);
  const data = completed.map((r) => ({
    x: Number((r.costUnits ?? 0).toFixed(2)),
    y: Number((r.compositeScore ?? 0).toFixed(4)),
    variant: r.variant,
    label: `${r.variant} ${r.id.slice(-6)} pass ${(100 * (r.passRate ?? 0)).toFixed(0)}%`,
  }));
  const baseline = data.filter((d) => d.variant === "baseline");
  const candidate = data.filter((d) => d.variant === "candidate");

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="font-mono text-sm">
          Pareto view — composite score vs cost units (completed runs only)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground" role="note">
            No completed runs yet — launch a battery in Suites &amp; Runs and this chart fills with live-measured points.
          </p>
        ) : (
          <div className="h-64 w-full" role="img" aria-label="Scatter plot of cost units versus composite score by variant">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 8, right: 12, bottom: 16, left: -8 }}>
                <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.25} />
                <XAxis
                  type="number"
                  dataKey="x"
                  name="cost units"
                  stroke="var(--muted-foreground)"
                  fontSize={11}
                  tickLine={false}
                  label={{ value: "cost units (1.0·tokensAvg + 0.5·p95s/1000)", position: "insideBottom", offset: -8, fontSize: 10 }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name="composite score"
                  stroke="var(--muted-foreground)"
                  fontSize={11}
                  tickLine={false}
                  domain={[0, 1]}
                />
                <ZAxis range={[64, 64]} />
                <Tooltip
                  cursor={{ strokeDasharray: "3 3" }}
                  contentStyle={{ fontSize: 11, fontVariantNumeric: "tabular-nums" }}
                  formatter={(_value, _name, item) => {
                    const point = item.payload as { label: string };
                    return [point.label, "run"];
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Scatter name="baseline" data={baseline} fill="#10b981" fillOpacity={0.55} />
                <Scatter name="candidate" data={candidate} fill="#f59e0b" fillOpacity={0.75} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
