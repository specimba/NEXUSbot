"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import {
  Anchor,
  AppWindow,
  ArrowLeft,
  Check,
  Copy,
  Download,
  FlaskConical,
  Info,
  KeyRound,
  Link2,
  MonitorPlay,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import {
  WIDGET_VARIABLE_TYPES,
  buildWidgetDocument,
  makeChatMessageEvent,
  makeViewerCountEvent,
  parseWidgetVariables,
  serializeWidgetVariables,
  type WidgetVariable,
  type WidgetVariableType,
} from "@/lib/widgets/runtime";
import { buildObsBridgeUrl, parseObsLinkPath } from "@/lib/obs-bridge";

/**
 * WIDGETS tab — the self-hosted successor of the Kickbot widget builder.
 *
 * WHY THIS TAB EXISTS (the owner asked plainly, so the answer lives in the UI):
 *   • Widgets are what viewers SEE on stream — HUD overlays, counters, AI
 *     terminals, added to OBS as a Browser Source.
 *   • User variables are a widget's settings (colors, API keys, trigger
 *     command…). The widget code reads them at runtime; the OBS export bakes
 *     the current values in.
 *   • Test events fire fake chat/viewer-count events into the preview so the
 *     widget can be exercised without going live.
 * The seed widget is the owner's "Specimba Cyber AI Counter" imported VERBATIM
 * from the Kickbot saved state (same HTML/CSS/JS, same variable names) — our
 * runtime provides the exact contract Kickbot's builder injected
 * (userVariables + widgetEvent + the five helper functions).
 */

type WidgetRow = {
  id: string;
  name: string;
  width: number;
  height: number;
  html: string;
  css: string;
  js: string;
  variables: string;
  enabled: boolean;
  seeded: boolean;
  createdAt: string;
  updatedAt: string;
  /** Stable OBS link (server-decrypted; vault columns never reach the client). */
  obsLink?: {
    path: string;
    baseUrl: string | null;
  } | null;
  obsLinkBroken?: boolean;
};

type Draft = {
  name: string;
  width: number;
  height: number;
  enabled: boolean;
  html: string;
  css: string;
  js: string;
  variables: WidgetVariable[];
};

function toDraft(w: WidgetRow): Draft {
  return {
    name: w.name,
    width: w.width,
    height: w.height,
    enabled: w.enabled,
    html: w.html,
    css: w.css,
    js: w.js,
    variables: parseWidgetVariables(w.variables),
  };
}

function draftEqual(a: Draft, b: Draft): boolean {
  return (
    a.name === b.name &&
    a.width === b.width &&
    a.height === b.height &&
    a.enabled === b.enabled &&
    a.html === b.html &&
    a.css === b.css &&
    a.js === b.js &&
    serializeWidgetVariables(a.variables) === serializeWidgetVariables(b.variables)
  );
}

/* ------------------------------------------------------------------------- */
/* Variables editor                                                           */
/* ------------------------------------------------------------------------- */

function VariableRow({
  v,
  index,
  onChange,
  onRemove,
}: {
  v: WidgetVariable;
  index: number;
  onChange: (next: WidgetVariable) => void;
  onRemove: () => void;
}) {
  const idBase = `wvar-${index}`;
  return (
    <div className="grid gap-1.5 rounded-md border border-border/60 p-2.5">
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_130px_auto]">
        <div className="grid gap-1">
          <Label htmlFor={`${idBase}-label`} className="text-[11px] text-muted-foreground">
            Label
          </Label>
          <Input
            id={`${idBase}-label`}
            className="min-h-9"
            value={v.label}
            onChange={(e) => onChange({ ...v, label: e.target.value })}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${idBase}-name`} className="text-[11px] text-muted-foreground">
            Name <span className="font-mono">(code reads userVariables.name)</span>
          </Label>
          <Input
            id={`${idBase}-name`}
            className="min-h-9 font-mono"
            spellCheck={false}
            value={v.name}
            onChange={(e) => onChange({ ...v, name: e.target.value })}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${idBase}-type`} className="text-[11px] text-muted-foreground">
            Type
          </Label>
          <Select value={v.type} onValueChange={(t) => onChange({ ...v, type: t as WidgetVariableType })}>
            <SelectTrigger id={`${idBase}-type`} className="min-h-9 w-full font-mono">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WIDGET_VARIABLE_TYPES.map((t) => (
                <SelectItem key={t} value={t} className="font-mono">
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end">
          <Button
            variant="ghost"
            size="icon"
            className="size-9 text-destructive hover:text-destructive"
            aria-label={`Remove variable ${v.name || index + 1}`}
            onClick={onRemove}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${idBase}-value`} className="text-[11px] text-muted-foreground">
          Value {v.secret && <span className="text-accent">· secret — baked into OBS exports, never shown again in plain text</span>}
        </Label>
        {v.type === "boolean" ? (
          <div className="flex items-center gap-2 pt-1">
            <Switch
              id={`${idBase}-value`}
              checked={v.value === "true"}
              onCheckedChange={(c) => onChange({ ...v, value: c ? "true" : "false" })}
            />
            <span className="font-mono text-xs text-muted-foreground">{v.value === "true" ? "true" : "false"}</span>
          </div>
        ) : v.type === "color" ? (
          <div className="flex items-center gap-2">
            <input
              id={`${idBase}-value`}
              type="color"
              aria-label={`Color value for ${v.name}`}
              className="size-9 cursor-pointer rounded border border-border bg-transparent"
              value={/^#[0-9a-fA-F]{6}$/.test(v.value) ? v.value : "#53fc18"}
              onChange={(e) => onChange({ ...v, value: e.target.value })}
            />
            <Input
              className="min-h-9 max-w-40 font-mono"
              spellCheck={false}
              value={v.value}
              onChange={(e) => onChange({ ...v, value: e.target.value })}
            />
          </div>
        ) : (
          <Input
            id={`${idBase}-value`}
            type={v.type === "password" ? "password" : v.type === "number" ? "number" : "text"}
            inputMode={v.type === "number" ? "decimal" : "text"}
            autoComplete="off"
            spellCheck={false}
            className="min-h-9 font-mono"
            value={v.value}
            onChange={(e) => onChange({ ...v, value: e.target.value })}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Editor                                                                     */
/* ------------------------------------------------------------------------- */

function WidgetEditor({
  widget,
  onBack,
}: {
  widget: WidgetRow;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => toDraft(widget));
  const [saved, setSaved] = useState<Draft>(() => toDraft(widget));
  const [previewDoc, setPreviewDoc] = useState<string>(() =>
    buildWidgetDocument({
      id: widget.id,
      name: widget.name || "widget",
      width: widget.width,
      height: widget.height,
      html: widget.html,
      css: widget.css,
      js: widget.js,
      variables: widget.variables,
    }),
  );
  const [previewGen, setPreviewGen] = useState(0);
  const [previewSource, setPreviewSource] = useState<"saved" | "draft">("saved");
  const [previewScale, setPreviewScale] = useState(1);
  const [testUser, setTestUser] = useState("testviewer");
  const [testMessage, setTestMessage] = useState("!ai hello from the panel preview");
  const [testViewers, setTestViewers] = useState("128");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const previewWrapRef = useRef<HTMLDivElement | null>(null);

  const dirty = !draftEqual(draft, saved);

  const save = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/widgets/${widget.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          width: draft.width,
          height: draft.height,
          enabled: draft.enabled,
          html: draft.html,
          css: draft.css,
          js: draft.js,
          variables: serializeWidgetVariables(draft.variables),
        }),
      });
      // Read the body ONCE — a second res.json() throws "body stream already
      // read" (the exact bug that made successful saves look like failures).
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; widget?: WidgetRow; error?: { message?: string } }
        | null;
      if (!res.ok) throw new Error(body?.error?.message ?? `Save failed (HTTP ${res.status})`);
      return body;
    },
    onSuccess: () => {
      setSaved({ ...draft });
      applyToPreview(draft, "saved");
      void queryClient.invalidateQueries({ queryKey: ["widgets"] });
      toast.success("Widget saved", { description: "Preview reloaded with the saved state." });
    },
    onError: (e: Error) => toast.error("Save failed", { description: e.message }),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/widgets/${widget.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["widgets"] });
      toast.success("Widget deleted");
      onBack();
    },
    onError: (e: Error) => toast.error("Delete failed", { description: e.message }),
  });

  // OBS Browser Source URL — STABLE LINK. OBS cannot carry the panel session,
  // so the URL embeds an ingest token; the token+path now live AES-256-GCM-
  // encrypted on the widget row (panel DB), so the SAME URL survives panel
  // refreshes. The old flow minted a new token per click and kept it only in
  // React state — every refresh produced a different URL. Only the host part
  // can ever change: freeze it with an anchor (http://localhost:3000 = OBS on
  // the panel machine → permanent link) or let it follow the current address.
  const [origin, setOrigin] = useState("");
  const [obsCopied, setObsCopied] = useState(false);
  const [baseDraft, setBaseDraft] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const obsLink = widget.obsLink ?? null;
  const obsUrl = obsLink ? `${obsLink.baseUrl ?? origin}${obsLink.path}` : null;

  // Keep the anchor input in sync with the server row (after mutations).
  useEffect(() => {
    setBaseDraft(widget.obsLink?.baseUrl ?? "");
  }, [widget.obsLink]);

  // OBS bundle download — fetch + blob instead of window.location.href: a raw
  // navigation CANNOT carry the Bearer token (cookie-less preview iframes), so
  // a stale session navigated the whole panel to a raw UNAUTHORIZED JSON page
  // — the "download crashes the system" report. Fetch goes through the auth
  // shim (Bearer attached) and the panel stays intact.
  const downloadBundle = useCallback(async () => {
    try {
      const res = await fetch(`/api/widgets/${widget.id}/bundle`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        if (res.status === 401) {
          toast.error("Panel sign-in required", {
            description: "Your panel session expired — the panel will reload to the sign-in screen.",
          });
          setTimeout(() => window.location.reload(), 1500);
          return;
        }
        throw new Error(body?.error?.message ?? `Export failed (HTTP ${res.status})`);
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") ?? "";
      const name = cd.match(/filename="([^"]+)"/)?.[1] ?? `nexus-widget-${widget.id}.html`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast.success("OBS bundle downloaded", { description: `${name} — add in OBS as a Local-file Browser Source.` });
    } catch (e) {
      toast.error("Export failed", { description: e instanceof Error ? e.message : String(e) });
    }
  }, [widget.id]);

  const copyObsUrl = useCallback(() => {
    if (!obsUrl) return;
    navigator.clipboard
      ?.writeText(obsUrl)
      .then(() => {
        setObsCopied(true);
        setTimeout(() => setObsCopied(false), 2000);
      })
      .catch(() => {
        /* clipboard unavailable — the readonly input below is the manual fallback */
      });
  }, [obsUrl]);

  // Stable bridge URL (task 26-d): a GitHub Pages-hosted page that redirects
  // OBS to the panel's CURRENT address — it survives preview-address rotation.
  // Built from the SAME stored path + token; the token lives in the OBS source
  // config, never in the public bridge file.
  const bridgeParts = obsLink ? parseObsLinkPath(obsLink.path) : null;
  const bridgeUrl = bridgeParts ? buildObsBridgeUrl(bridgeParts.widgetId, bridgeParts.token) : null;
  const [bridgeCopied, setBridgeCopied] = useState(false);
  const copyBridgeUrl = useCallback(() => {
    if (!bridgeUrl) return;
    navigator.clipboard
      ?.writeText(bridgeUrl)
      .then(() => {
        setBridgeCopied(true);
        setTimeout(() => setBridgeCopied(false), 2000);
      })
      .catch(() => undefined);
  }, [bridgeUrl]);

  const bridgeStatus = useQuery<{ ok: boolean; origin: string | null; updatedAt: string | null }>({
    queryKey: ["obs-bridge-status"],
    queryFn: async () => {
      const res = await fetch("/api/obs/publish-origin", { cache: "no-store" });
      if (!res.ok) throw new Error("bridge status failed");
      return (await res.json()) as { ok: boolean; origin: string | null; updatedAt: string | null };
    },
    staleTime: 30_000,
  });

  const publishOrigin = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/obs/publish-origin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin: window.location.origin }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; published?: boolean; error?: { message?: string } }
        | null;
      if (!res.ok) throw new Error(body?.error?.message ?? `Publish failed (HTTP ${res.status})`);
      return body;
    },
    onSuccess: (body) => {
      void queryClient.invalidateQueries({ queryKey: ["obs-bridge-status"] });
      toast.success(body?.published ? "Panel address published" : "Address unchanged", {
        description: body?.published
          ? "Snapshot push scheduled — the stable bridge picks it up in moments."
          : "The current address is already the published one.",
      });
    },
    onError: (e: Error) => toast.error("Publish failed", { description: e.message }),
  });

  // All stable-link operations (create / reset / set-base / revoke) hit ONE
  // route on the same server — no extra hop, no external service, no domain.
  const obsLinkMutation = useMutation({
    mutationFn: async (payload: { action: "create" | "reset" | "set-base" | "revoke"; baseUrl?: string | null }) => {
      const res = await fetch(`/api/widgets/${widget.id}/obs-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      // Read the body ONCE (double res.json() throws "body stream already read").
      const body = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            obsLink?: { path: string; baseUrl: string | null } | null;
            error?: { message?: string };
          }
        | null;
      if (!res.ok) throw new Error(body?.error?.message ?? `Link operation failed (HTTP ${res.status})`);
      return body;
    },
    onSuccess: (body, payload) => {
      void queryClient.invalidateQueries({ queryKey: ["widgets"] });
      if (payload.action === "create" || payload.action === "reset") {
        const link = body?.obsLink;
        if (link) {
          const url = `${link.baseUrl ?? window.location.origin}${link.path}`;
          navigator.clipboard?.writeText(url).catch(() => undefined);
        }
        toast.success(payload.action === "create" ? "Stable OBS link created" : "OBS token rotated", {
          description:
            "Copied to clipboard. Path + token are permanent (stored encrypted in the panel DB) — only the host part can ever change.",
        });
        setResetOpen(false);
      } else if (payload.action === "set-base") {
        toast.success(payload.baseUrl ? `Anchored to ${payload.baseUrl}` : "Anchor cleared", {
          description: payload.baseUrl
            ? "The link no longer follows this preview address — it is frozen to the anchor."
            : "The link now follows whatever address the panel is opened from.",
        });
      } else if (payload.action === "revoke") {
        toast.success("OBS link revoked", {
          description: "The URL now returns 401 — create a fresh link whenever needed.",
        });
        setRevokeOpen(false);
      }
    },
    onError: (e: Error) => toast.error("OBS link failed", { description: e.message }),
  });

  // Live preview document — an explicit apply-model: the (up to 100 KB)
  // document is rebuilt ONLY when the operator clicks "Apply to preview" or
  // saves, so typing in the editors never thrashes an iframe remount.
  const applyToPreview = useCallback(
    (source: Draft, origin: "saved" | "draft") => {
      setPreviewDoc(
        buildWidgetDocument({
          id: widget.id,
          name: source.name || "widget",
          width: source.width,
          height: source.height,
          html: source.html,
          css: source.css,
          js: source.js,
          variables: serializeWidgetVariables(source.variables),
        }),
      );
      setPreviewGen((g) => g + 1);
      setPreviewSource(origin);
    },
    [widget.id],
  );

  // Auto-fit scale: widget pixel size → available preview width.
  useEffect(() => {
    const el = previewWrapRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth - 8;
      setPreviewScale(Math.min(1, Math.max(0.2, w / Math.max(1, draft.width))));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [draft.width]);

  const sendTest = useCallback((ev: { event_name: string; data: unknown }) => {
    iframeRef.current?.contentWindow?.postMessage({ type: "nexus-widget-event", event: ev }, "*");
  }, []);

  const previewHeight = Math.round(draft.height * previewScale);
  const secretEmpty = draft.variables.filter((v) => v.secret && v.value.trim() === "");

  // nexus-cortex runs verify_jwt=true: Supabase's edge gateway demands the full
  // anon JWT (eyJ…, ~200+ chars) as the Bearer key. sb_publishable_-style or
  // truncated values get rejected with a 401 exactly when the owner is testing
  // the widget on stream — surface the mismatch HERE instead.
  const supabaseAnon = draft.variables.find((v) => v.name === "supabase_anon_key")?.value.trim() ?? "";
  const supabaseKeyHint =
    !supabaseAnon || supabaseAnon.startsWith("eyJ")
      ? supabaseAnon.length > 0 && supabaseAnon.length < 150
        ? "this looks like a TRUNCATED JWT — the full anon key is usually 200+ chars, and verify_jwt=true rejects short ones at the gateway. Re-copy the entire key from Supabase → Project Settings → API → anon public."
        : null
      : "nexus-cortex has verify_jwt=true — the full anon JWT (eyJ…, 200+ chars) is required. sb_publishable_-style keys are rejected at the edge gateway. Get it from Supabase → Project Settings → API → anon public.";

  return (
    <div className="space-y-4">
      <Toaster position="bottom-right" richColors closeButton />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" className="min-h-11 font-mono" onClick={onBack} aria-label="Back to widget list">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Widgets
        </Button>
        <h2 className="min-w-0 truncate font-mono text-base font-semibold">{draft.name}</h2>
        {widget.seeded && (
          <Badge variant="outline" className="font-mono text-[10px] border-primary/40 text-primary">
            IMPORTED · KICKBOT SAVED STATE
          </Badge>
        )}
        {dirty && (
          <Badge variant="outline" className="font-mono text-[10px] border-accent/60 text-accent">
            UNSAVED CHANGES
          </Badge>
        )}
        <div className="ml-auto flex gap-2">
          <Button className="min-h-11 font-mono" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            <Save className="size-4" aria-hidden="true" />
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          <Button
            variant="outline"
            className="min-h-11 font-mono"
            onClick={() => applyToPreview(draft, "draft")}
            aria-label="Reload preview with current draft"
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            Apply to preview
          </Button>
        </div>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[1fr_430px]">
        {/* ---------------- LEFT: settings + variables + code ---------------- */}
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="font-mono text-base">Basic settings</CardTitle>
              <CardDescription>The size the widget renders at, in pixels — OBS Browser Source should match.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-[1fr_110px_110px_auto]">
              <div className="grid gap-1.5">
                <Label htmlFor="w-name">Name</Label>
                <Input
                  id="w-name"
                  className="min-h-11"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="w-width">Width</Label>
                <Input
                  id="w-width"
                  type="number"
                  min={40}
                  max={4096}
                  className="min-h-11 font-mono"
                  value={draft.width}
                  onChange={(e) => setDraft({ ...draft, width: Number(e.target.value) || draft.width })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="w-height">Height</Label>
                <Input
                  id="w-height"
                  type="number"
                  min={40}
                  max={4096}
                  className="min-h-11 font-mono"
                  value={draft.height}
                  onChange={(e) => setDraft({ ...draft, height: Number(e.target.value) || draft.height })}
                />
              </div>
              <div className="flex items-end gap-2 pb-1">
                <Switch
                  id="w-enabled"
                  checked={draft.enabled}
                  aria-label="Widget enabled"
                  onCheckedChange={(c) => setDraft({ ...draft, enabled: c })}
                />
                <Label htmlFor="w-enabled" className="text-xs text-muted-foreground">
                  {draft.enabled ? "enabled" : "disabled"}
                </Label>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
              <div className="space-y-1">
                <CardTitle className="font-mono text-base">User variables ({draft.variables.length})</CardTitle>
                <CardDescription>
                  Settings this widget reads at runtime. Widget code accesses{" "}
                  <span className="font-mono text-foreground">userVariables.&lt;name&gt;.value</span>.
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="min-h-9 shrink-0 font-mono"
                onClick={() =>
                  setDraft({
                    ...draft,
                    variables: [
                      ...draft.variables,
                      { name: `var_${draft.variables.length + 1}`, label: "New variable", type: "text", value: "" },
                    ],
                  })
                }
              >
                <Plus className="size-3.5" aria-hidden="true" />
                Add
              </Button>
            </CardHeader>
            <CardContent>
              {draft.variables.length === 0 ? (
                <p className="rounded-md border border-dashed border-border/70 p-3 text-sm text-muted-foreground">
                  No variables — the widget runs on its code defaults.
                </p>
              ) : (
                <div className="max-h-96 space-y-2 overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
                  {draft.variables.map((v, i) => (
                    <VariableRow
                      key={i}
                      v={v}
                      index={i}
                      onChange={(next) =>
                        setDraft({
                          ...draft,
                          variables: draft.variables.map((old, j) => (j === i ? next : old)),
                        })
                      }
                      onRemove={() =>
                        setDraft({ ...draft, variables: draft.variables.filter((_, j) => j !== i) })
                      }
                    />
                  ))}
                </div>
              )}
              {secretEmpty.length > 0 && (
                <p className="mt-2 rounded-md border border-accent/40 bg-accent/10 p-2 text-xs text-accent">
                  Empty secrets: {secretEmpty.map((v) => v.name).join(", ")}. The widget renders, but any
                  feature needing those keys (Vyce/Groq/Supabase calls) will fail until you fill them —
                  values are baked into the OBS export.
                </p>
              )}
              {supabaseKeyHint && (
                <p className="mt-2 rounded-md border border-orange-500/40 bg-orange-500/10 p-2 text-xs text-orange-400">
                  Heads-up on <span className="font-mono">supabase_anon_key</span>: {supabaseKeyHint}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="font-mono text-base">Code</CardTitle>
              <CardDescription>
                Runs inside an isolated page on the Kickbot contract:{" "}
                <span className="font-mono text-foreground">userVariables</span>,{" "}
                <span className="font-mono text-foreground">widgetEvent</span> DOM events, and the injected
                helpers (<span className="font-mono">extractRawChatPayload</span>,{" "}
                <span className="font-mono">hasAiTrigger</span>, <span className="font-mono">stripAiTrigger</span>,{" "}
                <span className="font-mono">decodeKickEmotesInText</span>,{" "}
                <span className="font-mono">fetchWithTimeout</span>).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="js">
                <TabsList className="mb-2">
                  <TabsTrigger value="html" className="font-mono">
                    HTML
                  </TabsTrigger>
                  <TabsTrigger value="css" className="font-mono">
                    CSS
                  </TabsTrigger>
                  <TabsTrigger value="js" className="font-mono">
                    JavaScript
                  </TabsTrigger>
                </TabsList>
                {(["html", "css", "js"] as const).map((field) => (
                  <TabsContent key={field} value={field} className="mt-0">
                    <Textarea
                      aria-label={`Widget ${field} code`}
                      spellCheck={false}
                      className="min-h-72 max-h-96 overflow-y-auto whitespace-pre font-mono text-xs leading-relaxed scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent"
                      value={draft[field]}
                      onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
                    />
                    <p className="mt-1 text-right font-mono text-[10px] text-muted-foreground">
                      {draft[field].length.toLocaleString()} chars
                    </p>
                  </TabsContent>
                ))}
              </Tabs>
            </CardContent>
          </Card>
        </div>

        {/* ---------------- RIGHT: preview + test events ---------------- */}
        <div className="min-w-0 space-y-4 xl:sticky xl:top-24">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 font-mono text-base">
                <MonitorPlay className="size-4 text-primary" aria-hidden="true" />
                Preview
              </CardTitle>
              <CardDescription>
                {draft.width} × {draft.height}px · shown at {Math.round(previewScale * 100)}% ·{" "}
                {previewSource === "saved" ? "saved state" : "draft applied"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div
                ref={previewWrapRef}
                className="w-full overflow-hidden rounded-md border border-border/60 bg-[repeating-conic-gradient(#1a1a1a_0%_25%,#0a0a0a_0%_50%)] bg-[length:16px_16px] p-1"
              >
                <div style={{ height: `${previewHeight}px` }} className="relative w-full">
                  <iframe
                    key={previewGen}
                    ref={iframeRef}
                    title={`Preview of ${draft.name}`}
                    srcDoc={previewDoc}
                    className="absolute left-0 top-0 origin-top-left border-0"
                    style={{ width: `${draft.width}px`, height: `${draft.height}px`, transform: `scale(${previewScale})` }}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 font-mono text-base">
                <FlaskConical className="size-4 text-primary" aria-hidden="true" />
                Test events
              </CardTitle>
              <CardDescription>Fires fake events into the preview — exactly what the live feed will deliver.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-1.5">
                <Label htmlFor="t-user">Username</Label>
                <Input id="t-user" className="min-h-9 font-mono" value={testUser} onChange={(e) => setTestUser(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="t-msg">Chat message</Label>
                <div className="flex gap-2">
                  <Input
                    id="t-msg"
                    className="min-h-9 flex-1 font-mono"
                    value={testMessage}
                    onChange={(e) => setTestMessage(e.target.value)}
                  />
                  <Button
                    variant="outline"
                    className="min-h-9 shrink-0 font-mono"
                    onClick={() => sendTest(makeChatMessageEvent(testUser || "testviewer", testMessage))}
                  >
                    Send chat
                  </Button>
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="t-viewers">Viewer count</Label>
                <div className="flex gap-2">
                  <Input
                    id="t-viewers"
                    type="number"
                    className="min-h-9 flex-1 font-mono"
                    value={testViewers}
                    onChange={(e) => setTestViewers(e.target.value)}
                  />
                  <Button
                    variant="outline"
                    className="min-h-9 shrink-0 font-mono"
                    onClick={() => sendTest(makeViewerCountEvent(Number(testViewers) || 0))}
                  >
                    Send viewers
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 font-mono text-base">
                <Download className="size-4 text-primary" aria-hidden="true" />
                OBS export
              </CardTitle>
              <CardDescription>
                One self-contained HTML file — add it in OBS via Sources → Browser → “Local file”. Re-export
                after changing variables or code. STATIC ONLY: the file cannot reach the panel API or the Kick
                bridge, so live chat / viewer count / the AI pipeline stay offline — the widget shows an on-stream
                banner saying exactly that. For the LIVE overlay use the OBS Browser Source URL instead.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {secretEmpty.length > 0 && (
                <p className="rounded-md border border-accent/40 bg-accent/10 p-2 text-xs text-accent">
                  Export includes empty secrets ({secretEmpty.map((v) => v.name).join(", ")}) — those features
                  stay offline until the values are filled here.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                The file embeds current variable values (including secrets) so it runs standalone — treat the
                export like a credential and keep it local.
              </p>
              <Button
                variant="outline"
                className="min-h-11 w-full font-mono"
                disabled={dirty}
                onClick={() => void downloadBundle()}
              >
                <Download className="size-4" aria-hidden="true" />
                {dirty ? "Save first, then export" : "Download OBS bundle"}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 font-mono text-base">
                <Link2 className="size-4 text-primary" aria-hidden="true" />
                OBS Browser Source URL
              </CardTitle>
              <CardDescription>
                OBS → Sources → + → Browser → paste the URL below as the URL (NOT “Local file”). It never changes on
                panel refresh — the path + token are stored encrypted in the panel DB. If you ever see the panel
                LOGIN page instead of the widget, you copied the address prefix instead of this full URL.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {widget.obsLinkBroken ? (
                <>
                  <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                    The stored link can no longer be decrypted (vault key rotated?) — create a fresh
                    one below.
                  </p>
                  <Button
                    variant="outline"
                    className="min-h-11 w-full font-mono"
                    disabled={obsLinkMutation.isPending}
                    onClick={() => obsLinkMutation.mutate({ action: "create" })}
                  >
                    <KeyRound className="size-4" aria-hidden="true" />
                    {obsLinkMutation.isPending ? "Creating link…" : "Create fresh stable link"}
                  </Button>
                </>
              ) : obsLink && obsUrl ? (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Input
                      readOnly
                      aria-label="OBS Browser Source URL"
                      className="min-h-9 min-w-[240px] flex-1 font-mono text-xs"
                      value={obsUrl}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <Button
                      variant="outline"
                      className="min-h-9 shrink-0 font-mono"
                      onClick={copyObsUrl}
                      aria-label={obsCopied ? "Copied" : "Copy OBS URL"}
                    >
                      {obsCopied ? (
                        <Check className="size-4 text-primary" aria-hidden="true" />
                      ) : (
                        <Copy className="size-4" aria-hidden="true" />
                      )}
                      {obsCopied ? "Copied" : "Copy"}
                    </Button>
                    <Button
                      variant="ghost"
                      className="min-h-9 shrink-0 font-mono text-xs"
                      onClick={() => obsUrl && window.open(obsUrl, "_blank", "noopener")}
                      aria-label="Open the OBS URL in a new tab to test it"
                    >
                      <MonitorPlay className="size-4" aria-hidden="true" />
                      Open test
                    </Button>
                  </div>

                  {bridgeUrl ? (
                    <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Label className="text-[11px] text-muted-foreground">
                          Stable bridge URL — never changes, survives preview rotation (GitHub-hosted)
                        </Label>
                        <Badge variant="outline" className="max-w-full truncate font-mono text-[10px]">
                          {bridgeStatus.data?.origin
                            ? `published: ${bridgeStatus.data.origin}`
                            : "address not published yet"}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Input
                          readOnly
                          aria-label="Stable OBS bridge URL"
                          className="min-h-9 min-w-[240px] flex-1 font-mono text-xs"
                          value={bridgeUrl}
                          onFocus={(e) => e.currentTarget.select()}
                        />
                        <Button
                          variant="outline"
                          className="min-h-9 shrink-0 font-mono"
                          onClick={copyBridgeUrl}
                          aria-label={bridgeCopied ? "Copied" : "Copy stable bridge URL"}
                        >
                          {bridgeCopied ? (
                            <Check className="size-4 text-primary" aria-hidden="true" />
                          ) : (
                            <Copy className="size-4" aria-hidden="true" />
                          )}
                          {bridgeCopied ? "Copied" : "Copy"}
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        A GitHub-hosted page that redirects OBS to the panel&apos;s current address — it keeps working
                        across sandbox restarts and address rotations. The panel auto-publishes its address every
                        time it is opened (local/private addresses are refused so the bridge never points at a
                        machine OBS cannot reach). GitHub Pages is enabled and serving this URL — paste it into an
                        OBS Browser Source once and never touch it again.
                      </p>
                      <Button
                        variant="ghost"
                        className="min-h-9 font-mono text-xs"
                        disabled={publishOrigin.isPending}
                        onClick={() => publishOrigin.mutate()}
                      >
                        <Anchor className="size-3.5" aria-hidden="true" />
                        {publishOrigin.isPending ? "Publishing…" : "Publish current address now"}
                      </Button>
                    </div>
                  ) : null}

                  <div className="space-y-2 rounded-md border border-border/60 p-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Label className="text-[11px] text-muted-foreground">
                        Advanced — address prefix (host anchor)
                      </Label>
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {obsLink.baseUrl ? `frozen: ${obsLink.baseUrl}` : "follows current address (recommended)"}
                      </Badge>
                    </div>
                    <div className="flex gap-2">
                      <Input
                        aria-label="Host anchor base URL"
                        className="min-h-9 flex-1 font-mono text-xs"
                        placeholder="http://localhost:3000 (OBS on the panel machine)"
                        value={baseDraft}
                        spellCheck={false}
                        onChange={(e) => setBaseDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            const v = baseDraft.trim();
                            obsLinkMutation.mutate({ action: "set-base", baseUrl: v === "" ? null : v });
                          }
                        }}
                      />
                      <Button
                        variant="outline"
                        className="min-h-9 shrink-0 font-mono"
                        disabled={obsLinkMutation.isPending || baseDraft.trim() === (obsLink.baseUrl ?? "")}
                        onClick={() => {
                          const v = baseDraft.trim();
                          obsLinkMutation.mutate({ action: "set-base", baseUrl: v === "" ? null : v });
                        }}
                      >
                        <Anchor className="size-4" aria-hidden="true" />
                        Save
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="ghost"
                        className="min-h-9 font-mono text-xs"
                        disabled={obsLinkMutation.isPending || origin === "" || (obsLink.baseUrl ?? "") === origin}
                        onClick={() => obsLinkMutation.mutate({ action: "set-base", baseUrl: origin })}
                      >
                        <Anchor className="size-3.5" aria-hidden="true" />
                        Anchor to current address
                      </Button>
                      <Button
                        variant="ghost"
                        className="min-h-9 font-mono text-xs"
                        disabled={obsLinkMutation.isPending || obsLink.baseUrl === null}
                        onClick={() => obsLinkMutation.mutate({ action: "set-base", baseUrl: null })}
                      >
                        Follow current address (auto)
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Leave this on “follows current address” unless you know why you need it: it is ONLY the address
                      prefix of the URL above — copying it alone opens the panel login page. At home, with the panel
                      running on the OBS machine, anchoring to <span className="font-mono">http://localhost:3000</span>{" "}
                      makes the link permanent. OBS on another PC: the panel machine&apos;s LAN address (
                      {"http://192.168.x.x:3000"}). The sandbox preview address rotates by nature — re-anchor after
                      it changes; the token stays the same until you reset it.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      className="min-h-9 font-mono text-xs text-destructive hover:text-destructive"
                      disabled={obsLinkMutation.isPending}
                      onClick={() => setResetOpen(true)}
                    >
                      <RotateCcw className="size-4" aria-hidden="true" />
                      Reset token
                    </Button>
                    <Button
                      variant="outline"
                      className="min-h-9 font-mono text-xs text-destructive hover:text-destructive"
                      disabled={obsLinkMutation.isPending}
                      onClick={() => setRevokeOpen(true)}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                      Revoke link
                    </Button>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    OBS setup: set Width {draft.width} / Height {draft.height}. After edits: Save
                    here, then hit “Refresh cache” on the OBS source. The token in this URL is a
                    credential (it renders the widget with its baked variables) — reset it if it
                    leaks.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    OBS cannot use the panel login, so the URL carries a private ingest token.
                    Create the link once — it is stored encrypted in the panel DB and re-shown here
                    after every refresh (no more new-token-per-click).
                  </p>
                  <Button
                    variant="outline"
                    className="min-h-11 w-full font-mono"
                    disabled={obsLinkMutation.isPending}
                    onClick={() => obsLinkMutation.mutate({ action: "create" })}
                  >
                    <KeyRound className="size-4" aria-hidden="true" />
                    {obsLinkMutation.isPending ? "Creating link…" : "Create stable OBS link"}
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono">Delete widget?</AlertDialogTitle>
            <AlertDialogDescription>
              {widget.name} and its variables will be removed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11 bg-destructive font-mono text-destructive-foreground hover:bg-destructive/90"
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault();
                remove.mutate();
              }}
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono">Reset OBS token?</AlertDialogTitle>
            <AlertDialogDescription>
              The current URL stops working immediately (token revoked) and a fresh one is minted.
              Use this if the link leaked — then re-paste the new URL in OBS.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11 bg-destructive font-mono text-destructive-foreground hover:bg-destructive/90"
              disabled={obsLinkMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                obsLinkMutation.mutate({ action: "reset" });
              }}
            >
              {obsLinkMutation.isPending ? "Resetting…" : "Reset token"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono">Revoke OBS link?</AlertDialogTitle>
            <AlertDialogDescription>
              The token is revoked and the stored link is deleted — the OBS Browser Source will show
              a 401 page until you create a fresh link.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11 bg-destructive font-mono text-destructive-foreground hover:bg-destructive/90"
              disabled={obsLinkMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                obsLinkMutation.mutate({ action: "revoke" });
              }}
            >
              {obsLinkMutation.isPending ? "Revoking…" : "Revoke link"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* List                                                                       */
/* ------------------------------------------------------------------------- */

function WidgetList({ onOpen }: { onOpen: (w: WidgetRow) => void }) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WidgetRow | null>(null);
  const [newName, setNewName] = useState("My widget");
  const [newWidth, setNewWidth] = useState(560);
  const [newHeight, setNewHeight] = useState(260);

  const widgets = useQuery<{ ok: true; widgets: WidgetRow[] }>({
    queryKey: ["widgets"],
    queryFn: async () => {
      const res = await fetch("/api/widgets", { cache: "no-store" });
      if (!res.ok) throw new Error("widgets unavailable");
      return res.json();
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/widgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() || "My widget", width: newWidth, height: newHeight }),
      });
      const body = (await res.json().catch(() => null)) as { widget?: WidgetRow; error?: { message?: string } } | null;
      if (!res.ok) throw new Error(body?.error?.message ?? `Create failed (HTTP ${res.status})`);
      return body?.widget ?? null;
    },
    onSuccess: (w) => {
      void queryClient.invalidateQueries({ queryKey: ["widgets"] });
      setCreateOpen(false);
      if (w) onOpen(w);
    },
    onError: (e: Error) => toast.error("Create failed", { description: e.message }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/widgets/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["widgets"] });
      setDeleteTarget(null);
      toast.success("Widget deleted");
    },
    onError: (e: Error) => toast.error("Delete failed", { description: e.message }),
  });

  const rows = widgets.data?.widgets ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 font-mono">
            <AppWindow className="size-5 text-primary" aria-hidden="true" />
            Widgets
            <span className="text-xs font-normal text-muted-foreground">what your viewers see on stream</span>
          </CardTitle>
          <CardDescription>
            Self-hosted overlay widgets for OBS — the same builder contract as Kickbot, running on NEXUS OS.
            Each widget is a self-contained HTML/CSS/JS bundle with its own user variables; the preview below
            fires test events, and the OBS export is a single local file (nothing is hosted, L0).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Button className="min-h-11 font-mono" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden="true" />
            New widget
          </Button>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Info className="size-3.5" aria-hidden="true" />
            The old Variables registry ({"{{namespace.field}}"} templates) moves into the bot-commands work —
            this tab is now the thing viewers actually see.
          </p>
        </CardContent>
      </Card>

      {widgets.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2" aria-hidden="true">
          <Skeleton className="h-36 rounded-lg" />
          <Skeleton className="h-36 rounded-lg" />
        </div>
      ) : widgets.isError ? (
        <p className="text-sm text-destructive" role="alert">
          Widget list unavailable — retrying automatically.
        </p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
          No widgets yet — create one.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {rows.map((w) => (
            <Card
              key={w.id}
              className="group cursor-pointer transition-colors hover:border-primary/40"
              role="button"
              tabIndex={0}
              aria-label={`Open widget ${w.name}`}
              onClick={() => onOpen(w)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(w);
                }
              }}
            >
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between gap-2 font-mono text-sm">
                  <span className="min-w-0 truncate">{w.name}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {w.seeded && (
                      <Badge variant="outline" className="font-mono text-[9px] border-primary/40 text-primary">
                        IMPORTED
                      </Badge>
                    )}
                    <Badge
                      variant="outline"
                      className={cn(
                        "font-mono text-[9px]",
                        w.enabled ? "border-primary/40 text-primary" : "text-muted-foreground",
                      )}
                    >
                      {w.enabled ? "ENABLED" : "DISABLED"}
                    </Badge>
                  </span>
                </CardTitle>
                <CardDescription className="font-mono text-[11px]">
                  {w.width} × {w.height}px · {parseWidgetVariables(w.variables).length} variables ·{" "}
                  {w.html.length + w.css.length + w.js.length > 0
                    ? `${((w.html.length + w.css.length + w.js.length) / 1024).toFixed(1)} KB code`
                    : "empty"}{" "}
                  · updated{" "}
                  <time dateTime={w.updatedAt} suppressHydrationWarning>
                    {formatDistanceToNow(new Date(w.updatedAt), { addSuffix: true })}
                  </time>
                </CardDescription>
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-2">
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {parseWidgetVariables(w.variables)
                    .slice(0, 4)
                    .map((v) => v.name)
                    .join(", ")
                    .concat(parseWidgetVariables(w.variables).length > 4 ? ", …" : "") || "no variables"}
                </p>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-destructive hover:text-destructive"
                  aria-label={`Delete ${w.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteTarget(w);
                  }}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* New-widget dialog */}
      <AlertDialog open={createOpen} onOpenChange={setCreateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono">New widget</AlertDialogTitle>
            <AlertDialogDescription>
              Starts from the NEXUS starter template (label + counter + chat/viewer event handling) you can
              reshape freely.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="nw-name">Name</Label>
              <Input id="nw-name" className="min-h-11" value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="nw-width">Width (px)</Label>
                <Input
                  id="nw-width"
                  type="number"
                  min={40}
                  max={4096}
                  className="min-h-11 font-mono"
                  value={newWidth}
                  onChange={(e) => setNewWidth(Number(e.target.value) || 560)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="nw-height">Height (px)</Label>
                <Input
                  id="nw-height"
                  type="number"
                  min={40}
                  max={4096}
                  className="min-h-11 font-mono"
                  value={newHeight}
                  onChange={(e) => setNewHeight(Number(e.target.value) || 260)}
                />
              </div>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11 bg-primary font-mono text-primary-foreground hover:bg-primary/90"
              disabled={create.isPending}
              onClick={(e) => {
                e.preventDefault();
                create.mutate();
              }}
            >
              {create.isPending ? "Creating…" : "Create"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono">Delete widget?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.name} will be removed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11 bg-destructive font-mono text-destructive-foreground hover:bg-destructive/90"
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) remove.mutate(deleteTarget.id);
              }}
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Tab root                                                                   */
/* ------------------------------------------------------------------------- */

export function WidgetsTab() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Shared cache with WidgetList's identical query — selection reads from it
  // with zero extra round-trips.
  const widgets = useQuery<{ ok: true; widgets: WidgetRow[] }>({
    queryKey: ["widgets"],
    queryFn: async () => {
      const res = await fetch("/api/widgets", { cache: "no-store" });
      if (!res.ok) throw new Error("widgets unavailable");
      return res.json();
    },
    staleTime: 10_000,
  });

  const selected = selectedId ? (widgets.data?.widgets.find((w) => w.id === selectedId) ?? null) : null;

  if (selected) {
    return <WidgetEditor widget={selected} onBack={() => setSelectedId(null)} />;
  }
  return <WidgetList onOpen={(w) => setSelectedId(w.id)} />;
}
