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
  readWebhookInbox,
  type ExaMonitorDraft,
} from "@/lib/connectors/exa";
import { getMgmtPat, mgmtUpsertSecrets, isValidProjectRef, resolveCortexProjectRef, resolveCortexAnonKey } from "@/lib/connectors/supabase";
import { EXA_DIGEST_SETTING, buildNewsDigest } from "@/lib/brain/exa-news";
import { clientKey, rateLimit } from "@/lib/guard";

/**
 * GET /api/exa — status surface for the Connectors Exa card:
 * key armed (masked), today's usage ledger + budgets, monitors, webhook inbox,
 * cached news digest. No secret material ever leaves the process (P7).
 *
 * POST /api/exa — four owner actions:
 *   { action: "set-key", secret }              → vault-encrypt + arm + live probe
 *   { action: "set-budget", dailySearch?, dailyAnswer?, dailyContents? }
 *   { action: "create-monitor", query, numResults?, period? }
 *                                              → registers an Exa Monitor that
 *                                                pushes deduped results to
 *                                                /api/exa/webhook
 *   { action: "refresh-digest" }               → force a fresh AI-news digest
 */
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

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

  return NextResponse.json({
    ok: true,
    armed: Boolean(key),
    maskedKey: key ? "••••" + key.slice(-4) : "",
    usage,
    budget,
    digest: digestRow,
    monitors,
    monitorsError,
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
    // The webhook must point at a publicly reachable origin — derive from the
    // request host (preview gateway included), https enforced when forwarded.
    const proto = (req.headers.get("x-forwarded-proto") ?? "http").split(",")[0].trim();
    const host = req.headers.get("host") ?? "localhost:3000";
    const webhookUrl = `${proto}://${host}/api/exa/webhook`;
    const period = String(body?.period ?? "1d");
    const allowedPeriods: readonly ExaMonitorDraft["period"][] = ["1h", "6h", "12h", "1d", "1w", "7d"];
    const created = await exaCreateMonitor({
      query,
      numResults: typeof body?.numResults === "number" ? body.numResults : 10,
      // Docs (MEASURED 2026-10-25): single durations ≥ 1h; exaCreateMonitor
      // maps "1w" → "7d" for the wire format.
      period: allowedPeriods.includes(period as ExaMonitorDraft["period"])
        ? (period as ExaMonitorDraft["period"])
        : "1d",
      webhookUrl,
    });
    if (!created.ok) {
      return NextResponse.json(
        { ok: false, error: { code: "EXA_ERROR", message: created.error } },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, monitor: created.monitor, webhookUrl });
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
