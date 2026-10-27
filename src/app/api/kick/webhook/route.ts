import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clampStr, redactSecrets } from "@/lib/brain/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import {
  cortexCoalesce,
  cortexEchoLookup,
  interactionRowDuplicate,
  runCortex,
  type CortexResult,
} from "@/lib/brain/cortex";
import { getKickChatReplies, kickSendBotMessage, loadKickOAuth, verifyKickWebhook } from "@/lib/connectors/kick";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/kick/webhook — the OFFICIAL Kick event feed ingest (Task 30).
 *
 * Open by design (Kick's servers POST here), but the gate is cryptographic:
 * every delivery is verified with the RSA public key (docs-fresh, cached 1h)
 * against `${Kick-Event-Message-Id}.${Kick-Event-Timestamp}.${rawBody}` — a
 * forged request never reaches the brain. Idempotent via the ULID message id.
 *
 * We answer 200 IMMEDIATELY after signature validation (Kick auto-
 * unsubscribes webhooks that keep failing for a day) and process !ai
 * messages in the background: the SAME panel cortex the overlay widget
 * uses (echo guard dedupes the double-mount race) → InteractionLog row →
 * bot reply posted INTO the live chat via the official /public/v1/chat API.
 */

const AI_COMMAND_RE = /^!ai\b/i;
const EMOTE_RE = /\[emote:\d+:[^\]]*\]/gi;
// Emoji ban (owner directive 2026-10-27) — every bot-posted line is plain
// text. v31.4 also strips at the runCortex choke point so the panel log and
// the overlay are clean too.

type ChatMessagePayload = {
  broadcaster?: { channel_slug?: string };
  broadcaster_channel_slug?: string;
  sender?: { username?: string };
  sender_username?: string;
  content?: string;
};

function resultWebUsed(r: CortexResult): boolean {
  return ["exa-answer", "page-read", "web-fallback"].includes(r.telemetry?.webSearch ?? "none");
}

async function writeInteractionRow(opts: {
  channel: string;
  sender: string;
  prompt: string;
  result: CortexResult | null;
  forcedReply?: string;
  status: string;
}): Promise<void> {
  const r = opts.result;
  const message = clampStr(redactSecrets(opts.prompt), 2000);
  const response = clampStr(redactSecrets(r?.reply ?? opts.forcedReply ?? ""), 2000);
  // v31.4 — one row per exchange: the overlay's /api/brain/log already
  // recorded the coalesced answer for this identical message; a second row
  // with the same response is noise, not information.
  if (
    interactionRowDuplicate(
      opts.sender.toLowerCase().replace(/[^a-z0-9_]/g, "") || "izleyici",
      message,
      response,
    )
  ) {
    return;
  }
  try {
    await db.interactionLog.create({
      data: {
        channel: clampStr(opts.channel, 40).toLowerCase() || "specimba",
        username: opts.sender.toLowerCase().replace(/[^a-z0-9_]/g, "") || "izleyici",
        displayHandle: clampStr(opts.sender, 60),
        command: "ai",
        message,
        response,
        model: clampStr(r?.modelLabel ?? "VYCE // KICK WEBHOOK", 80),
        modelId: "",
        provider: clampStr(r?.provider ?? "none", 24).toLowerCase(),
        route: clampStr(r ? `panel-cortex/${r.route}` : "kick/webhook", 80),
        status: clampStr(opts.status, 24),
        latencyMs:
          typeof r?.telemetry?.latencyMs === "number"
            ? Math.min(600_000, Math.max(0, Math.round(r.telemetry.latencyMs)))
            : null,
        promptTokens: typeof r?.promptTokens === "number" ? r.promptTokens : null,
        completionTokens: typeof r?.completionTokens === "number" ? r.completionTokens : null,
        webUsed: r ? resultWebUsed(r) : false,
        flags: "[]",
        injectionScore: 0,
        memoryUsed: r?.memoryUsed === true,
        error: "",
      },
    });
  } catch {
    /* the log row is observability — never break the reply path on it */
  }
}

async function noteEvent(payload: Record<string, unknown>): Promise<void> {
  try {
    await db.event.create({
      data: {
        source: "kick",
        type: "kick.webhook.chat",
        level: "info",
        actor: String(payload.sender?.["username"] ?? "").slice(0, 60) || null,
        payload: JSON.stringify(payload).slice(0, 8192),
      },
    });
  } catch {
    /* same discipline */
  }
}

async function processChatMessage(payload: ChatMessagePayload, messageId: string): Promise<void> {
  const sender = clampStr(payload.sender?.username ?? payload.sender_username ?? "izleyici", 60) || "izleyici";
  const channel = clampStr(
    payload.broadcaster?.channel_slug ?? payload.broadcaster_channel_slug ?? "specimba",
    40,
  ).toLowerCase();
  const rawContent = clampStr(payload.content ?? "", 800);
  if (!AI_COMMAND_RE.test(rawContent)) return; // not a bot command — plain chat

  const prompt = rawContent.replace(AI_COMMAND_RE, "").replace(EMOTE_RE, " ").replace(/\s+/g, " ").trim();

  // Same-message dedupe across mounts: the OBS overlay widget already answers
  // this message via /api/brain/cortex (it reads the same chat through the
  // anonymous bridge). The echo guard covers sequential arrivals; for the
  // SAME-SECOND race (webhook pushed by Kick + overlay fetch land together —
  // measured live: two VYCE spends with two DIFFERENT answers per message)
  // v31.4 coalesces: the first caller runs, the other JOINS the same promise,
  // so the chat post always matches what the overlay shows.
  const echo = cortexEchoLookup(sender, prompt);
  let result: CortexResult | null = echo ?? null;

  if (!result) {
    try {
      result = await cortexCoalesce({
        sender,
        prompt,
        channel,
        rosterAdmin: false,
        start: () => runCortex({ sender, prompt, channel, streamerName: channel }),
      });
    } catch (e) {
      await writeInteractionRow({
        channel, sender, prompt, result: null,
        forcedReply: e instanceof Error ? e.message : "brain error", status: "error",
      });
      return;
    }
  }

  // Rate verdicts arrive as route "cortex-rate" (coalesced with the
  // overlay's identical attempt): log the busy row, keep chat clean.
  const busy = result.route === "cortex-rate";
  await writeInteractionRow({ channel, sender, prompt, result, status: busy ? "busy" : "ok" });
  if (busy) return;
  await noteEvent({ messageId, sender, channel, route: result.route, provider: result.provider });

  const oauth = await loadKickOAuth();
  const repliesOn = await getKickChatReplies();
  if (!oauth || !repliesOn) return; // connected-only feature; toggle respected

  const reply = result.drawSubject
    ? "Çizim overlay'de hazırlanıyor."
    : result.reply;
  if (!reply.trim()) return;
  await kickSendBotMessage(reply);
}

export async function POST(req: Request) {
  if (!rateLimit(`kick-hook:${clientKey(req)}`, 240, 60_000)) {
    return NextResponse.json({ ok: false, error: "rate limited" }, { status: 429 });
  }

  const rawBody = await req.text();
  const verify = await verifyKickWebhook({
    rawBody,
    messageId: req.headers.get("kick-event-message-id"),
    timestamp: req.headers.get("kick-event-message-timestamp"),
    signatureB64: req.headers.get("kick-event-signature"),
  });

  if (!verify.valid) {
    // Duplicates are SUCCESS for Kick (stop retrying); everything else is a
    // rejected delivery. We never mark invalid deliveries as seen. Log the
    // reason + header presence ONCE per minute (rate-limited) so a signature
    // regression is diagnosable from dev.log without touching the hot path.
    if (verify.reason === "DUPLICATE") {
      return NextResponse.json({ ok: true, deduped: true });
    }
    if (!rateLimit(`kick-hook-diag`, 1, 60_000)) {
      return NextResponse.json({ ok: false, error: verify.reason }, { status: 401 });
    }
    console.warn(
      `[kick-webhook] rejected reason=${verify.reason}` +
        ` headers: id=${req.headers.has("kick-event-message-id")}` +
        ` ts=${req.headers.has("kick-event-message-timestamp")}` +
        ` sig=${req.headers.has("kick-event-signature")}` +
        ` type=${req.headers.get("kick-event-type") ?? "-"}` +
        ` bodyLen=${rawBody.length}`,
    );
    return NextResponse.json({ ok: false, error: verify.reason }, { status: 401 });
  }

  const eventType = req.headers.get("kick-event-type") ?? "";
  if (eventType === "chat.message.sent") {
    // 200 first (Kick unsubscribes failing webhooks), work in the background.
    let payload: ChatMessagePayload = {};
    try {
      payload = JSON.parse(rawBody) as ChatMessagePayload;
    } catch {
      return NextResponse.json({ ok: true, ignored: "unparseable" });
    }
    void processChatMessage(payload, verify.messageId).catch(() => undefined);
  }

  return NextResponse.json({ ok: true, event: eventType || "unknown" });
}
