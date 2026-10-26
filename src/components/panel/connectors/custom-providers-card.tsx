"use client";

import { useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Toaster } from "@/components/ui/sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  Boxes,
  Check,
  ListPlus,
  Loader2,
  PlugZap,
  Plus,
  RefreshCw,
  Radar,
  Star,
  Trash2,
  Wrench,
  X,
} from "lucide-react";

/**
 * Custom brain providers (owner-defined) — OpenAI-compatible OR
 * Anthropic-compatible gateways with explicit endpoint + key + a BATCH model
 * list (task C1). The add/edit dialog is built around batch flows:
 *
 *   1. "Discover models" — the panel backend proxies GET {base}[/v1]/models
 *      with the typed (or stored) key and the answer renders as multi-select
 *      checkbox chips (searchable past 12 models, select-all/clear).
 *   2. Manual batch paste — one model per line or comma-separated; parsed into
 *      removable, deduped chips.
 *   3. One save action stores ALL selected models and probes the endpoint
 *      plus up to the first 3 models (per-model ok/fail chips on the row).
 *
 * Keys live in the same AES-256-GCM envelope as the vault (masked previews
 * only, never re-displayed — P7). The brain consumes rows via
 * chatCompleteCustom(providerId, …) with `model` as the default model id.
 */

const MAX_MODELS = 100;
const PROBE_BATCH = 3;

type Probe = { ok: boolean; code: string; detail: string };
type ModelProbe = { model: string; ok: boolean; code: string; detail: string };

type ProviderRow = {
  id: string;
  name: string;
  protocol: "openai" | "anthropic";
  baseUrl: string;
  model: string;
  models: string[];
  enabled: boolean;
  keyPresent: boolean;
  keyId: string;
  maskedKey: string | null;
  lastProbeAt: string | null;
  lastProbeOk: boolean | null;
  lastProbeDetail: string;
  createdAt: string;
  updatedAt: string;
};

const SHA256_SHAPE = /^[a-f0-9]{64}$/i;

function verdictBadge(p: ProviderRow): { label: string; className: string } {
  if (p.lastProbeOk === true) return { label: "CONNECTED", className: "border-primary/40 text-primary" };
  if (p.lastProbeOk === false) {
    if (p.lastProbeDetail.startsWith("KEY_REJECTED"))
      return { label: "KEY REJECTED", className: "border-destructive/50 text-destructive" };
    if (p.lastProbeDetail.startsWith("TIMEOUT") || p.lastProbeDetail.startsWith("UNREACHABLE"))
      return { label: "UNREACHABLE", className: "border-destructive/50 text-destructive" };
    if (p.lastProbeDetail.startsWith("RATE_LIMITED"))
      return { label: "RATE LIMITED", className: "border-accent/60 text-accent" };
    return { label: "PROBE FAILED", className: "border-destructive/50 text-destructive" };
  }
  return { label: "NOT PROBED", className: "border-border text-muted-foreground" };
}

/** Paste parser: one model per line OR comma/semicolon separated; trimmed, empties dropped. */
function parsePastedModels(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function mergeModels(existing: string[], incoming: string[]): { merged: string[]; skipped: number; capped: boolean } {
  const merged = [...existing];
  let skipped = 0;
  for (const raw of incoming) {
    const id = raw.trim();
    if (!id) continue;
    if (merged.includes(id)) {
      skipped += 1;
      continue;
    }
    if (merged.length >= MAX_MODELS) return { merged, skipped, capped: true };
    merged.push(id);
  }
  return { merged, skipped, capped: false };
}

// ---------------------------------------------------------------------------

type BatchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "add" | "edit";
  initial?: ProviderRow | null;
  onSaved: (id: string, modelProbes: ModelProbe[]) => void;
};

function ProviderBatchDialog({ open, onOpenChange, mode, initial, onSaved }: BatchDialogProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<"openai" | "anthropic">("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [discovered, setDiscovered] = useState<string[] | null>(null);
  const [discoveryMeta, setDiscoveryMeta] = useState<{ truncated: boolean; keyUsed: boolean } | null>(null);
  const [discoverError, setDiscoverError] = useState<{ code: string; detail: string } | null>(null);
  const [filter, setFilter] = useState("");

  const reset = (row: ProviderRow | null) => {
    setName(row?.name ?? "");
    setProtocol(row?.protocol ?? "openai");
    setBaseUrl(row?.baseUrl ?? "");
    setApiKey("");
    const seed = row ? (row.models.length > 0 ? row.models : row.model ? [row.model] : []) : [];
    setSelected(seed);
    setDefaultModel(row?.model && seed.includes(row.model) ? row.model : (seed[0] ?? ""));
    setPasteText("");
    setDiscovered(null);
    setDiscoveryMeta(null);
    setDiscoverError(null);
    setFilter("");
  };

  // Re-seed every time the dialog opens (fresh add OR switching edit targets).
  const [wasOpen, setWasOpen] = useState(false);
  if (open && !wasOpen) {
    setWasOpen(true);
    reset(mode === "edit" ? (initial ?? null) : null);
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  const keyHashed = SHA256_SHAPE.test(apiKey.trim());
  const baseUrlOk = /^https:\/\/.+/.test(baseUrl.trim());
  const canSave =
    name.trim().length >= 1 && baseUrlOk && !keyHashed && selected.length >= 1;

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["custom-providers"] });

  const discover = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/providers/custom/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol,
          baseUrl: baseUrl.trim(),
          ...(mode === "edit" && initial ? { providerId: initial.id } : {}),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; models?: string[]; count?: number; truncated?: boolean; keyUsed?: boolean; error?: { code?: string; message?: string } }
        | null;
      if (!res.ok || !body?.ok) {
        throw new Error(`${body?.error?.code ?? "DISCOVER_FAILED"}: ${body?.error?.message ?? `HTTP ${res.status}`}`);
      }
      return body;
    },
    onSuccess: (data) => {
      const list = data.models ?? [];
      setDiscovered(list);
      setDiscoveryMeta({ truncated: Boolean(data.truncated), keyUsed: Boolean(data.keyUsed) });
      setDiscoverError(null);
      if (list.length <= 12) {
        setSelected((prev) => mergeModels(prev, list).merged);
        if (defaultModel === "" && list.length > 0) setDefaultModel(list[0]);
        toast.success(`Found ${list.length} model${list.length === 1 ? "" : "s"}`, {
          description: "All preselected — untick what you don't want.",
        });
      } else {
        toast.success(`Found ${list.length} models`, {
          description: "Large list — search and pick the ones you want, or use Select all.",
        });
      }
    },
    onError: (e: Error) => {
      const [code, ...rest] = e.message.split(": ");
      const detail = { code: code ?? "DISCOVER_FAILED", detail: rest.join(": ") || e.message };
      setDiscoverError(detail);
      toast.error(`Discover failed — ${detail.code}`, { description: detail.detail });
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        name: name.trim(),
        protocol,
        baseUrl: baseUrl.trim(),
        models: selected,
        defaultModel,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      };
      const res = await fetch(
        mode === "add" ? "/api/providers/custom" : `/api/providers/custom/${initial?.id ?? ""}`,
        {
          method: mode === "add" ? "POST" : "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mode === "add" ? payload : { ...payload, probe: true }),
        },
      );
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; id?: string; probe?: Probe; modelProbes?: ModelProbe[]; error?: { message?: string } }
        | null;
      if (!res.ok || !body?.ok) throw new Error(body?.error?.message ?? `Save failed (HTTP ${res.status})`);
      return { id: body.id ?? initial?.id ?? "", probe: body.probe ?? null, modelProbes: body.modelProbes ?? [] };
    },
    onSuccess: ({ id, probe, modelProbes }) => {
      invalidate();
      onSaved(id, modelProbes);
      onOpenChange(false);
      const okCount = modelProbes.filter((m) => m.ok).length;
      const modelSummary =
        modelProbes.length > 0 ? ` · models ${okCount}/${modelProbes.length} answered` : "";
      const description = probe
        ? `Endpoint: ${probe.code} — ${probe.detail}${modelSummary}`
        : `Stored ${selected.length} model${selected.length === 1 ? "" : "s"}.${modelSummary}`;
      if (modelProbes.length > 0 && okCount === 0 && probe?.ok === false) {
        toast.warning("Provider saved — probes failed", { description });
      } else {
        toast.success(`Provider ${mode === "add" ? "added" : "updated"}`, { description });
      }
    },
    onError: (e: Error) => toast.error(mode === "add" ? "Create failed" : "Update failed", { description: e.message }),
  });

  const toggleModel = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) {
        const next = prev.filter((m) => m !== id);
        if (defaultModel === id) setDefaultModel(next[0] ?? "");
        return next;
      }
      if (prev.length >= MAX_MODELS) return prev;
      if (defaultModel === "") setDefaultModel(id);
      return [...prev, id];
    });
  };

  const removeModel = (id: string) => {
    setSelected((prev) => {
      const next = prev.filter((m) => m !== id);
      if (defaultModel === id) setDefaultModel(next[0] ?? "");
      return next;
    });
  };

  const addPasted = () => {
    const parsed = parsePastedModels(pasteText);
    if (parsed.length === 0) return;
    const { merged, skipped, capped } = mergeModels(selected, parsed);
    setSelected(merged);
    if (defaultModel === "" && merged.length > 0) setDefaultModel(merged[0]);
    setPasteText("");
    if (capped) toast.warning("Model list capped", { description: `At most ${MAX_MODELS} models per provider.` });
    else if (skipped > 0) toast.info(`${parsed.length - skipped} added`, { description: `${skipped} duplicate${skipped === 1 ? "" : "s"} skipped.` });
  };

  const visibleDiscovered = useMemo(() => {
    if (!discovered) return [];
    const q = filter.trim().toLowerCase();
    return q ? discovered.filter((m) => m.toLowerCase().includes(q)) : discovered;
  }, [discovered, filter]);

  const discoverDisabled = !baseUrlOk || discover.isPending;

  return (
    <DialogContent className="flex max-h-[85dvh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
      <DialogHeader className="shrink-0 space-y-1.5 border-b border-border/60 px-5 pb-3 pr-14 pt-5 text-left">
        <DialogTitle className="font-mono">
          {mode === "add" ? "Add a custom provider" : `Edit ${initial?.name ?? "provider"}`}
        </DialogTitle>
        <DialogDescription>
          Batch-add models: discover them from the gateway, or paste the list. One save stores all
          of them and probes the endpoint + first models. Keys are encrypted; masked previews only.
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="cp-name">Name</Label>
            <Input
              id="cp-name"
              className="min-h-11 font-mono"
              placeholder="my-gateway"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cp-protocol">Protocol</Label>
            <Select value={protocol} onValueChange={(v) => setProtocol(v as "openai" | "anthropic")}>
              <SelectTrigger id="cp-protocol" className="min-h-11 w-full font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI-compatible</SelectItem>
                <SelectItem value="anthropic">Anthropic-compatible</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="cp-base">Base URL</Label>
          <Input
            id="cp-base"
            className="min-h-11 font-mono"
            placeholder="https://gateway.example.com/v1"
            inputMode="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <p className="text-[11px] text-muted-foreground">
            Include <span className="font-mono">/v1</span> if the gateway expects it — doubled{" "}
            <span className="font-mono">/v1</span> is prevented automatically.
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="cp-key">
            API key{" "}
            <span className="text-muted-foreground">
              {mode === "edit"
                ? `(stored ${initial?.maskedKey ?? "••••"} — leave empty to keep it)`
                : "(stored encrypted; optional at first)"}
            </span>
          </Label>
          <Input
            id="cp-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="min-h-11 font-mono"
            placeholder="sk-… / raw key exactly as the gateway shows it"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          {keyHashed && (
            <p className="flex items-start gap-1.5 text-xs text-destructive" role="alert">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              That is a 64-hex SHA-256 fingerprint, not a raw key — it can never authenticate. Paste
              the raw key.
            </p>
          )}
        </div>

        {/* --- Step 1: discover from the gateway ------------------------------ */}
        <div className="rounded-md border border-border/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 font-mono text-xs font-semibold">
              <Radar className="size-4 text-primary" aria-hidden="true" />
              Discover models
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 font-mono"
              disabled={discoverDisabled}
              onClick={() => discover.mutate()}
            >
              {discover.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Radar className="size-4" aria-hidden="true" />
              )}
              {discover.isPending ? "Asking gateway…" : "Fetch model list"}
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Calls <span className="font-mono">{"{base}[/v1]/models"}</span> through the panel
            backend with the key above{mode === "edit" ? " (or the stored key)" : ""} — never from
            your browser. Public gateways work without a key.
          </p>
          {discoverError && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-destructive" role="alert">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>
                <span className="font-mono font-semibold">{discoverError.code}</span> —{" "}
                {discoverError.detail}
              </span>
            </p>
          )}

          {discovered && discovered.length > 0 && (
            <div className="mt-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-mono text-[11px] text-muted-foreground">
                  {discovered.length} found · {selected.filter((m) => discovered.includes(m)).length} selected
                  {discoveryMeta?.truncated ? " · list truncated at 100" : ""}
                  {discoveryMeta && !discoveryMeta.keyUsed ? " · no key sent" : ""}
                </p>
                <div className="flex gap-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="min-h-9 font-mono text-xs"
                    onClick={() => {
                      const { merged, capped } = mergeModels(selected, discovered);
                      setSelected(merged);
                      if (defaultModel === "" && merged.length > 0) setDefaultModel(merged[0]);
                      if (capped)
                        toast.warning("Model list capped", { description: `At most ${MAX_MODELS} models per provider.` });
                    }}
                  >
                    Select all
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="min-h-9 font-mono text-xs"
                    onClick={() => {
                      setSelected((prev) => prev.filter((m) => !discovered.includes(m)));
                      if (defaultModel !== "" && discovered.includes(defaultModel)) setDefaultModel("");
                    }}
                  >
                    Clear
                  </Button>
                </div>
              </div>
              {discovered.length > 12 && (
                <Input
                  aria-label="Filter discovered models"
                  className="min-h-11 font-mono text-xs"
                  placeholder="Filter models…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              )}
              {discovered.length > 8 ? (
                <ScrollArea className="h-56 rounded-md border border-border/50 p-2">
                  <div className="flex flex-wrap gap-1.5 pr-3">
                    {visibleDiscovered.map((m) => (
                      <ModelCheckboxChip
                        key={m}
                        model={m}
                        checked={selected.includes(m)}
                        onToggle={() => toggleModel(m)}
                      />
                    ))}
                    {visibleDiscovered.length === 0 && (
                      <p className="px-1 py-2 text-xs text-muted-foreground">No models match that filter.</p>
                    )}
                  </div>
                </ScrollArea>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {visibleDiscovered.map((m) => (
                    <ModelCheckboxChip
                      key={m}
                      model={m}
                      checked={selected.includes(m)}
                      onToggle={() => toggleModel(m)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* --- Step 2: manual batch paste ------------------------------------- */}
        <div className="rounded-md border border-border/60 p-3">
          <Label htmlFor="cp-paste" className="font-mono text-xs font-semibold">
            <span className="flex items-center gap-1.5">
              <ListPlus className="size-4 text-primary" aria-hidden="true" />
              Paste models (batch)
            </span>
          </Label>
          <Textarea
            id="cp-paste"
            className="mt-1.5 min-h-20 font-mono text-xs"
            placeholder={"one per line or comma-separated, e.g.\norcarouter/free: deepseek/deepseek-v4-flash-free\norca/orcaverify-text1.0-free, tencent/hy4-preview-free"}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">Duplicates are skipped automatically.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 font-mono"
              disabled={parsePastedModels(pasteText).length === 0}
              onClick={addPasted}
            >
              <Plus className="size-4" aria-hidden="true" />
              Add to list
            </Button>
          </div>
        </div>

        {/* --- Step 3: the selected batch ------------------------------------- */}
        <div className="rounded-md border border-border/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-xs font-semibold">
              Models <span className="text-muted-foreground">({selected.length})</span>
            </p>
            {selected.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-9 font-mono text-xs"
                onClick={() => {
                  setSelected([]);
                  setDefaultModel("");
                }}
              >
                Clear all
              </Button>
            )}
          </div>
          {selected.length === 0 ? (
            <p className="mt-2 rounded-md border border-dashed border-border/70 p-3 text-xs text-muted-foreground">
              No models yet — discover them above or paste the list. At least one model is required;
              the first one becomes the default used for brain calls.
            </p>
          ) : selected.length > 10 ? (
            <ScrollArea className="mt-2 h-44 rounded-md border border-border/50 p-2">
              <div className="flex flex-wrap gap-1.5 pr-3">
                {selected.map((m) => (
                  <SelectedModelChip
                    key={m}
                    model={m}
                    isDefault={m === defaultModel}
                    onSetDefault={() => setDefaultModel(m)}
                    onRemove={() => removeModel(m)}
                  />
                ))}
              </div>
            </ScrollArea>
          ) : (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {selected.map((m) => (
                <SelectedModelChip
                  key={m}
                  model={m}
                  isDefault={m === defaultModel}
                  onSetDefault={() => setDefaultModel(m)}
                  onRemove={() => removeModel(m)}
                />
              ))}
            </div>
          )}
          {selected.length > 0 && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              ★ marks the default model for brain calls. On save, up to the first {PROBE_BATCH}{" "}
              models get a live 1-token probe.
            </p>
          )}
        </div>
      </div>

      <DialogFooter className="shrink-0 flex-row items-center gap-2 border-t border-border/60 bg-background px-5 py-3">
        <Button
          variant="ghost"
          className="min-h-11 flex-1 sm:flex-none"
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button
          className="min-h-11 flex-1 font-mono sm:flex-none"
          disabled={!canSave || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <PlugZap className="size-4" aria-hidden="true" />
          )}
          {save.isPending
            ? "Saving + probing…"
            : `${mode === "add" ? "Add provider" : "Save"} + probe (${selected.length} model${selected.length === 1 ? "" : "s"})`}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** Discovered model → checkbox chip (label wraps the real Checkbox, shadcn pattern). */
function ModelCheckboxChip({
  model,
  checked,
  onToggle,
}: {
  model: string;
  checked: boolean;
  onToggle: () => void;
}) {
  const reactId = useId();
  const id = `cp-disc${reactId.replace(/:/g, "")}-${model.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 48)}`;
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex min-h-11 max-w-full cursor-pointer items-center gap-2 rounded-md border px-3 py-2 font-mono text-xs transition-colors",
        checked
          ? "border-primary/50 bg-primary/10 text-primary"
          : "border-border/70 bg-background text-foreground/80 hover:border-primary/40",
      )}
    >
      <Checkbox id={id} checked={checked} onCheckedChange={() => onToggle()} className="shrink-0" />
      <span className="truncate" title={model}>
        {model}
      </span>
    </label>
  );
}

/** Selected model chip: ★ = default for brain calls, ✕ removes. */
function SelectedModelChip({
  model,
  isDefault,
  onSetDefault,
  onRemove,
}: {
  model: string;
  isDefault: boolean;
  onSetDefault: () => void;
  onRemove: () => void;
}) {
  return (
    <span
      className={cn(
        "flex min-h-11 max-w-full items-center gap-0.5 rounded-md border py-1 pl-1 pr-2 font-mono text-xs",
        isDefault
          ? "border-primary/60 bg-primary/10 text-primary"
          : "border-border/70 bg-background text-foreground/80",
      )}
    >
      <button
        type="button"
        aria-pressed={isDefault}
        aria-label={`${isDefault ? "Default model" : "Set as default"}: ${model}`}
        onClick={onSetDefault}
        className="flex size-9 shrink-0 items-center justify-center rounded-sm hover:bg-accent"
      >
        <Star className={cn("size-3.5", isDefault && "fill-primary")} aria-hidden="true" />
      </button>
      <span className="max-w-[14rem] truncate" title={model}>
        {model}
      </span>
      <button
        type="button"
        aria-label={`Remove model ${model}`}
        onClick={onRemove}
        className="flex size-9 shrink-0 items-center justify-center rounded-sm hover:bg-destructive/10 hover:text-destructive"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------

export function CustomProvidersCard() {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ProviderRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProviderRow | null>(null);
  // Transient per-model probe verdicts from the last batch save (row-scoped).
  const [probeResults, setProbeResults] = useState<Record<string, ModelProbe[]>>({});

  const providers = useQuery<{ ok: true; providers: ProviderRow[] }>({
    queryKey: ["custom-providers"],
    queryFn: async () => {
      const res = await fetch("/api/providers/custom", { cache: "no-store" });
      if (!res.ok) throw new Error("providers unavailable");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["custom-providers"] });

  const update = useMutation({
    mutationFn: async (args: { id: string; body: Record<string, unknown> }) => {
      const res = await fetch(`/api/providers/custom/${args.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args.body),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: { message?: string } }
        | null;
      if (!res.ok) throw new Error(body?.error?.message ?? `Update failed (HTTP ${res.status})`);
      return null;
    },
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error("Update failed", { description: e.message }),
  });

  const probe = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/providers/custom/${id}/probe`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as { probe?: Probe } | null;
      if (!res.ok) throw new Error("Probe failed");
      return body?.probe ?? null;
    },
    onSuccess: (p) => {
      invalidate();
      if (p) {
        toast[p.ok ? "success" : "error"](`Probe: ${p.code}`, { description: p.detail });
      }
    },
    onError: (e: Error) => toast.error("Probe failed", { description: e.message }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/providers/custom/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
      return res.json();
    },
    onSuccess: () => {
      setDeleteTarget(null);
      invalidate();
      toast.success("Provider removed");
    },
    onError: (e: Error) => toast.error("Delete failed", { description: e.message }),
  });

  const rows = providers.data?.providers ?? [];

  return (
    <Card>
      <Toaster position="bottom-right" richColors closeButton />
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 font-mono">
            <Boxes className="size-5 text-primary" aria-hidden="true" />
            Custom providers
          </CardTitle>
          <CardDescription>
            Your own brain gateways beyond Vyce/Groq — OpenAI-compatible or Anthropic-compatible,
            with explicit endpoint, key and a batch model list. Discover models from the gateway or
            paste them; one save probes the endpoint plus the first models.
          </CardDescription>
        </div>
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button className="min-h-11 shrink-0 font-mono">
              <Plus className="size-4" aria-hidden="true" />
              Add provider
            </Button>
          </DialogTrigger>
          <ProviderBatchDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            mode="add"
            onSaved={(id, modelProbes) => setProbeResults((prev) => ({ ...prev, [id]: modelProbes }))}
          />
        </Dialog>
      </CardHeader>

      <CardContent className="space-y-3">
        {providers.isLoading ? (
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="h-14 rounded-md" />
            <Skeleton className="h-14 rounded-md" />
          </div>
        ) : providers.isError ? (
          <p className="text-sm text-destructive" role="alert">
            Provider list unavailable — retrying automatically.
          </p>
        ) : rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
            No custom providers yet. Add one to route brain calls through your own OpenAI- or
            Anthropic-compatible gateway — with the whole model list in one go.
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((p) => {
              const vb = verdictBadge(p);
              const models = p.models.length > 0 ? p.models : p.model ? [p.model] : [];
              const rowProbes = probeResults[p.id] ?? [];
              return (
                <li key={p.id} className="rounded-md border border-border/60 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0 space-y-0.5">
                      <p className="flex flex-wrap items-center gap-2 font-mono text-sm">
                        <span className="font-semibold">{p.name}</span>
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {p.protocol === "openai" ? "OpenAI-compat" : "Anthropic-compat"}
                        </Badge>
                        <Badge variant="outline" className={cn("font-mono text-[10px]", vb.className)}>
                          {vb.label}
                        </Badge>
                        {!p.enabled && (
                          <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
                            DISABLED
                          </Badge>
                        )}
                      </p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {p.baseUrl}
                        {` · ${models.length} model${models.length === 1 ? "" : "s"}`}
                        {` · key ${p.keyPresent ? (p.maskedKey ?? "stored") : "not stored"}`}
                      </p>
                      {models.length > 0 && (
                        <p className="flex flex-wrap items-center gap-1 pt-0.5">
                          {models.slice(0, 4).map((m) => (
                            <Badge
                              key={m}
                              variant="outline"
                              className={cn(
                                "max-w-[13rem] font-mono text-[10px]",
                                m === p.model ? "border-primary/40 text-primary" : "border-border/70 text-muted-foreground",
                              )}
                            >
                              <span className="truncate">{m === p.model ? `★ ${m}` : m}</span>
                            </Badge>
                          ))}
                          {models.length > 4 && (
                            <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
                              +{models.length - 4} more
                            </Badge>
                          )}
                        </p>
                      )}
                      {p.lastProbeDetail && (
                        <p className="max-w-prose text-[11px] text-muted-foreground">
                          {p.lastProbeDetail}
                          {p.lastProbeAt ? (
                            <>
                              {" · "}
                              <time dateTime={p.lastProbeAt} suppressHydrationWarning>
                                {formatDistanceToNow(new Date(p.lastProbeAt), { addSuffix: true })}
                              </time>
                            </>
                          ) : null}
                        </p>
                      )}
                      {rowProbes.length > 0 && (
                        <p className="flex flex-wrap items-center gap-1 pt-0.5">
                          <span className="font-mono text-[10px] text-muted-foreground">model probes:</span>
                          {rowProbes.map((mp) => (
                            <Badge
                              key={mp.model}
                              variant="outline"
                              className={cn(
                                "max-w-[13rem] font-mono text-[10px]",
                                mp.ok
                                  ? "border-primary/40 text-primary"
                                  : "border-destructive/50 text-destructive",
                              )}
                              title={`${mp.code} — ${mp.detail}`}
                            >
                              <span className="truncate">
                                {mp.ok ? <Check className="mr-0.5 inline size-3" aria-hidden="true" /> : null}
                                {mp.model} {mp.ok ? "ok" : `✗ ${mp.code}`}
                              </span>
                            </Badge>
                          ))}
                          {models.length > PROBE_BATCH && (
                            <span className="font-mono text-[10px] text-muted-foreground">
                              (first {PROBE_BATCH} of {models.length})
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <div className="mr-1 flex items-center gap-1.5">
                        <Switch
                          checked={p.enabled}
                          aria-label={`${p.enabled ? "Disable" : "Enable"} provider ${p.name}`}
                          disabled={update.isPending}
                          onCheckedChange={(v) => update.mutate({ id: p.id, body: { enabled: v } })}
                        />
                        <span className="hidden text-[11px] text-muted-foreground sm:inline">
                          {p.enabled ? "enabled" : "disabled"}
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-11 font-mono"
                        disabled={probe.isPending}
                        onClick={() => probe.mutate(p.id)}
                        aria-label={`Probe ${p.name}`}
                      >
                        <PlugZap className="size-4" aria-hidden="true" />
                        Probe
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="min-h-11"
                        aria-label={`Edit ${p.name}`}
                        onClick={() => setEditTarget(p)}
                      >
                        <Wrench className="size-4" aria-hidden="true" />
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="min-h-11 text-destructive hover:text-destructive"
                        aria-label={`Delete ${p.name}`}
                        onClick={() => setDeleteTarget(p)}
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Edit reuses the same batch dialog (chips editor, discover with the stored key). */}
        <Dialog open={editTarget !== null} onOpenChange={(v) => !v && setEditTarget(null)}>
          {editTarget && (
            <ProviderBatchDialog
              open={editTarget !== null}
              onOpenChange={(v) => !v && setEditTarget(null)}
              mode="edit"
              initial={editTarget}
              onSaved={(id, modelProbes) => setProbeResults((prev) => ({ ...prev, [id]: modelProbes }))}
            />
          )}
        </Dialog>

        <Dialog open={deleteTarget !== null} onOpenChange={(v) => !v && setDeleteTarget(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="font-mono">Remove provider?</DialogTitle>
              <DialogDescription>
                {deleteTarget?.name} and its stored key will be removed from the panel. This cannot
                be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" className="min-h-11" onClick={() => setDeleteTarget(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                className="min-h-11 font-mono"
                disabled={remove.isPending}
                onClick={() => deleteTarget && remove.mutate(deleteTarget.id)}
              >
                {remove.isPending ? "Removing…" : "Remove"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <p className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <RefreshCw className="size-3" aria-hidden="true" />
          Brain calls route through chatCompleteCustom(providerId) — the KICK bot integration
          consumes these rows directly.
        </p>
      </CardContent>
    </Card>
  );
}
