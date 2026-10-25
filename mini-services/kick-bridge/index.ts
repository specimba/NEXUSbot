/**
 * NEXUS OS — kick-bridge mini service (port 3010).
 *
 * The missing piece the owner's screenshots asked for: the Kickbot CLOUD used
 * to pipe kick.com live chat into widgets behind the scenes. Local-first, we
 * own that pipe now. This service:
 *
 *   1. Resolves the owner's channel (slug → channel_id + chatroom_id) via
 *      kick.com/api/v2 (public; no credentials — verified working from this
 *      egress before building).
 *   2. Opens ONE anonymous viewer connection to Kick's CURRENT realtime
 *      gateway. VERIFIED GROUND TRUTH (2026-10, probed from this sandbox):
 *        a. POST web.kick.com/api/v1/realtime/channels/{channel_id}/chat/connection
 *           {client:{id,type:"web"}, capabilities:{accepted_providers:[pusher,centrifugo]}}
 *           → {data:{connections:[{provider:"centrifugo",
 *              credentials:{url:"wss://realtime.us-east-1.platform.kick.com/connection/websocket"}}]}}
 *        b. POST web.kick.com/api/v1/realtime/auth/connection {client_id}
 *           → guest JWT (sub "guest:…", ~45 min TTL) — anonymous read, exactly
 *           what a logged-out viewer's browser does.
 *        c. Centrifuge JSON protocol: connect {name:"js",version,token};
 *           subscribe chatrooms.{chatroom_id}.v2; server keepalive is a bare
 *           `{}` frame → answer `{}`; `{"ping":true}` → `{"pong":true}`.
 *        d. Chat arrives as {push:{channel, pub:{data:{event, data:"<json>"}}}}
 *           where event = "App\Events\ChatMessageEvent" (SAME schema as the
 *           legacy Pusher feed — verified live on a busy chatroom).
 *      The OLD Pusher endpoint (ws-us2/app/32cbd69e4b950bf97679) is DEAD —
 *      server answers code 4001 "App key not in this cluster".
 *      One upstream connection, ping/pong keepalive, reconnect with backoff +
 *      jitter (5s → 60s), proactive token refresh every ~40 min.
 *   3. Polls /api/v2/channels/{slug} every 45s for the live viewer count.
 *   4. Fans every event out to connected widget clients (raw WebSocket — the
 *      OBS browser source connects through the panel gateway as
 *      ws(s)://<origin>/?XTransformPort=3010&ch=<slug>) in the EXACT
 *      widgetEvent contract the widgets already listen for:
 *        { event_name: 'chatMessageEvent', data: {…} }
 *        { event_name: 'viewerCountUpdatedEvent', data: { viewer_count } }
 *        { event_name: 'bridgeStatusEvent', data: { state, … } } (heartbeat)
 *
 * Auth posture (honest): the socket relays PUBLIC chat the same as any viewer
 * sees at kick.com/popout/<slug>/chat — read-only, no credentials involved.
 * The bridge only ever serves its OWN configured channel (NEXUS_KICK_CHANNEL,
 * default "specimba"); a ?ch= from a stranger cannot spawn other upstreams.
 */

import http from "node:http";
import crypto from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

const PORT = 3010;
const CHANNEL = (process.env.NEXUS_KICK_CHANNEL || "specimba").toLowerCase();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const VIEWER_POLL_MS = 45_000;
const STATUS_BEAT_MS = 30_000;
const PROACTIVE_REFRESH_MS = 40 * 60_000; // guest token TTL ≈ 45 min → reconnect before expiry

type ChannelInfo = { channel_id: number; chatroom_id: number; viewer_count: number; is_live: boolean };

const state = {
  upstream: "idle" as "idle" | "connecting" | "live" | "reconnecting" | "down",
  lastChatAt: null as string | null,
  lastViewers: 0,
  lastError: "" as string,
  chatroomId: null as number | null,
  infoFetchedAt: null as string | null,
};

const clients = new Set<WebSocket>();
const channelState: { channel_id: number } = { channel_id: 0 };

function broadcast(payload: Record<string, unknown>): void {
  const frame = JSON.stringify(payload);
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) {
      try {
        c.send(frame);
      } catch {
        /* a dying socket removes itself on close */
      }
    }
  }
}

function log(...args: unknown[]): void {
  console.log(new Date().toISOString().slice(11, 19), "[kick-bridge]", ...args);
}

// ---------------------------------------------------------------------------
// 1) Channel resolve + viewer poll (public REST)
// ---------------------------------------------------------------------------

async function fetchChannelInfo(): Promise<ChannelInfo | null> {
  try {
    const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(CHANNEL)}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      state.lastError = `channel API HTTP ${res.status}`;
      log("channel API", res.status);
      return null;
    }
    const j = (await res.json()) as {
      id?: number;
      chatroom?: { id?: number };
      livestream?: { is_live?: boolean; viewer_count?: number } | null;
    };
    if (!j.id || !j.chatroom?.id) {
      state.lastError = "channel API payload missing ids";
      return null;
    }
    state.infoFetchedAt = new Date().toISOString();
    const info: ChannelInfo = {
      channel_id: j.id,
      chatroom_id: j.chatroom.id,
      viewer_count: j.livestream?.viewer_count ?? 0,
      is_live: Boolean(j.livestream?.is_live),
    };
    state.chatroomId = info.chatroom_id;
    state.lastError = "";
    return info;
  } catch (e) {
    state.lastError = e instanceof Error ? e.message : String(e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 2) Upstream: one anonymous Centrifuge chat connection (verified protocol)
// ---------------------------------------------------------------------------

function gatewayHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": UA,
    Accept: "application/json",
    Origin: "https://kick.com",
    Referer: `https://kick.com/popout/${CHANNEL}/chat`,
  };
}

/** Guest connection token (same as a logged-out viewer's browser gets). */
async function fetchGuestToken(clientId: string): Promise<string> {
  const res = await fetch("https://web.kick.com/api/v1/realtime/auth/connection", {
    method: "POST",
    headers: gatewayHeaders(),
    body: JSON.stringify({ client_id: clientId }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`auth/connection HTTP ${res.status}`);
  const j = (await res.json()) as { data?: { token?: string } };
  if (!j.data?.token) throw new Error("auth/connection returned no token");
  return j.data.token;
}

/** Ask Kick which realtime gateway serves this channel's chat today. */
async function fetchGatewayUrl(): Promise<string> {
  const res = await fetch(
    `https://web.kick.com/api/v1/realtime/channels/${channelState.channel_id}/chat/connection`,
    {
      method: "POST",
      headers: gatewayHeaders(),
      body: JSON.stringify({
        client: { id: crypto.randomUUID(), type: "web" },
        capabilities: { accepted_providers: [{ provider: "centrifugo" }] },
      }),
      signal: AbortSignal.timeout(12_000),
    },
  );
  if (!res.ok) throw new Error(`chat/connection HTTP ${res.status}`);
  const j = (await res.json()) as {
    data?: { connections?: Array<{ provider?: string; credentials?: { url?: string } }> };
  };
  const centrifugo = j.data?.connections?.find((c) => c.provider === "centrifugo" && c.credentials?.url);
  if (!centrifugo) throw new Error("no centrifugo connection offered");
  return centrifugo.credentials!.url!;
}

let upstream: WebSocket | null = null;
let upstreamRetry = 0;
let keepalive: ReturnType<typeof setInterval> | null = null;
let proactive: ReturnType<typeof setTimeout> | null = null;
let connecting = false;

function upstreamSend(obj: Record<string, unknown>): void {
  if (upstream && upstream.readyState === WebSocket.OPEN) {
    try {
      upstream.send(JSON.stringify(obj));
    } catch {
      /* reconnect handles it */
    }
  }
}

function teardownUpstream(): void {
  if (keepalive) clearInterval(keepalive);
  keepalive = null;
  if (proactive) clearTimeout(proactive);
  proactive = null;
  try {
    upstream?.removeAllListeners();
    upstream?.terminate();
  } catch {
    /* already dead */
  }
  upstream = null;
}

function scheduleUpstreamReconnect(): void {
  if (connecting) return;
  teardownUpstream();
  const delay = Math.min(60_000, 5_000 * Math.pow(1.7, Math.min(upstreamRetry, 5)) + Math.random() * 2_000);
  upstreamRetry += 1;
  state.upstream = upstreamRetry <= 1 ? "connecting" : "reconnecting";
  log(`upstream reconnect in ${Math.round(delay / 1000)}s (attempt ${upstreamRetry})`);
  setTimeout(connectUpstream, delay);
}

async function connectUpstream(): Promise<void> {
  if (connecting) return;
  if (!state.chatroomId || !channelState.channel_id) {
    scheduleUpstreamReconnect();
    return;
  }
  connecting = true;
  state.upstream = "connecting";
  try {
    const [gatewayUrl, token] = await Promise.all([fetchGatewayUrl(), (async () => {
      const cid = `${Date.now()}${crypto.randomUUID().slice(0, 8)}`;
      return fetchGuestToken(cid);
    })()]);

    const ws = new WebSocket(gatewayUrl);
    upstream = ws;

    ws.on("open", () => {
      upstreamSend({ id: 1, connect: { name: "js", version: "5.7.3", token } });
    });

    ws.on("message", (raw) => {
      const text = String(raw);
      // Server keepalive: bare "{}" → answer "{}" (verified — ignoring it
      // gets the socket closed with 3012 "no pong").
      if (text === "{}") {
        upstreamSend({});
        return;
      }
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      if (frame.ping === true) {
        upstreamSend({ pong: true });
        return;
      }
      if (frame.connect && typeof frame.connect === "object") {
        // connection established → subscribe to the chatroom channel
        upstreamSend({ id: 2, subscribe: { channel: `chatrooms.${state.chatroomId}.v2` } });
        upstreamRetry = 0;
        state.upstream = "live";
        state.lastError = "";
        log(`upstream LIVE → chatrooms.${state.chatroomId}.v2 @ ${gatewayUrl.split("/")[2]}`);
        // Refresh the guest token before its ~45 min expiry: tear down and
        // reconnect cleanly (fresh token) rather than waiting for the kick.
        proactive = setTimeout(() => {
          log("proactive token refresh");
          scheduleUpstreamReconnect();
        }, PROACTIVE_REFRESH_MS);
        return;
      }
      if (frame.subscribe && typeof frame.subscribe === "object") {
        log(`subscription confirmed: chatrooms.${state.chatroomId}.v2`);
        return;
      }
      if (frame.push && typeof frame.push === "object") {
        try {
          const push = frame.push as {
            channel?: string;
            pub?: { data?: { event?: string; data?: string } | string };
          };
          if (push.channel !== `chatrooms.${state.chatroomId}.v2` || !push.pub?.data) return;
          const inner =
            typeof push.pub.data === "string" ? JSON.parse(push.pub.data) : push.pub.data;
          if (inner?.event !== "App\\Events\\ChatMessageEvent") return;
          const m = JSON.parse(inner.data ?? "{}") as {
            id?: number | string;
            content?: string;
            type?: string;
            created_at?: string;
            sender?: { id?: number; username?: string; slug?: string; identity?: { color?: string } };
          };
          if (!m.sender?.username || typeof m.content !== "string") return;
          state.lastChatAt = new Date().toISOString();
          broadcast({
            event_name: "chatMessageEvent",
            data: {
              id: String(m.id ?? `${Date.now()}`),
              created_at: m.created_at ?? new Date().toISOString(),
              sender: {
                id: m.sender.id ?? 0,
                username: m.sender.username,
                slug: m.sender.slug ?? m.sender.username,
                identity: { color: m.sender.identity?.color ?? "#53fc18" },
              },
              content: m.content,
              type: m.type ?? "message",
            },
          });
        } catch {
          /* malformed chat frame — skip, never crash the bridge */
        }
        return;
      }
      if (frame.disconnect) {
        const d = frame.disconnect as { code?: number; reason?: string };
        log(`server disconnect: code=${d.code} reason=${d.reason ?? ""}`);
        scheduleUpstreamReconnect();
        return;
      }
    });

    ws.on("error", (err) => {
      state.lastError = err.message;
    });
    ws.on("close", () => {
      if (upstream === ws) scheduleUpstreamReconnect();
    });
  } catch (e) {
    state.lastError = e instanceof Error ? e.message : String(e);
    log("connect failed:", state.lastError);
    scheduleUpstreamReconnect();
  } finally {
    connecting = false;
  }
}

// ---------------------------------------------------------------------------
// 3) Viewer poll loop
// ---------------------------------------------------------------------------

async function pollViewers(): Promise<void> {
  const info = await fetchChannelInfo();
  if (!info) return;
  state.lastViewers = info.viewer_count;
  broadcast({ event_name: "viewerCountUpdatedEvent", data: { viewer_count: info.viewer_count } });
}

// ---------------------------------------------------------------------------
// 4) Client fan-out server (raw WebSocket behind the panel gateway)
// ---------------------------------------------------------------------------

const httpServer = http.createServer((req, res) => {
  if (req.url?.startsWith("/health")) {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "kick-bridge",
        port: PORT,
        channel: CHANNEL,
        upstream: state.upstream,
        chatroomId: state.chatroomId,
        viewers: state.lastViewers,
        lastChatAt: state.lastChatAt,
        lastError: state.lastError,
        clients: clients.size,
      }),
    );
    return;
  }
  // Widget pages upgrade at /?XTransformPort=3010 — anything else gets a hint.
  res.writeHead(426, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "WebSocket upgrade required" }));
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (socket, req) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const ch = (url.searchParams.get("ch") || CHANNEL).toLowerCase();
  if (ch !== CHANNEL) {
    // Strangers cannot steer this bridge to another channel — honest refusal.
    socket.send(
      JSON.stringify({
        event_name: "bridgeStatusEvent",
        data: { state: "refused", channel: CHANNEL, reason: `this bridge serves channel "${CHANNEL}" only` },
      }),
    );
    socket.close(4003, "channel not served");
    return;
  }
  clients.add(socket);
  log(`widget client connected (${clients.size} total)`);
  // Immediate state snapshot so a freshly-refreshed OBS source paints fast.
  socket.send(
    JSON.stringify({
      event_name: "bridgeStatusEvent",
      data: {
        state: state.upstream,
        channel: CHANNEL,
        chatroomId: state.chatroomId,
        viewers: state.lastViewers,
        lastChatAt: state.lastChatAt,
        lastError: state.lastError,
      },
    }),
  );
  if (state.lastViewers > 0) {
    socket.send(
      JSON.stringify({ event_name: "viewerCountUpdatedEvent", data: { viewer_count: state.lastViewers } }),
    );
  }
  socket.on("close", () => {
    clients.delete(socket);
    log(`widget client gone (${clients.size} total)`);
  });
});

setInterval(() => {
  broadcast({
    event_name: "bridgeStatusEvent",
    data: {
      state: state.upstream,
      channel: CHANNEL,
      chatroomId: state.chatroomId,
      viewers: state.lastViewers,
      lastChatAt: state.lastChatAt,
      lastError: state.lastError,
    },
  });
}, STATUS_BEAT_MS);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

httpServer.listen(PORT, () => log(`listening on :${PORT} (raw ws at /?XTransformPort=${PORT})`));

const boot = async () => {
  const info = await fetchChannelInfo();
  if (!info) {
    log("channel resolve failed — viewer poll will keep retrying");
  } else {
    channelState.channel_id = info.channel_id;
    state.lastViewers = info.viewer_count;
    log(
      `resolved ${CHANNEL}: channel=${info.channel_id} chatroom=${info.chatroom_id} live=${info.is_live} viewers=${info.viewer_count}`,
    );
    void connectUpstream();
  }
  setInterval(() => {
    void pollViewers().then(() => {
      if (!upstream && !connecting && state.chatroomId && channelState.channel_id) {
        void connectUpstream();
      }
    });
  }, VIEWER_POLL_MS);
  void pollViewers();
};
void boot();
