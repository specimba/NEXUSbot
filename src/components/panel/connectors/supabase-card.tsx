"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
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
import { useToast } from "@/hooks/use-toast";
import { Database, HeartPulse, KeyRound, Link2, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";

type SupabaseStatus = {
  ok: boolean;
  patPresent: boolean;
  masked: string | null;
  probe: { ok: boolean; httpStatus: number; projectCount: number; note?: string } | null;
  mgmt: { usageThisMinute: number; limited: boolean; limitPerMinute: number };
};

type HealthProject = {
  ref: string;
  name: string;
  region: string | null;
  status: string;
  health: {
    ok: boolean;
    httpStatus: number;
    reports: Array<{ service: string; healthy: boolean; status: string | null }>;
    note?: string;
  };
};

type SupabaseHealth = {
  ok: boolean;
  probeOk: boolean;
  httpStatus: number;
  checkedAt: string;
  projects: HealthProject[];
  note?: string;
};

type SecretsResp = {
  ok: boolean;
  secrets?: Array<{ name: string; alias: string | null; hasValue: boolean }>;
  error?: { code: string; message: string };
};

/**
 * T-203 — Supabase Management API connector card.
 * PAT (scoped, Management API) → encrypted vault · MEASURED health rows ·
 * masked Edge Function secrets (names only, values never rendered).
 */
export function SupabaseCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const status = useQuery<SupabaseStatus>({
    queryKey: ["connectors", "supabase"],
    queryFn: async () => {
      const res = await fetch("/api/connectors/supabase/status", { cache: "no-store" });
      if (!res.ok) throw new Error("status unavailable");
      return res.json();
    },
  });

  const [patValue, setPatValue] = useState("");
  const savePat = useMutation({
    mutationFn: async (pat: string) => {
      const res = await fetch("/api/connectors/supabase/pat", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pat }),
      });
      if (!res.ok && res.status !== 201) {
        const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(j?.error?.message ?? "save failed");
      }
      return res.json() as Promise<{ masked: string; probe: { ok: boolean; httpStatus: number; projectCount: number } }>;
    },
    onSuccess: (data) => {
      setPatValue("");
      void queryClient.invalidateQueries({ queryKey: ["connectors", "supabase"] });
      void queryClient.invalidateQueries({ queryKey: ["connectors", "supabase-health"] });
      toast({
        title: data.probe.ok ? "Mgmt PAT stored + live probe OK" : "Mgmt PAT stored — probe FAILED",
        description: data.probe.ok
          ? `GET /v1/projects → ${data.probe.httpStatus} · ${data.probe.projectCount} project(s)`
          : `GET /v1/projects → ${data.probe.httpStatus || "network error"} — check the token`,
        variant: data.probe.ok ? "default" : "destructive",
      });
    },
    onError: (e: Error) =>
      toast({ title: "PAT not stored", description: e.message, variant: "destructive" }),
  });

  const removePat = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/connectors/supabase/pat", { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connectors", "supabase"] });
      void queryClient.invalidateQueries({ queryKey: ["connectors", "supabase-health"] });
      void queryClient.invalidateQueries({ queryKey: ["connectors", "supabase-secrets"] });
      toast({ title: "Mgmt PAT removed", description: "Vault credential deleted." });
    },
    onError: (e: Error) =>
      toast({ title: "Removal failed", description: e.message, variant: "destructive" }),
  });

  const health = useQuery<SupabaseHealth>({
    queryKey: ["connectors", "supabase-health"],
    enabled: status.data?.patPresent === true,
    queryFn: async () => {
      const res = await fetch("/api/connectors/supabase/health", { cache: "no-store" });
      if (!res.ok) throw new Error("health unavailable");
      return res.json();
    },
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 font-mono">
            <Database className="size-5 text-primary" aria-hidden="true" />
            Supabase
            <span className="text-xs font-normal text-muted-foreground">T-203 · Mgmt API</span>
          </CardTitle>
          {status.isLoading ? (
            <Skeleton className="h-6 w-24" />
          ) : status.data?.patPresent ? (
            status.data.probe && !status.data.probe.ok ? (
              <Badge variant="outline" className="border-destructive/50 text-destructive">
                PROBE FAILED ({status.data.probe.httpStatus || "network"})
              </Badge>
            ) : (
              <Badge className="bg-primary/15 font-mono text-primary text-glow">CONNECTED</Badge>
            )
          ) : (
            <Badge variant="outline" className="font-mono text-accent">
              NO PAT
            </Badge>
          )}
        </div>
        <CardDescription>
          Scoped Management-API PAT → encrypted vault (service supabase, label mgmt) · 120 req/min client limit ·
          Retry-After honored.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {status.isLoading ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-10 rounded-md" />
            <Skeleton className="h-16 rounded-md" />
          </div>
        ) : status.isError ? (
          <p className="text-sm text-destructive" role="alert">
            Supabase connector status unavailable — retrying automatically.
          </p>
        ) : (
          <>
            {/* ---- PAT row ---- */}
            <div className="space-y-2">
              <Label htmlFor="supabase-pat-input" className="text-xs text-muted-foreground">
                Management API access token {status.data.patPresent ? "(replace)" : ""}
              </Label>
              <div className="flex gap-2">
                <Input
                  id="supabase-pat-input"
                  type="password"
                  autoComplete="off"
                  className="min-h-11 font-mono"
                  placeholder="sbp_… (stored encrypted, never displayed)"
                  value={patValue}
                  onChange={(e) => setPatValue(e.target.value)}
                  aria-describedby="supabase-pat-hint"
                />
                {status.data.patPresent && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="size-11 shrink-0 text-destructive hover:text-destructive"
                        aria-label="Remove stored Management PAT"
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Remove Mgmt PAT?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Deletes the encrypted credential. Health and secrets management stop until a new PAT
                          is stored.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          className="min-h-11 bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          onClick={() => removePat.mutate()}
                        >
                          Remove
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
                <Button
                  className="min-h-11 shrink-0 font-mono"
                  disabled={patValue.trim().length < 8 || savePat.isPending}
                  onClick={() => savePat.mutate(patValue.trim())}
                  aria-label="Save Management PAT to vault"
                >
                  {savePat.isPending ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <KeyRound className="size-4" aria-hidden="true" />
                  )}
                  Save
                </Button>
              </div>
              <p id="supabase-pat-hint" className="font-mono text-xs text-muted-foreground">
                {status.data.patPresent
                  ? `stored ${status.data.masked ?? ""} · Mgmt ${status.data.mgmt.usageThisMinute}/${status.data.mgmt.limitPerMinute} this minute`
                  : "dashboard → Access Tokens → generate scoped token · value encrypted at rest (AES-256-GCM)"}
              </p>
            </div>

            {/* ---- DB connection string (L0 mirror unlock) ---- */}
            <DbUrlSection />

            {/* ---- Health row (MEASURED) ---- */}
            <HealthSection health={health} />

            {/* ---- Edge Function secrets (masked) ---- */}
            {status.data.patPresent && <SecretsSection health={health} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}

const DB_URL_LABEL = "supabase-db-url";

type CredsResp = {
  ok: boolean;
  credentials?: Array<{ id: string; label: string; masked: string; updatedAt: string }>;
};

/**
 * L0 mirror unlock — stores the Supabase Postgres transaction-pooler URI in the
 * encrypted vault (service supabase, label supabase-db-url). The embedded
 * guidance matches the CURRENT Supabase dashboard (header Connect button →
 * Direct tab → Transaction pooler) instead of the outdated Project Settings path.
 */
function DbUrlSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const creds = useQuery<CredsResp>({
    queryKey: ["connectors", "supabase-creds"],
    queryFn: async () => {
      const res = await fetch("/api/credentials?service=supabase", { cache: "no-store" });
      if (!res.ok) throw new Error("vault unavailable");
      return res.json();
    },
  });

  const dbUrl = creds.data?.credentials?.find((c) => c.label === DB_URL_LABEL) ?? null;

  const [urlValue, setUrlValue] = useState("");
  const looksLikeUri = /^postgres(ql)?:\/\//.test(urlValue.trim());

  const save = useMutation({
    mutationFn: async (uri: string) => {
      const res = await fetch("/api/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "supabase", label: DB_URL_LABEL, secret: uri }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(j?.error?.message ?? "save failed");
      }
      return res.json();
    },
    onSuccess: () => {
      setUrlValue("");
      void queryClient.invalidateQueries({ queryKey: ["connectors", "supabase-creds"] });
      toast({
        title: "DB connection string stored",
        description: "Pooler URI saved encrypted (service supabase, label supabase-db-url).",
      });
    },
    onError: (e: Error) =>
      toast({ title: "Not stored", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/credentials/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connectors", "supabase-creds"] });
      toast({ title: "DB connection string removed", description: "Vault credential deleted." });
    },
    onError: (e: Error) =>
      toast({ title: "Removal failed", description: e.message, variant: "destructive" }),
  });

  return (
    <section className="space-y-2" aria-label="DB connection string for the L0 mirror">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-muted-foreground">
          <Link2 className="size-3.5" aria-hidden="true" />
          DB connection string · L0 mirror
        </h3>
        {creds.isLoading ? (
          <Skeleton className="h-6 w-20" />
        ) : dbUrl ? (
          <Badge className="bg-primary/15 font-mono text-primary text-glow">
            STORED {dbUrl.masked}
          </Badge>
        ) : (
          <Badge variant="outline" className="font-mono text-accent">
            MISSING
          </Badge>
        )}
      </div>

      <p className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
        <span className="font-semibold text-foreground">Current dashboard route:</span> Supabase
        dashboard → your project → <span className="font-semibold text-foreground">Connect</span>{" "}
        button (top bar) → <span className="font-semibold text-foreground">Direct</span> tab → set
        the selector to <span className="font-semibold text-foreground">Transaction pooler</span>{" "}
        (port <span className="font-mono">6543</span>, host{" "}
        <span className="font-mono">aws-0-&lt;region&gt;.pooler.supabase.com</span>) → copy the{" "}
        <span className="font-mono">postgresql://…</span> URI → paste it here. The Framework /
        Server / ORM / MCP tabs are code-recipe views, not plain connection strings. Transaction
        pooler is the serverless-safe endpoint; Session pooler (5432) and the direct{" "}
        <span className="font-mono">db.&lt;ref&gt;.supabase.co</span> host are not.
      </p>

      {dbUrl && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 p-2 font-mono text-xs">
          <span className="truncate">
            stored {dbUrl.masked} · updated{" "}
            {new Date(dbUrl.updatedAt).toISOString().slice(0, 16).replace("T", " ")}Z
          </span>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="size-9 shrink-0 text-destructive hover:text-destructive"
                aria-label="Remove stored DB connection string"
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove DB connection string?</AlertDialogTitle>
                <AlertDialogDescription>
                  Deletes the encrypted pooler URI. The L0 mirror unlock checklist returns to
                  MISSING until it is stored again.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="min-h-11 bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => remove.mutate(dbUrl.id)}
                >
                  Remove
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}

      <div className="flex gap-2">
        <Input
          type="password"
          autoComplete="off"
          className="min-h-11 font-mono"
          placeholder="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres"
          aria-label="Supabase transaction pooler connection string"
          value={urlValue}
          onChange={(e) => setUrlValue(e.target.value)}
        />
        <Button
          className="min-h-11 shrink-0 font-mono"
          disabled={!looksLikeUri || save.isPending}
          onClick={() => save.mutate(urlValue.trim())}
          aria-label="Save DB connection string to vault"
        >
          {save.isPending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <KeyRound className="size-4" aria-hidden="true" />
          )}
          Save
        </Button>
      </div>
      {urlValue.trim().length > 0 && !looksLikeUri && (
        <p className="text-xs text-destructive" role="alert">
          Must start with postgresql:// or postgres:// — copy the URI from Connect → Direct →
          Transaction pooler.
        </p>
      )}
    </section>
  );
}

function HealthSection(props: { health: ReturnType<typeof useQuery<SupabaseHealth>> }) {
  const { health } = props;
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["connectors", "supabase-health"] });
  };

  return (
    <section className="space-y-2" aria-label="Measured project health">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-muted-foreground">
          <HeartPulse className="size-3.5" aria-hidden="true" />
          Health · measured
        </h3>
        <Button
          variant="ghost"
          size="sm"
          className="min-h-9 font-mono text-xs"
          onClick={refresh}
          disabled={health.isFetching}
          aria-label="Re-run health probe"
        >
          <RefreshCw className={`size-3.5 ${health.isFetching ? "animate-spin" : ""}`} aria-hidden="true" />
          Re-probe
        </Button>
      </div>

      {health.isLoading ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-12 rounded-md" />
          <Skeleton className="h-12 rounded-md" />
        </div>
      ) : health.isError ? (
        <p className="text-sm text-destructive" role="alert">
          Health probe route failed — retrying automatically.
        </p>
      ) : !health.data ? (
        <p className="py-2 text-sm text-muted-foreground">
          Health probe idle — save a Management API Personal Access Token first.
        </p>
      ) : !health.data.probeOk ? (
        <p className="rounded-md border border-destructive/50 p-3 text-sm text-destructive" role="alert">
          Mgmt probe failed — GET /v1/projects → {health.data.httpStatus || "network error"}
          {health.data.note ? ` (${health.data.note})` : ""}. Check the stored PAT.
        </p>
      ) : health.data.projects.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          Mgmt reachable (HTTP {health.data.httpStatus}) but no projects are visible to this token.
        </p>
      ) : (
        <ul className="space-y-2">
          {health.data.projects.map((p) => {
            const healthy = p.health.ok && p.status === "ACTIVE_HEALTHY";
            return (
              <li
                key={p.ref}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 p-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm">{p.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {p.ref} · {p.region ?? "region?"} · /health → {p.health.httpStatus}
                    {p.health.ok && p.health.reports.length > 0
                      ? ` · ${p.health.reports.filter((r) => r.healthy).length}/${p.health.reports.length} services healthy`
                      : p.health.ok
                        ? " · no reports"
                        : " · probe failed"}
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className={
                    healthy
                      ? "border-primary/40 font-mono text-primary"
                      : p.health.ok
                        ? "border-accent/60 font-mono text-accent"
                        : "border-destructive/50 font-mono text-destructive"
                  }
                >
                  {p.health.ok ? p.status : "UNREACHABLE"}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
      <p className="font-mono text-[11px] text-muted-foreground">
        evidence: GET api.supabase.com/v1/projects → {health.data?.httpStatus ?? "—"} · GET
        /v1/projects/{"{ref}"}/health per row
      </p>
    </section>
  );
}

/** Masked Edge Function secrets — names only; values are write-only (P7). */
function SecretsSection(props: { health: ReturnType<typeof useQuery<SupabaseHealth>> }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const projects = props.health.data?.probeOk ? props.health.data.projects : [];

  const [projectRef, setProjectRef] = useState<string>("");
  const [secretKey, setSecretKey] = useState("");
  const [secretValue, setSecretValue] = useState("");

  const activeRef = projectRef || projects[0]?.ref || "";
  const enabled = activeRef.length === 20;

  const secrets = useQuery<SecretsResp>({
    queryKey: ["connectors", "supabase-secrets", activeRef],
    enabled,
    queryFn: async () => {
      const res = await fetch(`/api/connectors/supabase/secrets?projectRef=${activeRef}`, { cache: "no-store" });
      return res.json();
    },
  });

  const addSecret = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/connectors/supabase/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectRef: activeRef, key: secretKey.trim(), value: secretValue }),
      });
      const j = (await res.json().catch(() => null)) as SecretsResp | null;
      if (!res.ok || !j?.ok) throw new Error(j?.error?.message ?? "add failed");
      return j;
    },
    onSuccess: () => {
      setSecretKey("");
      setSecretValue("");
      void queryClient.invalidateQueries({ queryKey: ["connectors", "supabase-secrets", activeRef] });
      toast({ title: "Secret stored", description: "Edge Function secret set via Mgmt API (value never displayed)." });
    },
    onError: (e: Error) =>
      toast({ title: "Secret not stored", description: e.message, variant: "destructive" }),
  });

  const removeSecret = useMutation({
    mutationFn: async (key: string) => {
      const res = await fetch("/api/connectors/supabase/secrets", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectRef: activeRef, key }),
      });
      const j = (await res.json().catch(() => null)) as SecretsResp | null;
      if (!res.ok || !j?.ok) throw new Error(j?.error?.message ?? "delete failed");
      return j;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connectors", "supabase-secrets", activeRef] });
      toast({ title: "Secret removed" });
    },
    onError: (e: Error) =>
      toast({ title: "Secret not removed", description: e.message, variant: "destructive" }),
  });

  return (
    <section className="space-y-3" aria-label="Edge Function secrets (masked)">
      <h3 className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-muted-foreground">
        <KeyRound className="size-3.5" aria-hidden="true" />
        Edge Function secrets · masked
      </h3>

      {projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No projects visible to this token — secrets management needs at least one project.
        </p>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="supabase-project-select" className="text-xs text-muted-foreground">
              Project
            </Label>
            <Select value={activeRef} onValueChange={setProjectRef}>
              <SelectTrigger id="supabase-project-select" className="min-h-11 w-full font-mono text-sm">
                <SelectValue placeholder="choose project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.ref} value={p.ref} className="font-mono text-sm">
                    {p.name} · {p.ref}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {enabled && (
            <>
              <form
                className="flex flex-col gap-2 sm:flex-row sm:items-end"
                onSubmit={(e) => {
                  e.preventDefault();
                  addSecret.mutate();
                }}
              >
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="supabase-secret-key" className="text-xs text-muted-foreground">
                    Key
                  </Label>
                  <Input
                    id="supabase-secret-key"
                    className="min-h-11 font-mono"
                    placeholder="MY_SECRET_KEY"
                    value={secretKey}
                    onChange={(e) => setSecretKey(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="supabase-secret-value" className="text-xs text-muted-foreground">
                    Value (write-only)
                  </Label>
                  <Input
                    id="supabase-secret-value"
                    type="password"
                    className="min-h-11 font-mono"
                    placeholder="••••••••"
                    value={secretValue}
                    onChange={(e) => setSecretValue(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <Button
                  type="submit"
                  className="min-h-11 font-mono"
                  disabled={!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretKey.trim()) || secretValue.length < 1 || addSecret.isPending}
                  aria-label="Add Edge Function secret"
                >
                  {addSecret.isPending ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Plus className="size-4" aria-hidden="true" />
                  )}
                  Add
                </Button>
              </form>

              {secrets.isLoading ? (
                <div className="space-y-2" aria-busy="true">
                  <Skeleton className="h-10 rounded-md" />
                  <Skeleton className="h-10 rounded-md" />
                </div>
              ) : secrets.isError ? (
                <p className="text-sm text-destructive" role="alert">
                  Secrets list unavailable — retrying automatically.
                </p>
              ) : secrets.data && !secrets.data.ok ? (
                <p className="rounded-md border border-destructive/50 p-3 text-sm text-destructive" role="alert">
                  {secrets.data.error?.message ?? "Mgmt API rejected the secrets list request."}
                </p>
              ) : secrets.data && secrets.data.secrets && secrets.data.secrets.length > 0 ? (
                <ul className="max-h-96 space-y-2 overflow-y-auto pr-1" aria-label="Secret names (values withheld)">
                  {secrets.data.secrets.map((sec) => (
                    <li
                      key={sec.name}
                      className="flex items-center justify-between gap-2 rounded-md border border-border/60 p-2.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-mono text-sm">{sec.name}</p>
                        <p className="font-mono text-[11px] text-muted-foreground">
                          {sec.hasValue ? "value stored (withheld)" : "alias only"}
                          {sec.alias ? ` · alias ${sec.alias}` : ""}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-11 shrink-0 text-destructive"
                        aria-label={`Remove secret ${sec.name}`}
                        disabled={removeSecret.isPending}
                        onClick={() => removeSecret.mutate(sec.name)}
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-3 text-center text-sm text-muted-foreground">
                  No Edge Function secrets on this project yet (masked list — values are never returned).
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
