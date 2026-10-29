"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { parseJsonField } from "./api";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * GATE RESULTS panel — renders the cycle's gateResults JSON exactly as the
 * engine recorded it: G1/G2/G3/G5/G7 with real pass/fail numbers, G4/G6 with
 * honest PENDING tags (owner artifacts not authored — never faked green).
 */

type GateVerdict = { pass?: boolean; numbers?: Record<string, unknown>; note?: string };
type GateResults = {
  input?: { suites?: Array<Record<string, unknown>> };
  g1?: GateVerdict;
  g2?: GateVerdict;
  g3?: GateVerdict;
  g4?: { status?: string; note?: string };
  g5?: GateVerdict;
  g6?: { status?: string; note?: string };
  g7?: GateVerdict;
  allGreen?: boolean;
};

function GateChip({ id, label, pass, pending, note }: { id: string; label: string; pass?: boolean; pending?: boolean; note?: string }) {
  const state = pending ? "pending" : pass ? "pass" : "fail";
  return (
    <div
      className={cn(
        "flex min-h-11 items-center gap-2 rounded-md border px-3 py-2",
        state === "pass"
          ? "border-primary/40 bg-primary/10"
          : state === "fail"
            ? "border-destructive/50 bg-destructive/10"
            : "border-accent/50 bg-accent/10",
      )}
      aria-label={`Gate ${id} ${state}`}
    >
      <Badge
        variant="outline"
        className={cn(
          "shrink-0 font-mono text-[10px]",
          state === "pass"
            ? "border-primary/40 text-primary"
            : state === "fail"
              ? "border-destructive/50 text-destructive"
              : "border-accent/60 text-accent",
        )}
      >
        {id.toUpperCase()}
      </Badge>
      <div className="min-w-0">
        <p className="font-mono text-xs font-medium">{label}</p>
        {note ? <p className="truncate text-[11px] text-muted-foreground" title={note}>{note}</p> : null}
      </div>
      <span className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-wide">
        {state === "pass" ? (
          <span className="flex items-center gap-1 text-primary">
            <ShieldCheck className="size-3.5" aria-hidden="true" /> pass
          </span>
        ) : state === "fail" ? (
          <span className="flex items-center gap-1 text-destructive">
            <TriangleAlert className="size-3.5" aria-hidden="true" /> fail
          </span>
        ) : (
          <span className="text-accent">pending</span>
        )}
      </span>
    </div>
  );
}

function fmtNum(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(4)).toString() : String(v ?? "—");
}

export function GatePanel({ gateResultsJson }: { gateResultsJson: string }) {
  const gates = parseJsonField<GateResults>(gateResultsJson, {});
  const hasAny = Boolean(gates.g1 || gates.g2 || gates.g3 || gates.g5 || gates.g7 || gates.g4 || gates.g6);
  if (!hasAny) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-4 text-sm text-muted-foreground">
          No gate results yet — gates are graded at the PARETO GATE stage after the paired shadow-eval battery settles.
        </CardContent>
      </Card>
    );
  }

  const g1 = gates.g1;
  const g1PerSuite = parseJsonField<Array<{ suite?: string; category?: string; delta?: number; epsilon?: number; pass?: boolean }>>(
    JSON.stringify(g1?.numbers?.perSuite ?? []),
    [],
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 font-mono text-sm">
          Gate results
          {gates.allGreen === true && (
            <Badge variant="outline" className="border-primary/40 text-primary">
              ALL GREEN
            </Badge>
          )}
          {gates.allGreen === false && (
            <Badge variant="outline" className="border-destructive/50 text-destructive">
              GATE FAILURE RECORDED
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 md:grid-cols-2">
          <GateChip
            id="g1"
            label="Non-regression (per-suite floor)"
            pass={g1?.pass}
            note={
              g1PerSuite.length > 0
                ? g1PerSuite
                    .map((s) => `${s.suite}: Δ${fmtNum(s.delta)} ≥ -${fmtNum(s.epsilon)} ${s.pass ? "OK" : "FAIL"}`)
                    .join(" · ")
                : g1?.note ?? "not graded yet"
            }
          />
          <GateChip
            id="g2"
            label="Pareto dominance (score up, cost capped)"
            pass={gates.g2?.pass}
            note={
              gates.g2?.numbers
                ? `S ${fmtNum(gates.g2.numbers.sCand)} ≥ ${fmtNum(gates.g2.numbers.sBase)}+${fmtNum(gates.g2.numbers.epsPerf)} · C ${fmtNum(gates.g2.numbers.cCand)} ≤ ${fmtNum(gates.g2.numbers.cBase)}x1.10`
                : gates.g2?.note ?? "not graded yet"
            }
          />
          <GateChip
            id="g3"
            label="Prompt-delta regularization cap (RRSI)"
            pass={gates.g3?.pass}
            note={
              gates.g3?.numbers
                ? `distance ${fmtNum(gates.g3.numbers.promptDeltaDistance)} ≤ cap ${fmtNum(gates.g3.numbers.cap)} (arXiv 2609.24972)`
                : gates.g3?.note ?? "not graded yet"
            }
          />
          <GateChip
            id="g5"
            label="Abstention reliability (zero regression)"
            pass={gates.g5?.pass}
            note={gates.g5?.note ?? (gates.g5 ? "per-suite abstain rates compared" : "not graded yet")}
          />
          <GateChip id="g4" label="Counterfactual gain survival" pending note={gates.g4?.note ?? "owner transformation registry not authored"} />
          <GateChip
            id="g6"
            label="Judge calibration (kappa on owner anchors)"
            pending
            note={gates.g6?.note ?? "provisional author-anchors only; binding kappa gate PENDING"}
          />
          <GateChip
            id="g7"
            label="Budget ceiling (loud fail)"
            pass={gates.g7?.pass}
            note={
              gates.g7?.numbers
                ? `${fmtNum(gates.g7.numbers.used)}/${fmtNum(gates.g7.numbers.cap)} daily calls · synth ${fmtNum(gates.g7.numbers.synthCalls)}/${fmtNum(gates.g7.numbers.synthCap)}`
                : "not graded yet"
            }
          />
        </div>
        <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
          G1/G2/G3/G5/G7 are hard promote gates computed from paired live runs. G4 (counterfactual registry) and G6
          (owner-labeled judge anchors) are owner artifacts — they render PENDING until authored and are surfaced to
          the owner gate honestly. No gate number on this panel is ever synthesized.
        </p>
      </CardContent>
    </Card>
  );
}
