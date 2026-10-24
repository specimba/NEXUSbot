"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ArrowUpCircle, ChevronsUpDown, CircleSlash, FlaskConical, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { BenchmarksCard } from "./benchmarks-card";
import { cn } from "@/lib/utils";

/**
 * Task R18-b — "Brain" tab: the brain-tier registry (owner queue ④). Any
 * MEASURED model — including one from a custom provider — can be promoted to
 * one of the six brain roles (router / worker / frontier / free / batch /
 * image). Bindings live in the Settings KV "ai.role-bindings" and take
 * precedence over the legacy "ai.models" override and the Vyce defaults.
 *
 * Honest states only:
 *  - Model lists for custom providers come from the MEASURED probe
 *    (POST /api/providers/<slug>/probe) — the button re-measures per session
 *    (in-memory cache only); the measured count + HTTP status + time are shown
 *    exactly as answered, failures included.
 *  - Benchmark ordering is applied ONLY from real /api/benchmarks entries;
 *    when the API is missing/unloaded/failing the list degrades silently to
 *    alphabetical with a muted "no benchmark data yet" hint.
 *  - A custom binding is non-streaming by design (the panel never fakes SSE).
 *
 * P7: this tab only ever handles provider slugs, model ids and booleans —
 * no key material exists at this layer.
 */

// ---------------------------------------------------------------------------
// API contract mirrors
// ---------------------------------------------------------------------------

type RoleBinding = { via: "vyce" | "groq" | "custom"; provider?: string; model: string };

type RoleRow = {
  role: string;
  vyceDefault: string;
  aiModelsOverride: string | null;
  binding: RoleBinding | null;
};

type ProviderRow = {
  slug: string;
  name: string;
  style: "openai" | "anthropic";
  baseUrl: string;
  hasKey: boolean;
  modelCount: number;
};

type TiersResponse = { ok: true; roleOrder: string[]; roles: RoleRow[]; providers: ProviderRow[] };

type ApiErrorShape = { ok: false; error: { code: string; message: string } };

type ProbeShape =
  | { ok: true; httpStatus: number; models: string[] }
  | { ok: false; code: string; httpStatus: number | null; message: string };

type BenchEntry = { model: string; norm?: string; score?: number; rank?: number };

type BenchSource = {
  kind: string;
  label?: string;
  ok?: boolean;
  fetchedAt?: string;
  modelCount?: number;
  entries?: BenchEntry[];
};

type BenchmarksResponse = { ok: true; sources: BenchSource[] };

const MODEL_MAX_LENGTH = 128;

/** §11 message extraction — never trust the body beyond the message string. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as (ApiErrorShape | { error?: { message?: string } }) | null;
  return body?.error?.message ?? fallback;
}

// ---------------------------------------------------------------------------
// Benchmark-aware model ordering (owner requirement)
// ---------------------------------------------------------------------------

const BENCH_KINDS = [
  { value: "arena-chat", label: "Arena · chat" },
  { value: "arena-chat-non-english", label: "Arena · chat non-english" },
  { value: "arena-chat-multi-turn", label: "Arena · chat multi-turn" },
  { value: "arena-agent", label: "Arena · agent" },
  { value: "arena-agent-alignment", label: "Arena · agent alignment" },
  { value: "aa-index", label: "AA index" },
  { value: "none", label: "None (A → Z)" },
] as const;

/**
 * Common vendor/namespace prefixes seen in aggregator catalogs; tried on BOTH
 * sides of a comparison (candidate id and benchmark id) when a direct match
 * fails — e.g. catalog "qwen/qwen3.8-27b" vs benchmark "qwen3.8-27b", or
 * "coding-claude-sonnet-4-6" vs "claude-sonnet-4-6".
 */
const VENDOR_PREFIXES = [
  "coding-",
  "cc-",
  "alicloud-",
  "deepinfra-",
  "zai-",
  "meta-",
  "meta/",
  "qwen/",
  "qwen-",
  "openai/",
  "openai-",
  "google/",
  "google-",
  "mistralai/",
  "mistral-",
  "anthropic/",
  "anthropic-",
  "nexus-",
];

function normalizeModelId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stripVendorPrefix(id: string): string {
  const lower = id.toLowerCase();
  for (const p of VENDOR_PREFIXES) {
    if (lower.startsWith(p)) return lower.slice(p.length);
  }
  return lower;
}

/** All comparison keys for one id (direct + prefix-stripped normalizations). */
function modelMatchKeys(id: string, prenormalized?: string): string[] {
  const keys = new Set<string>();
  for (const base of [id, prenormalized ?? ""]) {
    if (!base) continue;
    keys.add(normalizeModelId(base));
    keys.add(normalizeModelId(stripVendorPrefix(base)));
  }
  return [...keys];
}

function matchBenchEntry(modelId: string, entries: BenchEntry[]): BenchEntry | null {
  const keys = new Set(modelMatchKeys(modelId));
  for (const entry of entries) {
    for (const key of modelMatchKeys(entry.model ?? "", entry.norm)) {
      if (key && keys.has(key)) return entry;
    }
  }
  return null;
}

type OrderedModel = { model: string; score: number | null; matched: boolean };

/**
 * Benchmark-informed ordering: matched models first, score desc (ties by
 * name); unmatched models follow alphabetically. "none" or missing benchmark
 * data → plain alphabetical. Pure function — cheap to re-run per open picker.
 */
function orderModels(models: string[], entries: BenchEntry[] | null, orderBy: string): OrderedModel[] {
  const unique = [...new Set(models.filter((m) => m.trim().length > 0))];
  if (!entries || orderBy === "none") {
    return unique
      .sort((a, b) => a.localeCompare(b))
      .map((model) => ({ model, score: null, matched: false }));
  }
  const scored = unique.map((model) => ({ model, entry: matchBenchEntry(model, entries) }));
  scored.sort((a, b) => {
    if (a.entry && b.entry) {
      const sa = typeof a.entry.score === "number" ? a.entry.score : 0;
      const sb = typeof b.entry.score === "number" ? b.entry.score : 0;
      if (sa !== sb) return sb - sa;
      return a.model.localeCompare(b.model);
    }
    if (a.entry) return -1;
    if (b.entry) return 1;
    return a.model.localeCompare(b.model);
  });
  return scored.map(({ model, entry }) => ({
    model,
    score: typeof entry?.score === "number" ? entry.score : null,
    matched: entry !== null,
  }));
}

function formatScore(score: number): string {
  return Number.isFinite(score) ? String(Math.round(score * 100) / 100) : "0";
}

// ---------------------------------------------------------------------------
// Shared subcomponents
// ---------------------------------------------------------------------------

/** Slim scrollbar styling — the panel's existing long-list pattern. */
const SCROLLBAR_LIST =
  "overflow-y-auto [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar]:w-1.5";

type MeasuredListState = {
  models: string[];
  httpStatus: number | null;
  at: number;
  error: string | null;
  /** Honest provenance for the list (e.g. groq docsSource). */
  note: string | null;
};

/**
 * Searchable model picker (Popover + Command). Lists `ordered` models
 * (benchmark-aware, computed by the parent); typing a value not in the list
 * offers an explicit "Use …" item so any 1..128-char id can be bound (the
 * server re-validates on PUT).
 */
function ModelPicker({
  models,
  ordered,
  value,
  onChange,
  orderBy,
  benchHint,
  ariaLabel,
}: {
  models: string[];
  ordered: OrderedModel[];
  value: string;
  onChange: (model: string) => void;
  orderBy: string;
  benchHint: boolean;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const showCustom =
    search.trim().length > 0 &&
    search.trim().length <= MODEL_MAX_LENGTH &&
    !models.some((m) => m.toLowerCase() === search.trim().toLowerCase());

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          className="min-h-11 w-full justify-between font-mono text-xs"
        >
          <span className="truncate">
            {value || <span className="text-muted-foreground">Pick or type a model…</span>}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(92vw,28rem)] p-0">
        <Command>
          <CommandInput
            placeholder={`Search ${models.length > 0 ? `${models.length} model(s)` : "models"}…`}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className={cn("max-h-96", SCROLLBAR_LIST)}>
            <CommandEmpty>
              {search.trim() ? "No list match — use the custom entry below." : "No models yet."}
            </CommandEmpty>
            {ordered.length > 0 && (
              <CommandGroup heading={orderBy === "none" ? "All models (A → Z)" : "Ranked by benchmark score"}>
                {ordered.map(({ model, score, matched }) => (
                  <CommandItem
                    key={model}
                    value={model}
                    onSelect={() => {
                      onChange(model);
                      setOpen(false);
                      setSearch("");
                    }}
                    className="min-h-9 font-mono text-xs"
                  >
                    <span className="min-w-0 flex-1 truncate [overflow-wrap:anywhere]">{model}</span>
                    {matched && score !== null && (
                      <Badge variant="outline" className="ml-2 shrink-0 font-mono text-[10px]">
                        {formatScore(score)}
                      </Badge>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {showCustom && (
              <CommandGroup heading="Custom entry">
                <CommandItem
                  value={`use-exact:${search.trim()}`}
                  onSelect={() => {
                    onChange(search.trim().slice(0, MODEL_MAX_LENGTH));
                    setOpen(false);
                    setSearch("");
                  }}
                  className="min-h-9 font-mono text-xs"
                >
                  <span className="min-w-0 truncate [overflow-wrap:anywhere]">
                    Use “{search.trim().slice(0, MODEL_MAX_LENGTH)}”
                  </span>
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
          {benchHint && (
            <p className="border-t border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
              no benchmark data yet — alphabetical
            </p>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Role card — one per brain tier
// ---------------------------------------------------------------------------

function viaLabel(binding: NonNullable<RoleRow["binding"]>): string {
  if (binding.via === "custom") return `via custom provider ${binding.provider ?? "?"}`;
  if (binding.via === "groq") return "via groq";
  return "via vyce";
}

type BindPayload =
  | { role: string; via: "vyce" | "groq" | "custom"; provider?: string; model: string }
  | { role: string; binding: null };

function measuredText(state: MeasuredListState): string {
  if (state.error) return state.error;
  const provenance = state.note ?? (state.httpStatus !== null ? `HTTP ${state.httpStatus}` : "probe");
  return `${state.models.length} models · ${provenance} · measured ${formatDistanceToNow(state.at, { addSuffix: true })}`;
}

function RoleCard({
  row,
  providers,
  vyceDefaults,
  orderBy,
  benchEntries,
  benchHint,
  probeCache,
  onMutate,
  mutating,
  onMeasure,
  measuringKey,
}: {
  row: RoleRow;
  providers: ProviderRow[];
  vyceDefaults: string[];
  orderBy: string;
  benchEntries: BenchEntry[] | null;
  benchHint: boolean;
  probeCache: Record<string, MeasuredListState>;
  onMutate: (payload: BindPayload) => void;
  mutating: boolean;
  onMeasure: (key: string) => void;
  measuringKey: string | null;
}) {
  const effectiveModel = row.binding?.model ?? row.aiModelsOverride ?? row.vyceDefault;
  const effectiveKind = row.binding ? "binding" : row.aiModelsOverride ? "override" : "default";

  const [via, setVia] = useState<"vyce" | "groq" | "custom">(row.binding?.via ?? "vyce");
  const [model, setModel] = useState<string>(effectiveModel);
  const [customSlug, setCustomSlug] = useState<string>(
    row.binding?.via === "custom" && row.binding.provider ? row.binding.provider : (providers[0]?.slug ?? ""),
  );

  // Measured list cache key: the card's own selected route decides it.
  const measureKey = via === "custom" ? customSlug : via === "groq" ? "__groq__" : null;
  const measured = measureKey ? (probeCache[measureKey] ?? null) : null;

  // The list the picker offers for the currently selected route.
  const selectedProvider = providers.find((p) => p.slug === customSlug);
  const pickerModels: string[] =
    via === "vyce"
      ? vyceDefaults
      : via === "groq"
        ? (measured?.models ?? [])
        : (measured?.models ?? selectedProvider?.models ?? []);
  // orderModels is pure; recomputed per render (837-entry lists sort in ~ms).
  const ordered = orderModels(pickerModels, benchEntries, orderBy);

  const modelValid = model.trim().length >= 1 && model.trim().length <= MODEL_MAX_LENGTH;
  const needsProvider = via === "custom" && !customSlug;
  const dirty =
    !row.binding ||
    row.binding.via !== via ||
    row.binding.model !== model ||
    (via === "custom" ? row.binding.provider !== customSlug : false);

  const providerSelectValue = via === "custom" ? `custom:${customSlug || "none"}` : via;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="font-mono text-sm uppercase tracking-wide text-primary">{row.role}</CardTitle>
          {row.binding && (
            <Badge variant="outline" className="font-mono text-[10px]">
              bound · {viaLabel(row.binding)}
            </Badge>
          )}
        </div>
        <CardDescription className="font-mono text-xs">
          <span className="text-muted-foreground">
            {effectiveKind === "binding"
              ? `${viaLabel(row.binding!)} →`
              : effectiveKind === "override"
                ? "ai.models override:"
                : "Vyce default:"}{" "}
          </span>
          <span className="text-foreground [overflow-wrap:anywhere]">{effectiveModel}</span>
        </CardDescription>
        {row.aiModelsOverride && (
          <p className="font-mono text-[11px] text-muted-foreground">
            ai.models override “{row.aiModelsOverride}” is{" "}
            {row.binding ? `shadowed by this binding (default path: “${row.vyceDefault}”)` : `active — Vyce default would be “${row.vyceDefault}”`}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`via-${row.role}`} className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Provider
            </Label>
            <Select
              value={providerSelectValue}
              onValueChange={(v) => {
                if (v === "vyce" || v === "groq") {
                  setVia(v);
                } else if (v.startsWith("custom:")) {
                  setVia("custom");
                }
              }}
            >
              <SelectTrigger
                id={`via-${row.role}`}
                className="min-h-11 w-full font-mono text-xs"
                aria-label={`Provider for role ${row.role}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="vyce">Vyce</SelectItem>
                <SelectItem value="groq">Groq</SelectItem>
                {providers.map((p) => (
                  <SelectItem key={p.slug} value={`custom:${p.slug}`}>
                    {`${p.name} (${p.slug})${p.hasKey ? "" : " · no key"}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {via === "custom" && providers.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor={`provider-${row.role}`} className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Custom provider
              </Label>
              <Select value={customSlug} onValueChange={setCustomSlug}>
                <SelectTrigger
                  id={`provider-${row.role}`}
                  className="min-h-11 w-full font-mono text-xs"
                  aria-label={`Custom provider for role ${row.role}`}
                >
                  <SelectValue placeholder="Choose a provider" />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p.slug} value={p.slug}>
                      {`${p.name} (${p.slug})${p.hasKey ? "" : " · no key"}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`model-${row.role}`} className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Model
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <ModelPicker
                models={pickerModels}
                ordered={ordered}
                value={model}
                onChange={setModel}
                orderBy={orderBy}
                benchHint={benchHint}
                ariaLabel={`Model for role ${row.role}`}
              />
            </div>
            {measureKey && (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 gap-1.5 font-mono text-xs"
                onClick={() => onMeasure(measureKey)}
                disabled={measuringKey === measureKey}
              >
                <RefreshCw
                  className={cn("size-4", measuringKey === measureKey && "animate-spin")}
                  aria-hidden="true"
                />
                {measuringKey === measureKey
                  ? "Measuring…"
                  : via === "groq"
                    ? "Load Groq models"
                    : "Measure models"}
              </Button>
            )}
          </div>
          {via === "vyce" && (
            <p className="font-mono text-[11px] text-muted-foreground">
              Vyce suggestions are the six registry defaults — any typed id can be bound.
            </p>
          )}
          {via === "groq" && (
            <p className="font-mono text-[11px] text-muted-foreground">
              {measured
                ? measuredText(measured)
                : "Groq model list loads on demand from the measured slot catalog — or type any id."}
            </p>
          )}
          {via === "custom" && selectedProvider && (
            <p className="font-mono text-[11px] text-muted-foreground">
              {measured
                ? measuredText(measured)
                : `Using ${selectedProvider.modelCount} configured model(s) — measure for the live list.`}
              {!selectedProvider.hasKey && " · no key stored — calls will fail NO_KEY until one is added in Connectors"}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            type="button"
            className="min-h-11 gap-1.5 font-mono text-xs"
            disabled={mutating || !modelValid || needsProvider}
            onClick={() =>
              onMutate({
                role: row.role,
                via,
                ...(via === "custom" ? { provider: customSlug } : {}),
                model: model.trim().slice(0, MODEL_MAX_LENGTH),
              })
            }
          >
            <ArrowUpCircle className="size-4" aria-hidden="true" />
            {mutating ? "Saving…" : dirty ? "Promote to tier" : "Re-bind"}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 gap-1.5 font-mono text-xs"
            disabled={mutating || !row.binding}
            onClick={() => onMutate({ role: row.role, binding: null })}
          >
            <CircleSlash className="size-4" aria-hidden="true" />
            Reset to default
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Tab root
// ---------------------------------------------------------------------------

export function BrainTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [orderBy, setOrderBy] = useState<string>("arena-chat");

  // Per-session, in-memory measured model caches (the owner re-measures per
  // session — deliberately nothing persisted).
  const [probeCache, setProbeCache] = useState<Record<string, MeasuredListState>>({});
  const [measuringKey, setMeasuringKey] = useState<string | null>(null);

  const tiers = useQuery<TiersResponse>({
    queryKey: ["brain-tiers"],
    queryFn: async () => {
      const res = await fetch("/api/brain/tiers", { cache: "no-store" });
      if (!res.ok) throw new Error(await errorMessage(res, "brain tiers unavailable"));
      return res.json();
    },
    refetchInterval: 30_000,
  });

  // Benchmarks are delivered by a parallel workstream (R18-c) — missing route,
  // failure or empty entries all degrade silently to alphabetical + the hint.
  const benchmarks = useQuery<BenchmarksResponse>({
    queryKey: ["brain-benchmarks"],
    queryFn: async () => {
      const res = await fetch("/api/benchmarks", { cache: "no-store" });
      if (!res.ok) throw new Error("benchmarks unavailable");
      return res.json();
    },
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  });

  const benchSource = benchmarks.data?.sources?.find((s) => s.kind === orderBy) ?? null;
  const benchEntries =
    benchSource && benchSource.ok && Array.isArray(benchSource.entries) && benchSource.entries.length > 0
      ? benchSource.entries
      : null;
  const benchHint = benchEntries === null || orderBy === "none";

  const bind = useMutation({
    mutationFn: async (payload: BindPayload) => {
      const res = await fetch("/api/brain/tiers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: { message?: string } } | null;
      if (!res.ok || !body?.ok) {
        throw new Error(body?.error?.message ?? "Tier update failed");
      }
      return body as { ok: true; binding: RoleBinding | null };
    },
    onSuccess: (data, payload) => {
      void queryClient.invalidateQueries({ queryKey: ["brain-tiers"], exact: true });
      const cleared = "binding" in payload && payload.binding === null;
      void data.binding; // shape reserved for inline updates
      toast({ title: cleared ? "Tier reset to default" : "Model promoted to tier" });
    },
    onError: (e: Error) => {
      toast({ title: "Tier update failed", description: e.message, variant: "destructive" });
    },
  });

  /**
   * Measure handler. Custom providers → the existing session-guarded probe
   * route. "__groq__" → the measured Groq slot catalog from /api/vyce/status
   * (the only existing surface for the live Groq model list).
   */
  const measure = async (key: string) => {
    setMeasuringKey(key);
    try {
      if (key === "__groq__") {
        const res = await fetch("/api/vyce/status", { cache: "no-store" });
        if (!res.ok) throw new Error(await errorMessage(res, "Groq model list unavailable"));
        const body = (await res.json()) as {
          groq?: { models?: string[]; docsSource?: string; error?: { message?: string } | null };
        };
        const models = Array.isArray(body.groq?.models) ? (body.groq?.models ?? []) : [];
        if (models.length === 0) {
          throw new Error(body.groq?.error?.message ?? "Groq slot answered no model list");
        }
        setProbeCache((prev) => ({
          ...prev,
          __groq__: {
            models,
            httpStatus: 200,
            at: Date.now(),
            error: null,
            note: body.groq?.docsSource ?? null,
          },
        }));
        return;
      }
      const res = await fetch(`/api/providers/${encodeURIComponent(key)}/probe`, { method: "POST" });
      if (!res.ok) throw new Error(await errorMessage(res, "Probe failed"));
      const body = (await res.json()) as { ok?: boolean; probe?: ProbeShape };
      const probe = body.probe;
      if (!probe) throw new Error("Probe returned no result");
      setProbeCache((prev) => ({
        ...prev,
        [key]: probe.ok
          ? { models: probe.models, httpStatus: probe.httpStatus, at: Date.now(), error: null, note: null }
          : {
              models: [],
              httpStatus: probe.httpStatus ?? null,
              at: Date.now(),
              error: `${probe.code} · ${probe.message}`,
              note: null,
            },
      }));
    } catch (e) {
      const message = e instanceof Error ? e.message : "measurement failed";
      setProbeCache((prev) => ({
        ...prev,
        [key]: { models: [], httpStatus: null, at: Date.now(), error: message, note: null },
      }));
      toast({ title: "Measurement failed", description: message, variant: "destructive" });
    } finally {
      setMeasuringKey(null);
    }
  };

  const roleRows = tiers.data?.roles ?? [];
  const providers = tiers.data?.providers ?? [];
  const vyceDefaults = [...new Set(roleRows.map((r) => r.vyceDefault))];

  return (
    <div className="space-y-6">
      <section aria-labelledby="brain-tiers-heading" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="brain-tiers-heading" className="font-mono text-sm font-semibold uppercase tracking-wide text-foreground">
              Brain tiers
            </h2>
            <p className="max-w-prose text-xs text-muted-foreground">
              Promote any measured model to one of the six brain roles. Bindings take precedence over the
              ai.models override and the Vyce defaults; custom-provider bindings are non-streaming by design.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="bench-order" className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Order models by
            </Label>
            <Select value={orderBy} onValueChange={setOrderBy}>
              <SelectTrigger id="bench-order" className="min-h-11 w-56 font-mono text-xs" aria-label="Order models by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BENCH_KINDS.map((k) => (
                  <SelectItem key={k.value} value={k.value}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {tiers.isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-44 rounded-md" />
            ))}
          </div>
        ) : tiers.isError ? (
          <p className="text-sm text-destructive" role="alert">
            Brain tiers unavailable — {tiers.error instanceof Error ? tiers.error.message : "try again shortly."}
          </p>
        ) : roleRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No brain roles returned — refresh the tab.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {roleRows.map((row) => (
              <RoleCard
                key={row.role}
                row={row}
                providers={providers}
                vyceDefaults={vyceDefaults}
                orderBy={orderBy}
                benchEntries={benchEntries}
                benchHint={benchHint}
                probeCache={probeCache}
                onMutate={(payload) => bind.mutate(payload)}
                mutating={bind.isPending}
                onMeasure={(key) => void measure(key)}
                measuringKey={measuringKey}
              />
            ))}
          </div>
        )}
      </section>

      {/* Benchmarks — delivered by R18-c (src/lib/benchmarks.ts + bench-cadence
          mini-service). Snapshot cadence: every 6 hours; sources measured live. */}
      <section data-testid="bench-slot" aria-label="Benchmarks" className="space-y-3">
        <h2 className="font-mono text-sm font-semibold uppercase tracking-wide text-foreground">Benchmarks</h2>
        <BenchmarksCard />
      </section>
    </div>
  );
}
