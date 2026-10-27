import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { kickListWebhookSubs, kickSubscribeWebhook, kickUnsubscribe, requestOrigin } from "@/lib/connectors/kick";

export const dynamic = "force-dynamic";

/**
 * /api/kick/webhook-setup — the official event feed control.
 *
 * POST   → subscribe chat.message.sent (v1) to <origin>/api/kick/webhook.
 *         Requires a connected account (events:subscribe was in the OAuth
 *         scope request) — Kick infers the broadcaster from the token.
 * DELETE → unsubscribe the app's chat.message.sent subscriptions.
 *
 * The ingest route is signature-gated (RSA public key, docs-fresh) and
 * answers 200 after validation so Kick never walks the "failing webhook
 * for a day → auto-unsubscribe" path on our watch.
 */
export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`kick-hooksetup:${clientKey(req)}`, 10, 60_000)) {
    return NextResponse.json({ ok: false, error: { code: "RATE_LIMITED", message: "Slow down." } }, { status: 429 });
  }

  const hookUrl = `${requestOrigin(req).replace(/\/+$/, "")}/api/kick/webhook`;
  const res = await kickSubscribeWebhook(hookUrl);
  if (!res.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: res.code ?? "SUBSCRIBE_FAILED",
          message: `Kick did not register the webhook (url: ${hookUrl}). Check that the app enables webhooks and the token carries events:subscribe.`,
        },
      },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, url: hookUrl, subs: res.subs ?? [] }, { status: 201 });
}

export async function DELETE(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`kick-hooksetup:${clientKey(req)}`, 10, 60_000)) {
    return NextResponse.json({ ok: false, error: { code: "RATE_LIMITED", message: "Slow down." } }, { status: 429 });
  }

  const subs = await kickListWebhookSubs();
  const targets = (subs ?? []).filter((s) => s.event === "chat.message.sent").map((s) => s.id);
  const res = await kickUnsubscribe(targets);
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: { code: res.code ?? "UNSUBSCRIBE_FAILED" } }, { status: 502 });
  }
  return NextResponse.json({ ok: true, removed: targets.length });
}
