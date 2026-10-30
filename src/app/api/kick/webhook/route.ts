import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clampStr, redactSecrets } from "@/lib/brain/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import {
  cortexChatLineAppend,
  cortexChatLinesSnapshot,
  cortexCoalesce,
  cortexEchoLookup,
  interactionRowDuplicate,
  runCortex,
  type CortexResult,
} from "@/lib/brain/cortex";
import { getKickChatReplies, isBotHandle, kickSendBotMessage, loadKickOAuth, verifyKickWebhook } from "@/lib/connectors/kick";
import { queueDeepResearch, type DeepResearchKind } from "@/lib/brain/deep-research";
import { computeSecurityFlags, foldSecurityLessons } from "@/lib/brain/security-lesson";

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
  // v34.1 — SERVER-AUTHORITATIVE DETECTION AT THE ROW WRITER. This writer
  // wins the row for live Kick chat (the overlay's /api/brain/log POST for
  // the same exchange is deduped by interactionRowDuplicate), so the v34
  // log-route wiring alone never saw webhook-written rows: every live attack
  // landed as flags:"[]" and SecurityLesson stayed empty. Detect HERE from
  // the raw viewer prompt; /api/brain/log keeps the same fold via the shared
  // module — no write path can bypass detection anymore.
  const { flags: detectedFlags, injectionScore } = computeSecurityFlags(opts.prompt, null);
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
        // v31.6 — engine truth: the raw model id that actually answered
        // (beam-1.0 / glm-5.3-flash / …) or the honest non-model marker.
        modelId: clampStr(r?.modelId ?? "", 120),
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
        flags: JSON.stringify(detectedFlags),
        injectionScore,
        memoryUsed: r?.memoryUsed === true,
        error: "",
      },
    });
  } catch {
    /* the log row is observability — never break the reply path on it */
  }
  // Security memory fold (best-effort, same discipline as the row itself).
  if (detectedFlags.length) {
    foldSecurityLessons({
      username: opts.sender,
      message: opts.prompt,
      response,
      techniques: detectedFlags,
    }).catch(() => {});
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
  // v34.2 — SELF-TRIGGER GUARD: the bot's own channel posts (a viewer can make
  // the bot write "!ai …") come back through this webhook as chat events —
  // without this gate the bot answers ITSELF (measured: ~7 self-generations
  // and live self-talk on stream). The bot never consumes its own messages.
  if (isBotHandle(sender)) return;
  const channel = clampStr(
    payload.broadcaster?.channel_slug ?? payload.broadcaster_channel_slug ?? "specimba",
    40,
  ).toLowerCase();
  const rawContent = clampStr(payload.content ?? "", 800);
  // v36.9 — CHANNEL CHAT CONTEXT: every non-bot line feeds the channel
  // chat-lines ring, so the next !ai question resolves against the RUNNING
  // conversation (the "sen ne diyosun bu işlere kanka" → "bana tek satır
  // geldi" class had nothing to read). The bot's own lines never reach here
  // (self-trigger guard above).
  cortexChatLineAppend(channel, sender, rawContent);
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
        // v36.9 — the same room-transcript contract the overlay widget has
        // always used: the freshest plain-chat lines from the channel ring
        // (includes the current line, same as the widget's snippet).
        start: () =>
          runCortex({
            sender,
            prompt,
            channel,
            streamerName: channel,
            roomTranscript: cortexChatLinesSnapshot(channel, 14),
          }),
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

  // v33 — the holding line promised a grounded follow-up: arm the background
  // agent run (Exa Agent + HyperAgent ladder, budgets inside the module —
  // single-flight + 120s cooldown keep chat spam from burning credits). The
  // reply below (holding line) posts FIRST; the follow-up posts when the
  // agent lanes finish, with its own InteractionLog row (engine truth:
  // exa:agent:medium / hyper:agent:*). Replies toggle OFF ⇒ no credits burn.
  // The ECHO route is included: when the overlay's flight finished first the
  // webhook receives the replay copy (route cortex-echo) — the chat STILL
  // needs the promised follow-up armed (measured same-second race class,
  // v31.4's coalesce/echo machinery). queueDeepResearch's own single-flight
  // + cooldown make double-arming harmless.
  const deepEchoArm =
    result.route === "cortex-echo" && result.deepResearch ? result.deepResearch : null;
  const deepArm = result.route === "cortex-deep-queued" && result.deepResearch ? result.deepResearch : deepEchoArm;
  if (deepArm) {
    const kind = (deepArm.kind === "poll" || deepArm.kind === "market" ? deepArm.kind : "news") as DeepResearchKind;
    const effort = ["low", "medium", "high", "xhigh", "ultra"].includes(deepArm.effort)
      ? (deepArm.effort as "low" | "medium" | "high" | "xhigh" | "ultra")
      : "medium";
    void queueDeepResearch({ channel, sender, prompt, kind, effort }).catch(() => undefined);
  }

  const reply = result.drawSubject
    ? "Çizim overlay'de hazırlanıyor."
    : result.reply;
  if (!reply.trim()) return;
  // v31.6 — send-identity observability: the ladder answers bot-first; a
  // USER-identity win or a failure is diagnosable from dev.log instead of
  // being silently swallowed (owner ask: replies must come from the BOT,
  // never the streamer's own identity).
  const send = await kickSendBotMessage(reply);
  if (!send.ok) {
    console.warn(`[kick-webhook] bot send failed code=${send.code ?? "?"}`);
  } else if (send.deduped) {
    // v38 — the identical line was already delivered moments ago (ladder
    // guard / redelivery class): suppressed at the transport, chat stays clean.
    console.info(`[kick-webhook] reply deduped at transport (code=${send.code ?? "?"}) — no second post`);
  } else if (send.identity === "user") {
    console.warn(`[kick-webhook] bot send fell back to USER identity — bot lanes failed (code=${send.code ?? "n/a"})`);
  }
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
