"use client";

import { useMemo, useState } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  DIALECT_NOTES,
  VARIABLE_GROUPS,
  renderTemplate,
  type VariableAvailability,
} from "@/lib/variables-registry";
import { Braces, Copy, FlaskConical, RefreshCw, Search } from "lucide-react";

const AVAILABILITY_LABEL: Record<VariableAvailability, string> = {
  command: "Command",
  widget: "Widget",
  alert: "Alert",
};

function CopyButton({ value, label }: { value: string; label: string }) {
  const { toast } = useToast();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast({ title: "Copied", description: value.length > 48 ? `${value.slice(0, 45)}…` : value });
        } catch {
          toast({ title: "Copy failed", description: "Clipboard unavailable", variant: "destructive" });
        }
      }}
    >
      <Copy className="size-3.5" aria-hidden="true" />
    </Button>
  );
}

const TRY_DEFAULT = "gg {{sender.username}} — {{stream.title}} has {{stream.viewers}} viewers | roll {{randomRange(1,100)}}";

export function VariablesTab() {
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [template, setTemplate] = useState(TRY_DEFAULT);
  const [rendered, setRendered] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return VARIABLE_GROUPS;
    return VARIABLE_GROUPS.map((g) => ({
      ...g,
      variables: g.variables.filter(
        (v) =>
          v.syntax.toLowerCase().includes(q) ||
          v.label.toLowerCase().includes(q) ||
          v.description.toLowerCase().includes(q),
      ),
    })).filter((g) => g.variables.length > 0);
  }, [query]);

  const totalVars = useMemo(
    () => VARIABLE_GROUPS.reduce((n, g) => n + g.variables.length, 0),
    [],
  );

  return (
    <div className="space-y-6">
      {/* ---- Syntax card ---- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 font-mono">
            <Braces className="size-5 text-primary" aria-hidden="true" />
            Variables
            <span className="text-xs font-normal text-muted-foreground">
              Kickbot-parity dialect · {totalVars} variables
            </span>
          </CardTitle>
          <CardDescription>
            Use <span className="font-mono text-foreground">{"{{namespace.field}}"}</span> in command
            responses, alert templates and widget text. Copy any variable below; the TRY panel
            renders your template exactly like the bot will.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <ul className="space-y-1 text-xs text-muted-foreground">
            {DIALECT_NOTES.map((note) => (
              <li key={note} className="flex gap-1.5">
                <span className="text-primary" aria-hidden="true">
                  ›
                </span>
                <span>{note}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* ---- TRY renderer ---- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 font-mono text-base">
            <FlaskConical className="size-4 text-primary" aria-hidden="true" />
            TRY — render a template
          </CardTitle>
          <CardDescription>
            Client-side preview. Random functions re-roll on every render;{" "}
            <span className="font-mono">request()</span> resolves server-side at runtime.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              className="min-h-11 flex-1 font-mono"
              aria-label="Template to render"
              placeholder="Type a template using {{…}} variables"
            />
            <div className="flex gap-2">
              <Button
                className="min-h-11 flex-1 font-mono sm:flex-none"
                onClick={() => setRendered(renderTemplate(template))}
                aria-label="Render template"
              >
                <RefreshCw className="size-4" aria-hidden="true" />
                Render
              </Button>
              <CopyButton value={rendered ?? ""} label="rendered output" />
            </div>
          </div>
          <div className="min-h-11 rounded-md border border-border/60 bg-muted/30 p-3 font-mono text-sm">
            {rendered === null ? (
              <span className="text-muted-foreground">Press Render to preview…</span>
            ) : (
              <span className="break-words">{rendered}</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ---- Registry ---- */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="font-mono text-base">Registry</CardTitle>
            <div className="relative w-full sm:w-64">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="min-h-9 pl-8"
                placeholder="Search variables…"
                aria-label="Search variables"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No variables match “{query}”.
            </p>
          ) : (
            <div className="max-h-[28rem] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
              <Accordion
                type="multiple"
                defaultValue={filtered.slice(0, 2).map((g) => g.id)}
                className="w-full"
              >
                {filtered.map((group) => (
                  <AccordionItem key={group.id} value={group.id}>
                    <AccordionTrigger className="font-mono text-sm">
                      <span className="flex items-center gap-2">
                        {group.name}
                        <span className="text-xs font-normal text-muted-foreground">
                          {group.variables.length}
                        </span>
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="space-y-2">
                      {group.precondition && (
                        <p className="rounded-md border border-accent/30 bg-accent/10 p-2 text-xs text-foreground/80">
                          {group.precondition}
                        </p>
                      )}
                      {group.variables.map((v) => (
                        <div
                          key={v.syntax}
                          className="rounded-md border border-border/60 p-2.5 transition-colors hover:border-border"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <code className="min-w-0 break-all font-mono text-xs text-primary">
                              {v.syntax}
                            </code>
                            <CopyButton value={v.syntax} label={v.syntax} />
                          </div>
                          <p className="mt-1 text-xs text-foreground/90">{v.description}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            {v.availableIn.map((a) => (
                              <Badge
                                key={a}
                                variant="outline"
                                className={cn(
                                  "font-mono text-[10px]",
                                  a === "command" && "border-primary/40 text-primary",
                                  a === "widget" && "border-accent/40 text-accent",
                                  a === "alert" && "border-muted-foreground/40 text-muted-foreground",
                                )}
                              >
                                {AVAILABILITY_LABEL[a]}
                              </Badge>
                            ))}
                            <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">
                              e.g. {v.sample}
                            </span>
                          </div>
                        </div>
                      ))}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
