import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  getExaKey,
  setExaKey,
  getExaUsage,
  getExaBudget,
  setExaBudget,
  exaListMonitors,
  exaCreateMonitor,
  exaDeleteMonitor,
  readWebhookInbox,
  type ExaMonitorDraft,
} from "@/lib/connectors/exa";
import {
  ensureMonitorScheduler,
  listLocalMonitors,
  listMonitorRuns,
  createLocalMonitor,
  deleteLocalMonitor,
  setLocalMonitorPaused,
  runLocalMonitorNow,
  LOCAL_PERIODS,
} from "@/lib/connectors/exa-monitors";
import { getMgmtPat, mgmtUpsertSecrets, isValidProjectRef, resolveCortexProjectRef, resolveCortexAnonKey } from "@/lib/connectors/supabase";
import { EXA_DIGEST_SETTING, buildNewsDigest } from "@/lib/brain/exa-news";
import { clientKey, rateLimit } from "@/lib/guard";

/**
 * GET /api/exa — status surface for the Connectors Exa card:
 * key armed (masked), today's usage ledger + budgets, native monitors,
 * LOCAL monitors + run history, webhook inbox, cached news digest. No secret
 * material ever leaves the process (P7). First GET also arms the in-process
 * monitor scheduler (local monitors keep firing while the panel is closed).
 *
 * POST /api/exa — owner actions:
 *   { action: "set-key", secret }              → vault-encrypt + arm + live probe
 *   { action: "set-budget", dailySearch?, dailyAnswer?, dailyContents? }
 *   { action: "create-monitor", query, numResults?, period?, webhookUrl? }
 *                                              → transport "exa" (native
 *                                                monitor → public https
 *                                                webhook) when an explicit
 *                                                public URL exists (owner-
 *                                                provided or EXA_WEBHOOK_URL
 *                                                env); otherwise transport
 *                                                "local" — the in-process
 *                                                scheduler runs the query on
 *                                                its interval and feeds the
 *                                                SAME /api/exa/webhook inbox.
 *   { action: "delete-monitor", id }           → local_ prefix = local store,
 *                                                else DELETE /monitors/{id}
 *   { action: "toggle-monitor", id, paused }   → local pause/resume
 *   { action: "run-monitor", id }              → immediate local run
 *   { action: "refresh-digest" }               → force a fresh AI-news digest
 */
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  // Local monitors keep their schedule even with the panel closed; the first
  // API touch after a restart re-arms the interval.
  ensureMonitorScheduler();

  const [key, usage, budget, digestRow, inbox, ref, anon] = await Promise.all([
    getExaKey(),
    getExaUsage(),
    getExaBudget(),
    (async () => {
      const row = await db.setting.findUnique({ where: { key: EXA_DIGEST_SETTING } }).catch(() => null);
      if (!row?.value) return null;
      try {
        return JSON.parse(row.value) as Record<string, unknown>;
      } catch {
        return null;
      }
    })(),
    readWebhookInbox(),
    resolveCortexProjectRef(),
    resolveCortexAnonKey(),
  ]);

  // Live edge probe: which cortex version is running, is its Exa tier armed?
  let edge: { reachable: boolean; service: string; exaArmed: boolean } = {
    reachable: false,
    service: "",
    exaArmed: false,
  };
  if (ref) {
    try {
      const res = await fetch(`https://${ref}.supabase.co/functions/v1/nexus-cortex-harness`, {
        headers: anon ? { Authorization: `Bearer ${anon}` } : {},
        signal: AbortSignal.timeout(6000),
      });
      const j = (await res.json().catch(() => ({}))) as { service?: string; exaArmed?: boolean };
      edge = { reachable: res.ok, service: j.service ?? "", exaArmed: Boolean(j.exaArmed) };
    } catch {
      edge = { reachable: false, service: "", exaArmed: false };
    }
  }

  let monitors: Array<Record<string, unknown>> = [];
  let monitorsError = "";
  if (key) {
    const m = await exaListMonitors();
    if (m.ok) monitors = m.monitors as unknown as Array<Record<string, unknown>>;
    else monitorsError = m.error;
  }

  const [localMonitors, monitorRuns] = await Promise.all([listLocalMonitors(), listMonitorRuns(12)]);
  const envWebhook = (process.env.EXA_WEBHOOK_URL ?? "").trim();

  return NextResponse.json({
    ok: true,
    armed: Boolean(key),
    maskedKey: key ? "••••" + key.slice(-4) : "",
    usage,
    budget,
    digest: digestRow,
    monitors,
    monitorsError,
    localMonitors,
    monitorRuns,
    webhookMode: {
      // Native monitors only when a public https webhook exists; otherwise
      // creation falls back to the local scheduler (never fails on proto).
      nativeWebhook: /^https:\/\//i.test(envWebhook),
      source: /^https:\/\//i.test(envWebhook) ? "env:EXA_WEBHOOK_URL" : "local-scheduler",
    },
    webhookInbox: inbox.slice(0, 8),
    edge,
  });
}

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`exa-post:${clientKey(req)}`, 20, 60_000)) {
    return NextResponse.json({ ok: false, error: "rate limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = String(body?.action ?? "");

  if (action === "set-key") {
    const secret = typeof body?.secret === "string" ? body.secret.trim() : "";
    if (secret.length < 8 || secret.length > 256) {
      return NextResponse.json(
        { ok: false, error: { code: "BAD_SECRET", message: "secret must be 8..256 chars" } },
        { status: 400 },
      );
    }
    const { masked } = await setExaKey(secret);
    // Immediate live probe so the owner sees ARMED only when it truly works.
    const probe = await buildNewsDigest(true);
    // Auto-arm the LIVE edge: push the key into the Supabase project the
    // stream brain already calls, so nexus-cortex v29.14's Exa tier lights up
    // without a redeploy (edge reads EXA_API_KEY per invocation).
    let edgeArmed = false;
    let edgeError = "";
    try {
      const ref = await resolveCortexProjectRef();
      if (!ref || !isValidProjectRef(ref)) {
        edgeError = "edge project ref not found (widget supabase_url)";
      } else {
        const pat = await getMgmtPat();
        if (!pat) {
          edgeError = "no Supabase mgmt PAT in vault";
        } else {
          const res = await mgmtUpsertSecrets(pat, ref, [
            { key: "EXA_API_KEY", value: secret.trim() },
          ]);
          edgeArmed = res.ok;
          if (!res.ok) edgeError = `edge secret push failed HTTP ${res.status}`;
        }
      }
    } catch (e) {
      edgeError = e instanceof Error ? e.message.slice(0, 120) : "edge push failed";
    }
    return NextResponse.json({
      ok: true,
      maskedKey: masked,
      edgeArmed,
      edgeError,
      probe: { ok: probe.ok, error: probe.ok ? "" : probe.error, items: probe.ok ? probe.items.length : 0 },
    });
  }

  if (action === "set-budget") {
    const budget = await setExaBudget({
      dailySearch: typeof body?.dailySearch === "number" ? body.dailySearch : undefined,
      dailyAnswer: typeof body?.dailyAnswer === "number" ? body.dailyAnswer : undefined,
      dailyContents: typeof body?.dailyContents === "number" ? body.dailyContents : undefined,
    });
    return NextResponse.json({ ok: true, budget });
  }

  if (action === "create-monitor") {
    const key = await getExaKey();
    if (!key) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_ARMED", message: "Save the Exa API key first" } },
        { status: 400 },
      );
    }
    const query = String(body?.query ?? "").trim();
    if (!query) {
      return NextResponse.json(
        { ok: false, error: { code: "BAD_QUERY", message: "query required" } },
        { status: 400 },
      );
    }
    const numResults = typeof body?.numResults === "number" ? body.numResults : 8;
    const period = String(body?.period ?? "1d");
    const allowedPeriods = Object.keys(LOCAL_PERIODS);
    const safePeriod = allowedPeriods.includes(period) ? period : "1d";

    // v34 — transport decision. Native Exa monitors need a PUBLIC https
    // webhook (no redirects). This sandbox origin is http-behind-gateway and
    // not stably reachable by Exa's servers, so deriving it from the request
    // ALWAYS failed ("webhook url required"). Native is only attempted when a
    // public URL is explicitly configured: owner-provided body.webhookUrl or
    // EXA_WEBHOOK_URL env. Everything else runs locally in-process.
    const explicitUrl = typeof body?.webhookUrl === "string" ? body.webhookUrl.trim() : "";
    const envUrl = (process.env.EXA_WEBHOOK_URL ?? "").trim();
    const nativeUrl = /^https:\/\//i.test(explicitUrl)
      ? explicitUrl
      : /^https:\/\//i.test(envUrl)
        ? envUrl
        : "";

    if (nativeUrl) {
      // Docs (MEASURED 2026-10-25): native single durations ≥ 1h; "1w" maps
      // to "7d" for the wire format. Local's 15m bumps to 1h on the wire.
      const nativePeriod = (safePeriod === "15m" ? "1h" : safePeriod) as ExaMonitorDraft["period"];
      const created = await exaCreateMonitor({
        query,
        numResults,
        period: nativePeriod,
        webhookUrl: nativeUrl,
      });
      if (!created.ok) {
        return NextResponse.json(
          { ok: false, error: { code: "EXA_ERROR", message: created.error } },
          { status: 502 },
        );
      }
      return NextResponse.json({ ok: true, transport: "exa", monitor: created.monitor, webhookUrl: nativeUrl });
    }

    const created = await createLocalMonitor({ query, numResults, period: safePeriod });
    if (!created.ok) {
      return NextResponse.json(
        { ok: false, error: { code: "MONITOR_REJECTED", message: created.error } },
        { status: 400 },
      );
    }
    ensureMonitorScheduler();
    return NextResponse.json({ ok: true, transport: "local", monitor: created.monitor });
  }

  if (action === "delete-monitor") {
    const id = String(body?.id ?? "").trim();
    if (!id) {
      return NextResponse.json(
        { ok: false, error: { code: "BAD_ID", message: "monitor id required" } },
        { status: 400 },
      );
    }
    if (id.startsWith("local_")) {
      const removed = await deleteLocalMonitor(id);
      if (!removed) {
        return NextResponse.json(
          { ok: false, error: { code: "NOT_FOUND", message: "local monitor not found" } },
          { status: 404 },
        );
      }
      return NextResponse.json({ ok: true, transport: "local" });
    }
    const removed = await exaDeleteMonitor(id);
    if (!removed.ok) {
      return NextResponse.json(
        { ok: false, error: { code: "EXA_ERROR", message: removed.error } },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, transport: "exa" });
  }

  if (action === "toggle-monitor") {
    const id = String(body?.id ?? "").trim();
    const paused = body?.paused === true;
    if (!id.startsWith("local_")) {
      return NextResponse.json(
        { ok: false, error: { code: "BAD_ID", message: "pause/resume is local-only (native monitors are managed on dashboard.exa.ai)" } },
        { status: 400 },
      );
    }
    const updated = await setLocalMonitorPaused(id, paused);
    if (!updated) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "local monitor not found" } },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, monitor: updated });
  }

  if (action === "run-monitor") {
    const id = String(body?.id ?? "").trim();
    if (!id.startsWith("local_")) {
      return NextResponse.json(
        { ok: false, error: { code: "BAD_ID", message: "run-now is local-only" } },
        { status: 400 },
      );
    }
    const run = await runLocalMonitorNow(id);
    if (!run) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "local monitor not found (or a run is already in flight)" } },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, run });
  }

  if (action === "refresh-digest") {
    const digest = await buildNewsDigest(true);
    return NextResponse.json({ ok: digest.ok, digest });
  }

  return NextResponse.json(
    { ok: false, error: { code: "BAD_ACTION", message: "unknown action" } },
    { status: 400 },
  );
}
