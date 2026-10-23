"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Activity, Boxes, KeyRound, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

/**
 * Task 16-b — "Custom AI providers" card. A general, always-available section:
 * the owner can register ANY OpenAI-style or Anthropic-style endpoint
 * (base URL + key + models) and use it. Not gated on any connector — works
 * with an empty vault (a key is optional at config time; calls honestly fail
 * with NO_KEY until one is stored).
 *
 * Honest states only: a probe badge is rendered ONLY from a measured response
 * (models count on success; the typed failure code + message otherwise). Keys
 * live encrypted in the vault — the card only ever receives a masked preview
 * and a password input is used for entry (P7).
 *
 * Client validation mirrors src/lib/ai/custom-providers.ts (that module is
 * server-only — it imports node:crypto/db — so the small validators are
 * deliberately duplicated here, kept byte-equal in behavior).
 */

// ---------------------------------------------------------------------------
// Types (mirror of the API contracts)
// ---------------------------------------------------------------------------

type ProviderStyle = "openai" | "anthropic";

type ProviderRowData = {
  slug: string;
  name: string;
  style: ProviderStyle;
  baseUrl: string;
  models: string[];
  hasKey: boolean;
  maskedKey: string | null;
  updatedAt: string | null;
};

type ProvidersResponse = { ok: true; providers: ProviderRowData[] };

type ProbeFailure =
  | { ok: false; code: string; httpStatus: number | null; message: string };

type ProbeResult =
  | { ok: true; httpStatus: number; models: string[] }
  | ProbeFailure;

type ApiErrorShape = { ok: false; error: { code: string; message: string } };

// ---------------------------------------------------------------------------
// Validators — byte-mirrors of src/lib/ai/custom-providers.ts
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

function isValidBaseUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 512) return false;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  if (u.protocol === "http:") {
    const host = u.hostname.toLowerCase();
    if (host !== "localhost" && host !== "127.0.0.1") return false;
  }
  return true;
}

function parseModelsInput(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[\n,]+/)) {
    const id = part.trim().slice(0, 128);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 64) break;
  }
  return out;
}

function normalizeKeyInput(value: string): string | null {
  let key = value.trim();
  if (key.length >= 2) {
    const first = key[0];
    const last = key[key.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      key = key.slice(1, -1).trim();
    }
  }
  if (key.length < 8 || key.length > 4096) return null;
  return key;
}

/** Extracts the §11 message from a failed response body. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as ApiErrorShape | null;
  return body?.error?.message ?? fallback;
}

// ---------------------------------------------------------------------------
// Shared form (add + edit)
// ---------------------------------------------------------------------------

type FormValues = {
  name: string;
  style: ProviderStyle;
  baseUrl: string;
  keyText: string;
  modelsText: string;
};

const EMPTY_FORM: FormValues = { name: "", style: "openai", baseUrl: "", keyText: "", modelsText: "" };

function StyleSelect({
  value,
  onChange,
  id,
}: {
  value: ProviderStyle;
  onChange: (v: ProviderStyle) => void;
  id: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v === "anthropic" ? "anthropic" : "openai")}>
      <SelectTrigger id={id} className="min-h-11 w-full font-mono" aria-label="Provider style">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="openai">OpenAI-compatible</SelectItem>
        <SelectItem value="anthropic">Anthropic-style</SelectItem>
      </SelectContent>
    </Select>
  );
}

function ProviderFormFields({
  values,
  errors,
  onValues,
  slugPreview,
  includeKey,
}: {
  values: FormValues;
  errors: Record<string, string>;
  onValues: (next: FormValues) => void;
  slugPreview: string;
  includeKey: boolean;
}) {
  const set = (patch: Partial<FormValues>) => onValues({ ...values, ...patch });
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="cp-name">Name</Label>
        <Input
          id="cp-name"
          type="text"
          autoComplete="off"
          spellCheck={false}
          className="min-h-11"
          placeholder="My LLM gateway"
          value={values.name}
          onChange={(e) => set({ name: e.target.value })}
          aria-invalid={errors.name ? true : undefined}
        />
        <p className={cn("font-mono text-[11px]", errors.slug ? "text-destructive" : "text-muted-foreground")}>
          slug: {slugPreview || "—"}
          {errors.slug ? ` — ${errors.slug}` : ""}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cp-style">Style</Label>
        <StyleSelect id="cp-style" value={values.style} onChange={(v) => set({ style: v })} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cp-base-url">Base URL</Label>
        <Input
          id="cp-base-url"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          className="min-h-11 font-mono"
          placeholder="https://api.example.com/v1"
          value={values.baseUrl}
          onChange={(e) => set({ baseUrl: e.target.value })}
          aria-invalid={errors.baseUrl ? true : undefined}
        />
        {errors.baseUrl ? (
          <p className="text-xs text-destructive">{errors.baseUrl}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            https:// required — http:// allowed only for localhost / 127.0.0.1 local runners.
          </p>
        )}
      </div>

      {includeKey && (
        <div className="space-y-1.5">
          <Label htmlFor="cp-key">
            API key <span className="text-muted-foreground">(optional now — add any time)</span>
          </Label>
          <Input
            id="cp-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="min-h-11 font-mono"
            placeholder="sk-…"
            value={values.keyText}
            onChange={(e) => set({ keyText: e.target.value })}
            aria-invalid={errors.keyText ? true : undefined}
          />
          {errors.keyText ? (
            <p className="text-xs text-destructive">{errors.keyText}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Encrypted in the vault — never displayed again, masked preview only.
            </p>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="cp-models">
          Models <span className="text-muted-foreground">(optional — one per line or comma-separated)</span>
        </Label>
        <Textarea
          id="cp-models"
          rows={3}
          spellCheck={false}
          className="min-h-11 font-mono text-xs"
          placeholder={"model-a\nmodel-b"}
          value={values.modelsText}
          onChange={(e) => set({ modelsText: e.target.value })}
          aria-invalid={errors.modelsText ? true : undefined}
        />
        {errors.modelsText ? <p className="text-xs text-destructive">{errors.modelsText}</p> : null}
      </div>
    </div>
  );
}

function validate(values: FormValues, existingSlugs: ReadonlySet<string>): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = values.name.trim();
  if (name.length < 1 || name.length > 64) {
    errors.name = "Name must be 1–64 characters.";
  }
  const slug = slugifyName(name);
  if (!SLUG_RE.test(slug)) {
    errors.slug = "Name must produce a slug of 2–32 lowercase letters, digits or hyphens.";
  } else if (existingSlugs.has(slug)) {
    errors.slug = "A provider with this name already exists — edit it instead.";
  }
  if (!isValidBaseUrl(values.baseUrl)) {
    errors.baseUrl = "Must be a valid https:// URL (http:// only for localhost / 127.0.0.1).";
  }
  if (values.keyText.trim().length > 0 && !normalizeKeyInput(values.keyText)) {
    errors.keyText = "Key must be 8–4096 characters.";
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Add form
// ---------------------------------------------------------------------------

function AddProviderForm({
  existingSlugs,
  onDone,
}: {
  existingSlugs: ReadonlySet<string>;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<FormValues>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const create = useMutation({
    mutationFn: async (input: FormValues) => {
      const slug = slugifyName(input.name.trim());
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          name: input.name.trim(),
          style: input.style,
          baseUrl: input.baseUrl.trim(),
          models: parseModelsInput(input.modelsText),
        }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, `Save failed (HTTP ${res.status})`));

      const key = normalizeKeyInput(input.keyText);
      if (key) {
        const kres = await fetch(`/api/providers/${slug}/key`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key }),
        });
        if (!kres.ok) {
          throw new Error(
            await errorMessage(kres, `Provider saved but the key could not be stored (HTTP ${kres.status})`),
          );
        }
      }
      return { slug, withKey: key !== null };
    },
    onSuccess: (data) => {
      setValues(EMPTY_FORM);
      setErrors({});
      void queryClient.invalidateQueries({ queryKey: ["providers"], exact: true });
      toast({
        title: `Provider "${data.slug}" saved`,
        description: data.withKey
          ? "Config + key stored (key encrypted in the vault). Probe it to verify."
          : "Config stored. Add a key any time — probing works either way.",
      });
      onDone();
    },
    onError: (e: Error) =>
      toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const submit = () => {
    const errs = validate(values, existingSlugs);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    create.mutate(values);
  };

  const slugPreview = slugifyName(values.name.trim());

  return (
    <form
      className="space-y-3 rounded-md border border-border/60 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="font-mono text-sm">add provider</p>
      <ProviderFormFields
        values={values}
        errors={errors}
        onValues={setValues}
        slugPreview={slugPreview}
        includeKey
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="min-h-11 flex-1 font-mono sm:flex-none" disabled={create.isPending}>
          {create.isPending ? "Saving…" : "Save provider"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          onClick={() => {
            setValues(EMPTY_FORM);
            setErrors({});
            onDone();
          }}
        >
          <X className="size-4" aria-hidden="true" />
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Per-provider row
// ---------------------------------------------------------------------------

function styleBadgeClass(style: ProviderStyle): string {
  return style === "anthropic" ? "border-accent/60 text-accent" : "border-primary/40 text-primary";
}

function probeBadge(result: ProbeResult): { label: string; className: string } {
  if (result.ok) {
    return {
      label: `${result.models.length} model${result.models.length === 1 ? "" : "s"} · HTTP ${result.httpStatus}`,
      className: "border-primary/40 text-primary",
    };
  }
  return { label: `${result.code}${result.httpStatus !== null ? ` · HTTP ${result.httpStatus}` : ""}`, className: "border-destructive/50 text-destructive" };
}

function ProviderRow({ row }: { row: ProviderRowData }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [removeArmed, setRemoveArmed] = useState(false);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["providers"], exact: true });

  const probeMutation = useMutation({
    mutationFn: async (): Promise<ProbeResult> => {
      const res = await fetch(`/api/providers/${row.slug}/probe`, { method: "POST" });
      if (!res.ok) throw new Error(await errorMessage(res, `Probe failed (HTTP ${res.status})`));
      const body = (await res.json()) as { ok: true; probe: ProbeResult };
      return body.probe;
    },
    onSuccess: (result) => setProbe(result),
    onError: (e: Error) =>
      toast({ title: "Probe failed", description: e.message, variant: "destructive" }),
  });

  const saveKey = useMutation({
    mutationFn: async (key: string) => {
      const res = await fetch(`/api/providers/${row.slug}/key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, `Key save failed (HTTP ${res.status})`));
      return res.json();
    },
    onSuccess: () => {
      setKeyInput("");
      setKeyError(null);
      setKeyOpen(false);
      invalidate();
      toast({ title: "Key stored", description: "Encrypted in the vault — masked preview only." });
    },
    onError: (e: Error) => setKeyError(e.message),
  });

  const removeKey = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/providers/${row.slug}/key`, { method: "DELETE" });
      if (!res.ok) throw new Error(await errorMessage(res, `Key removal failed (HTTP ${res.status})`));
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Key removed", description: "The vault entry was deleted. Config kept." });
    },
    onError: (e: Error) =>
      toast({ title: "Key removal failed", description: e.message, variant: "destructive" }),
  });

  const removeProvider = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/providers/${row.slug}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await errorMessage(res, `Removal failed (HTTP ${res.status})`));
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: `Provider "${row.slug}" removed`, description: "Config and stored key were deleted." });
    },
    onError: (e: Error) => {
      setRemoveArmed(false);
      toast({ title: "Removal failed", description: e.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-3 rounded-md border border-border/60 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-sm">{row.name}</p>
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
            <span className="font-mono [overflow-wrap:anywhere]">{row.baseUrl}</span>
          </p>
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
            <span>{row.slug}</span>
            <span aria-hidden="true">·</span>
            {row.hasKey && row.maskedKey ? (
              <span className="flex items-center gap-1">
                <KeyRound className="size-3" aria-hidden="true" />
                {row.maskedKey}
                {row.updatedAt ? (
                  <time dateTime={row.updatedAt} suppressHydrationWarning>
                    · saved {formatDistanceToNow(new Date(row.updatedAt), { addSuffix: true })}
                  </time>
                ) : null}
              </span>
            ) : (
              <span>no key — add</span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge variant="outline" className={cn("font-mono text-[10px]", styleBadgeClass(row.style))}>
            {row.style === "anthropic" ? "ANTHROPIC" : "OPENAI"}
          </Badge>
        </div>
      </div>

      {/* Probe — honest inline result, rendered only from a measured response. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 font-mono"
          disabled={probeMutation.isPending}
          onClick={() => probeMutation.mutate()}
        >
          <RefreshCw className={cn("size-4", probeMutation.isPending && "animate-spin")} aria-hidden="true" />
          {probeMutation.isPending ? "Probing…" : "Probe"}
        </Button>
        {probe && !probeMutation.isPending ? (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" aria-live="polite">
            <Badge variant="outline" className={cn("shrink-0 font-mono text-[10px]", probeBadge(probe).className)}>
              <Activity className="mr-1 size-3" aria-hidden="true" />
              {probeBadge(probe).label}
            </Badge>
            {!probe.ok ? (
              <span className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {probe.message}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Model list — measured from the last successful probe, or config-declared. */}
      {probe?.ok && probe.models.length > 0 ? (
        <div className="space-y-1">
          <p className="font-mono text-[11px] text-muted-foreground">measured models (live probe)</p>
          <ul className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-border/60 p-2 font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere] [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar]:w-1.5">
            {probe.models.map((m) => (
              <li key={m} className="truncate">
                {m}
              </li>
            ))}
          </ul>
        </div>
      ) : row.models.length > 0 ? (
        <div className="space-y-1">
          <p className="font-mono text-[11px] text-muted-foreground">configured models</p>
          <ul className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-border/60 p-2 font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere] [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar]:w-1.5">
            {row.models.map((m) => (
              <li key={m} className="truncate">
                {m}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Row actions */}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-11"
          aria-expanded={editOpen}
          onClick={() => {
            setEditOpen((v) => !v);
            setKeyOpen(false);
          }}
        >
          <Pencil className="size-4" aria-hidden="true" />
          Edit
        </Button>
        {row.hasKey ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11"
            aria-expanded={keyOpen}
            onClick={() => {
              setKeyOpen((v) => !v);
              setKeyError(null);
            }}
          >
            <KeyRound className="size-4" aria-hidden="true" />
            Replace key
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11"
            aria-expanded={keyOpen}
            onClick={() => {
              setKeyOpen((v) => !v);
              setKeyError(null);
            }}
          >
            <KeyRound className="size-4" aria-hidden="true" />
            Add key
          </Button>
        )}
        {row.hasKey ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11 text-destructive hover:text-destructive"
            disabled={removeKey.isPending}
            aria-label={`Remove the stored key for ${row.name}`}
            onClick={() => removeKey.mutate()}
          >
            <Trash2 className="size-4" aria-hidden="true" />
            Remove key
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn("min-h-11", removeArmed ? "text-destructive hover:text-destructive" : "text-destructive/80 hover:text-destructive")}
          disabled={removeProvider.isPending}
          aria-label={`Remove provider ${row.name}`}
          onClick={() => {
            if (removeArmed) {
              removeProvider.mutate();
            } else {
              setRemoveArmed(true);
              window.setTimeout(() => setRemoveArmed(false), 4000);
            }
          }}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          {removeArmed ? "Confirm remove?" : "Remove"}
        </Button>
      </div>

      {/* Inline key editor */}
      {keyOpen ? (
        <form
          className="space-y-2 rounded-md border border-border/60 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            const key = normalizeKeyInput(keyInput);
            if (!key) {
              setKeyError("Key must be 8–4096 characters (wrapping quotes are stripped).");
              return;
            }
            setKeyError(null);
            saveKey.mutate(key);
          }}
        >
          <Label htmlFor={`cp-key-${row.slug}`}>
            {row.hasKey ? "Replace API key" : "API key"} <span className="text-muted-foreground">(password field — never shown again)</span>
          </Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id={`cp-key-${row.slug}`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="min-h-11 font-mono"
              placeholder="sk-…"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              aria-invalid={keyError ? true : undefined}
            />
            <Button type="submit" className="min-h-11 shrink-0 font-mono" disabled={saveKey.isPending || keyInput.trim().length < 8}>
              {saveKey.isPending ? "Saving…" : "Save key"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 shrink-0"
              onClick={() => {
                setKeyOpen(false);
                setKeyInput("");
                setKeyError(null);
              }}
            >
              Cancel
            </Button>
          </div>
          {keyError ? <p className="text-xs text-destructive">{keyError}</p> : null}
        </form>
      ) : null}

      {/* Inline edit form (slug is the immutable identity — name/style/baseUrl/models editable) */}
      {editOpen ? (
        <EditProviderForm row={row} onDone={() => setEditOpen(false)} />
      ) : null}
    </div>
  );
}

function EditProviderForm({ row, onDone }: { row: ProviderRowData; onDone: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<FormValues>({
    name: row.name,
    style: row.style,
    baseUrl: row.baseUrl,
    keyText: "",
    modelsText: row.models.join("\n"),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const update = useMutation({
    mutationFn: async (input: FormValues) => {
      const res = await fetch(`/api/providers/${row.slug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: input.name.trim(),
          style: input.style,
          baseUrl: input.baseUrl.trim(),
          models: parseModelsInput(input.modelsText),
        }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, `Update failed (HTTP ${res.status})`));
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["providers"], exact: true });
      toast({ title: `Provider "${row.slug}" updated`, description: "Config saved. The stored key was untouched." });
      onDone();
    },
    onError: (e: Error) =>
      toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  // Edit never touches the key and never re-checks slug collisions against
  // itself — the slug identity is immutable, so only name length is validated.
  const submit = () => {
    const errs: Record<string, string> = {};
    const name = values.name.trim();
    if (name.length < 1 || name.length > 64) errs.name = "Name must be 1–64 characters.";
    if (!isValidBaseUrl(values.baseUrl)) errs.baseUrl = "Must be a valid https:// URL (http:// only for localhost / 127.0.0.1).";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    update.mutate(values);
  };

  return (
    <form
      className="space-y-3 rounded-md border border-border/60 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="font-mono text-sm">
        edit <span className="text-muted-foreground">{row.slug}</span>
      </p>
      <ProviderFormFields
        values={values}
        errors={errors}
        onValues={setValues}
        slugPreview={row.slug}
        includeKey={false}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="min-h-11 flex-1 font-mono sm:flex-none" disabled={update.isPending}>
          {update.isPending ? "Saving…" : "Save changes"}
        </Button>
        <Button type="button" variant="ghost" className="min-h-11" onClick={onDone}>
          <X className="size-4" aria-hidden="true" />
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export function CustomProvidersCard() {
  const providers = useQuery<ProvidersResponse>({
    queryKey: ["providers"],
    queryFn: async () => {
      const res = await fetch("/api/providers", { cache: "no-store" });
      if (!res.ok) throw new Error("providers unavailable");
      return res.json() as Promise<ProvidersResponse>;
    },
    refetchInterval: 30_000,
  });

  const rows = providers.data?.providers ?? [];
  const slugs = new Set(rows.map((r) => r.slug));
  // Calm default: the add form is open when the section is empty, collapsed otherwise.
  const [addOpen, setAddOpen] = useState<boolean | null>(null);
  const formOpen = addOpen ?? rows.length === 0;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 font-mono">
            <Boxes className="size-5 text-primary" aria-hidden="true" />
            Custom AI providers
          </CardTitle>
          <CardDescription>
            Any OpenAI-style or Anthropic-style endpoint — always available, keys encrypted in the
            vault, never displayed.
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-11 shrink-0"
          aria-label={formOpen ? "Close the add-provider form" : "Add a custom provider"}
          onClick={() => setAddOpen(!formOpen)}
        >
          {formOpen ? <X className="size-4" aria-hidden="true" /> : <Plus className="size-4" aria-hidden="true" />}
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {providers.isLoading ? (
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="h-12 rounded-md" />
            <Skeleton className="h-9 rounded-md" />
            <Skeleton className="h-9 w-2/3 rounded-md" />
          </div>
        ) : providers.isError ? (
          <p className="text-sm text-destructive" role="alert">
            Provider list unavailable — retrying automatically.
          </p>
        ) : (
          <div className="space-y-4" aria-live="polite">
            {rows.length === 0 && !formOpen ? (
              <p className="rounded-md border border-border/60 p-3 text-sm text-muted-foreground">
                No custom providers yet — add any OpenAI-style or Anthropic-style endpoint. Nothing
                here gates the rest of the panel.
              </p>
            ) : null}

            <div className="space-y-3">
              {rows.map((row) => (
                <ProviderRow key={row.slug} row={row} />
              ))}
            </div>

            {formOpen ? (
              <AddProviderForm existingSlugs={slugs} onDone={() => setAddOpen(false)} />
            ) : (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 w-full font-mono"
                onClick={() => setAddOpen(true)}
              >
                <Plus className="size-4" aria-hidden="true" />
                Add provider
              </Button>
            )}

            <p className="font-mono text-[11px] text-muted-foreground">
              chat calls are non-streaming and follow egress.routing “default” · probe = GET
              /models (openai) or /v1/models (anthropic) · 8s timeout
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
