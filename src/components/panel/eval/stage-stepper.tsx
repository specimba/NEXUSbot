"use client";

import { STAGE_SPINE, isTerminal, stageIndex } from "./api";
import { cn } from "@/lib/utils";
import { Check, CircleAlert, CircleDot, X } from "lucide-react";

/**
 * The 9-stage spine stepper. Horizontal in overview contexts, vertical in
 * the cycle detail. Current stage glows primary; terminal states render a
 * distinct verdict chip (adopted = emerald glow, rejected/aborted = honest
 * destructive or muted tones). No fabricated progress — a cycle at stage N
 * has passed N-1 stage events and nothing more.
 */

export function StageStepper({
  status,
  orientation = "horizontal",
}: {
  status: string;
  orientation?: "horizontal" | "vertical";
}) {
  const terminal = isTerminal(status);
  const currentIdx = stageIndex(status);

  if (orientation === "vertical") {
    return (
      <ol className="space-y-1.5" aria-label="Cycle stage progression">
        {STAGE_SPINE.map((stage, i) => {
          const done = !terminal && currentIdx > i;
          const active = !terminal && currentIdx === i;
          return (
            <li
              key={stage.id}
              className={cn(
                "flex min-h-11 items-start gap-2.5 rounded-md border px-3 py-2",
                active
                  ? "border-primary/40 bg-primary/10"
                  : done
                    ? "border-primary/20 bg-primary/5"
                    : "border-border/50",
              )}
            >
              <span className="mt-0.5 shrink-0" aria-hidden="true">
                {done ? (
                  <Check className="size-4 text-primary" />
                ) : active ? (
                  <CircleDot className="size-4 animate-pulse text-primary" />
                ) : (
                  <CircleDot className="size-4 text-muted-foreground/50" />
                )}
              </span>
              <div className="min-w-0">
                <p
                  className={cn(
                    "font-mono text-sm",
                    active ? "text-primary" : done ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {String(i + 1).padStart(2, "0")} {stage.label}
                </p>
                {(active || done) && (
                  <p className="text-xs leading-snug text-muted-foreground">{stage.action}</p>
                )}
              </div>
            </li>
          );
        })}
        {terminal && (
          <li
            className={cn(
              "flex min-h-11 items-center gap-2.5 rounded-md border px-3 py-2 font-mono text-sm",
              status === "adopted"
                ? "border-primary/40 bg-primary/10 text-primary"
                : status === "rejected"
                  ? "border-destructive/50 bg-destructive/10 text-destructive"
                  : "border-border/60 text-muted-foreground",
            )}
          >
            {status === "adopted" ? (
              <Check className="size-4 shrink-0" aria-hidden="true" />
            ) : status === "rejected" ? (
              <X className="size-4 shrink-0" aria-hidden="true" />
            ) : (
              <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
            )}
            TERMINAL · {status.toUpperCase()}
          </li>
        )}
      </ol>
    );
  }

  return (
    <div
      className="flex items-center gap-1 overflow-x-auto pb-1"
      role="list"
      aria-label="Cycle spine (9 stages)"
    >
      {STAGE_SPINE.map((stage, i) => {
        const done = !terminal && currentIdx > i;
        const active = !terminal && currentIdx === i;
        return (
          <div key={stage.id} role="listitem" className="flex shrink-0 items-center gap-1">
            <span
              className={cn(
                "flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 font-mono text-xs",
                active
                  ? "border-primary/40 bg-primary/15 text-primary text-glow"
                  : done
                    ? "border-primary/25 bg-primary/5 text-primary/80"
                    : "border-border/50 text-muted-foreground",
              )}
              aria-current={active ? "step" : undefined}
            >
              {done ? <Check className="size-3.5" aria-hidden="true" /> : null}
              {String(i + 1).padStart(2, "0")} {stage.label}
            </span>
            {i < STAGE_SPINE.length - 1 && (
              <span
                className={cn("h-px w-2 shrink-0", done ? "bg-primary/40" : "bg-border")}
                aria-hidden="true"
              />
            )}
          </div>
        );
      })}
      {terminal && (
        <span
          className={cn(
            "ml-1 flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-md border px-2.5 py-1 font-mono text-xs",
            status === "adopted"
              ? "border-primary/40 bg-primary/15 text-primary"
              : status === "rejected"
                ? "border-destructive/50 text-destructive"
                : "border-border/60 text-muted-foreground",
          )}
        >
          TERMINAL · {status.toUpperCase()}
        </span>
      )}
    </div>
  );
}
