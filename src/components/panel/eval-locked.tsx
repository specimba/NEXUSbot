"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FlaskConical } from "lucide-react";

/**
 * PLACEHOLDER (honest): eval tab unlocks only behind owner gate G6, after the
 * frozen eval set is signed off in docs/verify.md. Nothing is faked until then.
 */
export function EvalTab() {
  return (
    <Card className="border-dashed">
      <CardHeader className="items-center pb-2 text-center">
        <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-lg border border-accent/40 bg-accent/10">
          <FlaskConical className="size-6 text-accent" aria-hidden="true" />
        </div>
        <CardTitle className="font-mono">Eval &amp; Gating (L3–L4)</CardTitle>
        <CardDescription>Locked behind owner gate G6</CardDescription>
      </CardHeader>
      <CardContent className="text-center text-sm leading-relaxed text-muted-foreground">
        <p>
          This tab activates after the frozen evaluation set is signed off in{" "}
          <code className="font-mono text-foreground">docs/verify.md</code>. Until then, claims
          about agent improvement remain <span className="font-mono text-accent">[UNVERIFIED]</span>{" "}
          by design — the RSI loop does not open early.
        </p>
      </CardContent>
    </Card>
  );
}
