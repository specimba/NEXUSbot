"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import { Toaster } from "@/components/ui/sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  Boxes,
  PlugZap,
  Plus,
  RefreshCw,
  Trash2,
  Wrench,
} from "lucide-react";

/**
 * Custom brain providers (owner-defined) — OpenAI-compatible OR
 * Anthropic-compatible gateways with explicit endpoint + model + key. This is
 * the entry point the owner explicitly flagged as missing from the previous
 * build; rows live in the CustomProvider table, keys in the same AES-256-GCM
 * envelope as the vault (masked previews only, never re-displayed).
 *
 * The brain consumes these rows via chatCompleteCustom(providerId, …) — the
 * KICK bot integration routes through it, so a working probe here means the
 * bot can use the gateway end-to-end.
 */

type Probe = { ok: boolean; code: string; detail: string };

type ProviderRow = {
  id: string;
  name: string;
  protocol: "openai" | "anthropic";
  baseUrl: string;
  model: string;
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

type FormState = {
  name: string;
  protocol: "openai" | "anthropic";
  baseUrl: string;
  model: string;
  apiKey: string;
};

const EMPTY_FORM: FormState = { name: "", protocol: "openai", baseUrl: "", model: "", apiKey: "" };

export function CustomProvidersCard() {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);
  const [deleteTarget, setDeleteTarget] = useState<ProviderRow | null>(null);

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

  const keyHashed = (f: FormState) => SHA256_SHAPE.test(f.apiKey.trim());

  const create = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/providers/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          protocol: form.protocol,
          baseUrl: form.baseUrl.trim(),
          model: form.model.trim(),
          ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: { message?: string }; probe?: Probe }
        | null;
      if (!res.ok) throw new Error(body?.error?.message ?? `Create failed (HTTP ${res.status})`);
      return body?.probe ?? null;
    },
    onSuccess: (probe) => {
      setForm(EMPTY_FORM);
      setAddOpen(false);
      invalidate();
      toast.success("Custom provider added", {
        description: probe
          ? `Probe: ${probe.code} — ${probe.detail}`
          : "Stored. Run a probe to verify the endpoint.",
      });
    },
    onError: (e: Error) => toast.error("Create failed", { description: e.message }),
  });

  const update = useMutation({
    mutationFn: async (args: { id: string; body: Record<string, unknown> }) => {
      const res = await fetch(`/api/providers/custom/${args.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args.body),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: { message?: string }; probe?: Probe }
        | null;
      if (!res.ok) throw new Error(body?.error?.message ?? `Update failed (HTTP ${res.status})`);
      return body?.probe ?? null;
    },
    onSuccess: (_data, args) => {
      if (args.body.name !== undefined || args.body.baseUrl !== undefined) {
        setEditingId(null);
        setEditForm(EMPTY_FORM);
      }
      invalidate();
    },
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
  const addInvalid = useMemo(
    () =>
      form.name.trim().length < 1 ||
      !/^https:\/\/.+/.test(form.baseUrl.trim()) ||
      keyHashed(form),
    [form],
  );

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
            Your own brain gateways beyond Vyce/Groq — OpenAI-compatible or
            Anthropic-compatible, with explicit endpoint, model and key. Keys are
            encrypted in the vault; masked previews only.
          </CardDescription>
        </div>
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button className="min-h-11 shrink-0 font-mono">
              <Plus className="size-4" aria-hidden="true" />
              Add provider
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="font-mono">Add a custom provider</DialogTitle>
              <DialogDescription>
                OpenAI-compatible → Bearer key against{" "}
                <span className="font-mono">{"{base}[/v1]/chat/completions"}</span>. Anthropic-compatible →{" "}
                <span className="font-mono">{"{base}[/v1]/messages"}</span> with{" "}
                <span className="font-mono">x-api-key</span>.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="cp-name">Name</Label>
                <Input
                  id="cp-name"
                  className="min-h-11 font-mono"
                  placeholder="my-gateway"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="cp-protocol">Protocol</Label>
                <Select
                  value={form.protocol}
                  onValueChange={(v) => setForm({ ...form, protocol: v as FormState["protocol"] })}
                >
                  <SelectTrigger id="cp-protocol" className="min-h-11 w-full font-mono">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">OpenAI-compatible</SelectItem>
                    <SelectItem value="anthropic">Anthropic-compatible</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="cp-base">Base URL</Label>
                <Input
                  id="cp-base"
                  className="min-h-11 font-mono"
                  placeholder="https://gateway.example.com/v1"
                  inputMode="url"
                  value={form.baseUrl}
                  onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                />
                <p className="text-[11px] text-muted-foreground">
                  Include <span className="font-mono">/v1</span> if the gateway expects it — doubled{" "}
                  <span className="font-mono">/v1</span> is prevented automatically.
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="cp-model">
                  Model <span className="text-muted-foreground">(default model id)</span>
                </Label>
                <Input
                  id="cp-model"
                  className="min-h-11 font-mono"
                  placeholder="e.g. deepseek-v4-flash or claude-sonnet-4-6"
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="cp-key">
                  API key <span className="text-muted-foreground">(stored encrypted; optional at first)</span>
                </Label>
                <Input
                  id="cp-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  className="min-h-11 font-mono"
                  placeholder="sk-… / raw key exactly as the gateway shows it"
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                />
                {keyHashed(form) && (
                  <p className="flex items-start gap-1.5 text-xs text-destructive" role="alert">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    That is a 64-hex SHA-256 fingerprint, not a raw key — it can never
                    authenticate. Paste the raw key.
                  </p>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" className="min-h-11" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button className="min-h-11 font-mono" disabled={addInvalid || create.isPending} onClick={() => create.mutate()}>
                {create.isPending ? "Adding…" : "Add + probe"}
              </Button>
            </DialogFooter>
          </DialogContent>
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
            No custom providers yet. Add one to route brain calls through your own
            OpenAI- or Anthropic-compatible gateway.
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((p) => {
              const vb = verdictBadge(p);
              const editing = editingId === p.id;
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
                        {p.model ? ` · model ${p.model}` : " · no default model"}
                        {` · key ${p.keyPresent ? (p.maskedKey ?? "stored") : "not stored"}`}
                      </p>
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
                        onClick={() => {
                          if (editing) {
                            setEditingId(null);
                          } else {
                            setEditingId(p.id);
                            setEditForm({
                              name: p.name,
                              protocol: p.protocol,
                              baseUrl: p.baseUrl,
                              model: p.model,
                              apiKey: "",
                            });
                          }
                        }}
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

                  {editing && (
                    <div className="mt-3 grid gap-2 border-t border-border/60 pt-3">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div className="grid gap-1.5">
                          <Label htmlFor={`cp-${p.id}-name`}>Name</Label>
                          <Input
                            id={`cp-${p.id}-name`}
                            className="min-h-11 font-mono"
                            value={editForm.name}
                            onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                          />
                        </div>
                        <div className="grid gap-1.5">
                          <Label htmlFor={`cp-${p.id}-model`}>Model</Label>
                          <Input
                            id={`cp-${p.id}-model`}
                            className="min-h-11 font-mono"
                            value={editForm.model}
                            onChange={(e) => setEditForm({ ...editForm, model: e.target.value })}
                          />
                        </div>
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor={`cp-${p.id}-base`}>Base URL</Label>
                        <Input
                          id={`cp-${p.id}-base`}
                          className="min-h-11 font-mono"
                          inputMode="url"
                          value={editForm.baseUrl}
                          onChange={(e) => setEditForm({ ...editForm, baseUrl: e.target.value })}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor={`cp-${p.id}-key`}>
                          Replace API key <span className="text-muted-foreground">(leave empty to keep the stored one)</span>
                        </Label>
                        <Input
                          id={`cp-${p.id}-key`}
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          className="min-h-11 font-mono"
                          value={editForm.apiKey}
                          onChange={(e) => setEditForm({ ...editForm, apiKey: e.target.value })}
                        />
                        {keyHashed(editForm) && (
                          <p className="flex items-start gap-1.5 text-xs text-destructive" role="alert">
                            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                            SHA-256 fingerprint detected — paste the raw key instead.
                          </p>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          className="min-h-11 font-mono"
                          disabled={
                            editForm.name.trim().length < 1 ||
                            !/^https:\/\/.+/.test(editForm.baseUrl.trim()) ||
                            keyHashed(editForm) ||
                            update.isPending
                          }
                          onClick={() =>
                            update.mutate({
                              id: p.id,
                              body: {
                                name: editForm.name.trim(),
                                baseUrl: editForm.baseUrl.trim(),
                                model: editForm.model.trim(),
                                protocol: editForm.protocol,
                                ...(editForm.apiKey.trim() ? { apiKey: editForm.apiKey.trim() } : {}),
                                probe: true,
                              },
                            })
                          }
                        >
                          Save + probe
                        </Button>
                        <Button variant="ghost" className="min-h-11" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <Dialog open={deleteTarget !== null} onOpenChange={(v) => !v && setDeleteTarget(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="font-mono">Remove provider?</DialogTitle>
              <DialogDescription>
                {deleteTarget?.name} and its stored key will be removed from the panel. This
                cannot be undone.
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
