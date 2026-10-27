import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import {
  KICK_SCOPES,
  KICK_SCOPE_HINTS,
  getKickChatReplies,
  kickCallbackUrl,
  kickListWebhookSubs,
  loadKickApp,
  loadKickOAuth,
  maskKickApp,
  publicOrigin,
} from "@/lib/connectors/kick";

export const dynamic = "force-dynamic";

/**
 * GET /api/kick/status — the KickCard state feed (Task 30).
 *
 * Panel-session only. Reports the FULL connection state in one call:
 *   - app:       configured? masked client previews (never raw values)
 *   - oauth:     connected? account, granted scope, token expiry
 *   - redirect:  the exact /api/kick/callback URL to register in the Kick
 *                Create-an-App form (computed from the request origin)
 *   - webhooks:  live chat.message.sent subscriptions when connected
 *   - chatReplies: the bot-replies-in-chat toggle
 */
export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`kick-status:${clientKey(req)}`, 60, 60_000)) {
    return NextResponse.json({ ok: false, error: { code: "RATE_LIMITED", message: "Slow down." } }, { status: 429 });
  }

  const app = await loadKickApp();
  const oauth = await loadKickOAuth();
  const chatReplies = await getKickChatReplies();
  // v31 — PUBLIC-ORIGIN TRUTH: behind the preview gateway the request-derived
  // origin is the FC tunnel host + http (the exact wrong URL the owner pasted
  // into the Kick form). The anchored OBS base URL is the real https origin.
  const redirectUri = kickCallbackUrl(await publicOrigin(req));

  let webhooks: { subs: Array<{ id: string; event: string; version: number }> | null; error: string | null } = {
    subs: null,
    error: null,
  };
  if (app && oauth) {
    try {
      webhooks.subs = await kickListWebhookSubs();
    } catch (e) {
      webhooks.error = e instanceof Error ? e.message : "subscription list unavailable";
    }
  }

  return NextResponse.json({
    ok: true,
    status: {
      configured: app !== null,
      app: app ? maskKickApp(app) : null,
      connected: oauth !== null,
      account: oauth?.account ?? null,
      scope: oauth?.scope ?? null,
      expiresAt: oauth?.expiresAt ?? null,
      redirectUri,
      scopes: KICK_SCOPES,
      scopeHints: KICK_SCOPE_HINTS,
      webhooks,
      chatReplies,
    },
  });
}
