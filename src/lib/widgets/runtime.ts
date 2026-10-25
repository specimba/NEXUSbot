/**
 * NEXUS OS — self-hosted widget runtime (Kickbot-builder contract parity).
 *
 * WHY THIS EXISTS (owner directive): the Kickbot widget builder holds the
 * owner's widget ("Specimba Cyber AI Counter") hostage to their platform. The
 * widget system here runs the SAME contract on OUR stack, local-first:
 *
 *   1. `userVariables` global  — { name: { label, value } } injected before
 *      the widget JS runs (Kickbot builder injects the identical shape).
 *   2. `widgetEvent` DOM event — Kick-shaped events dispatched on `document`;
 *      widgets subscribe via document.addEventListener("widgetEvent", …).
 *      Names used by the Cyber AI Counter: chatMessageEvent,
 *      viewerCountUpdatedEvent, streamOnline.
 *   3. Kickbot-injected helper functions — extractRawChatPayload,
 *      hasAiTrigger, stripAiTrigger, decodeKickEmotesInText, fetchWithTimeout.
 *      The owner's saved widget JS CALLS all five but the builder injects them
 *      at runtime (they are NOT in the saved file) — the shim below provides
 *      faithful implementations, which is what makes verbatim ports possible.
 *
 * The SAME document builder serves both surfaces:
 *   - panel preview  → iframe srcDoc (test events arrive via postMessage)
 *   - OBS bundle     → single-file download added as a Browser Source (local
 *     file:// — nothing is hosted, nothing leaves the sandbox; L0).
 *
 * Isomorphic by design: pure string functions, no node APIs, no "use client".
 */

export type WidgetVariableType = "text" | "number" | "boolean" | "color" | "password";

export type WidgetVariable = {
  name: string;
  label: string;
  type: WidgetVariableType;
  value: string;
  secret?: boolean;
};

export const WIDGET_VARIABLE_TYPES: WidgetVariableType[] = [
  "text",
  "number",
  "boolean",
  "color",
  "password",
];

export const VARIABLE_NAME_RE = /^[a-z_][a-z0-9_]{0,63}$/i;

export type WidgetDoc = {
  id?: string;
  name: string;
  width: number;
  height: number;
  html: string;
  css: string;
  js: string;
  variables: string; // JSON array of WidgetVariable
};

export const WIDGET_LIMITS = {
  name: { min: 1, max: 80 },
  size: { min: 40, max: 4096 },
  code: 300_000, // per field (html/css/js)
  variablesJson: 64_000,
  maxVariables: 64,
} as const;

/** Payload after validation — the shape both POST and PUT persist. */
export type ValidWidgetData = {
  name: string;
  width: number;
  height: number;
  html: string;
  css: string;
  js: string;
  variables: string;
};

/**
 * Shared validation for widget create/update — clamps sizes, validates the
 * variables JSON. Returns { error } with a human-readable reason on failure.
 * Lives here (not in a route module) because Next.js route files may only
 * export HTTP handlers.
 */
export function validateWidgetPayload(
  body: Record<string, unknown>,
): ValidWidgetData | { error: string } {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < WIDGET_LIMITS.name.min || name.length > WIDGET_LIMITS.name.max) {
    return { error: `name must be ${WIDGET_LIMITS.name.min}–${WIDGET_LIMITS.name.max} characters.` };
  }
  const clampSize = (v: unknown, fallback: number): number => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(WIDGET_LIMITS.size.max, Math.max(WIDGET_LIMITS.size.min, Math.round(n)));
  };
  const width = clampSize(body.width, 560);
  const height = clampSize(body.height, 260);

  const codeField = (v: unknown): string | null => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") return null;
    if (v.length > WIDGET_LIMITS.code) return null;
    return v;
  };
  const html = codeField(body.html);
  const css = codeField(body.css);
  const js = codeField(body.js);
  if (html === null || css === null || js === null) {
    return { error: `html/css/js must be strings up to ${WIDGET_LIMITS.code} characters each.` };
  }

  let variables = "[]";
  if (body.variables !== undefined) {
    if (typeof body.variables !== "string" || body.variables.length > WIDGET_LIMITS.variablesJson) {
      return { error: `variables must be a JSON string up to ${WIDGET_LIMITS.variablesJson} characters.` };
    }
    try {
      const parsed: unknown = JSON.parse(body.variables);
      if (!Array.isArray(parsed)) return { error: "variables must be a JSON array." };
      variables = serializeWidgetVariables(parsed as WidgetVariable[]);
    } catch {
      return { error: "variables must be valid JSON." };
    }
  }

  return { name, width, height, html, css, js, variables };
}

/** Parses + sanitizes the variables JSON column; invalid input → []. */
export function parseWidgetVariables(json: string): WidgetVariable[] {
  try {
    const parsed: unknown = JSON.parse(json || "[]");
    if (!Array.isArray(parsed)) return [];
    const out: WidgetVariable[] = [];
    for (const raw of parsed.slice(0, WIDGET_LIMITS.maxVariables)) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const name = typeof r.name === "string" ? r.name.trim() : "";
      if (!VARIABLE_NAME_RE.test(name)) continue;
      const type = WIDGET_VARIABLE_TYPES.includes(r.type as WidgetVariableType)
        ? (r.type as WidgetVariableType)
        : "text";
      out.push({
        name,
        label: typeof r.label === "string" ? r.label.slice(0, 80) : name,
        type,
        value: typeof r.value === "string" ? r.value.slice(0, 2000) : "",
        secret: r.secret === true,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function serializeWidgetVariables(vars: WidgetVariable[]): string {
  const clean = vars
    .filter((v) => VARIABLE_NAME_RE.test(v.name.trim()))
    .slice(0, WIDGET_LIMITS.maxVariables)
    .map((v) => ({
      name: v.name.trim(),
      label: v.label.slice(0, 80) || v.name.trim(),
      type: WIDGET_VARIABLE_TYPES.includes(v.type) ? v.type : "text",
      value: typeof v.value === "string" ? v.value.slice(0, 2000) : "",
      secret: v.secret === true,
    }));
  return JSON.stringify(clean);
}

/**
 * Prevents an embedded `</script>` / `</style>` sequence from terminating the
 * host tag early (the Cyber AI Counter engine contains innerHTML templates —
 * defensively escaped even though the current seed is clean).
 * Inside JS/JSON string literals `<\/` === `</`; inside regexes `\/` === `/`.
 */
function escapeForEmbed(code: string): string {
  return code.replace(/<\/(script|style)/gi, "<\\/$1");
}

/**
 * Coerces a variable's string value to its typed value for userVariables.
 * Kickbot delivers strings; the Cyber engine already handles both, but typed
 * values make OUR starter widgets clean.
 */
function coerceVariableValue(v: WidgetVariable): string | number | boolean {
  if (v.type === "number") {
    const n = Number(v.value);
    return Number.isFinite(n) ? n : v.value;
  }
  if (v.type === "boolean") return v.value === "true" || v.value === "1";
  return v.value;
}

/**
 * The runtime shim — injected as the FIRST script of every widget document
 * (before the widget's own JS). Provides the exact globals + helpers the
 * Kickbot runtime injects, plus the postMessage event bridge used by the
 * panel preview and (optionally, later) the KICK bot event feed.
 */
export function buildWidgetShim(variables: WidgetVariable[]): string {
  const userVars: Record<string, { label: string; value: string | number | boolean }> = {};
  for (const v of variables) userVars[v.name] = { label: v.label, value: coerceVariableValue(v) };

  return `
/* NEXUS OS widget runtime shim (Kickbot-builder contract parity) */
(function () {
  'use strict';
  if (window.__NEXUS_WIDGET_SHIM__) return;
  window.__NEXUS_WIDGET_SHIM__ = '1.0.0';

  // 1) userVariables — the exact shape Kickbot's builder injects.
  var __vars = ${escapeForEmbed(JSON.stringify(userVars))};
  window.userVariables = __vars;
  try { if (typeof userVariables === 'undefined') { window.userVariables = __vars; } } catch (e) {}

  // 2) globalValues — stream metadata slot (viewer telemetry mirrors write here).
  window.globalValues = window.globalValues || {};

  // 3) Kickbot-injected helper parity (the saved widget JS calls these but the
  //    builder injected them at runtime — faithful re-implementations below).
  window.extractRawChatPayload = function (data) {
    try {
      if (!data) return '';
      if (typeof data.content === 'string' && data.content.length) return data.content;
      if (typeof data.raw_message === 'string' && data.raw_message.length) return data.raw_message;
      if (typeof data.message === 'string' && data.message.length) return data.message;
      if (Array.isArray(data.message)) {
        return data.message.map(function (p) {
          if (typeof p === 'string') return p;
          if (p && typeof p === 'object') {
            if (typeof p.text === 'string') return p.text;
            if (p.name) return '[' + String(p.name) + ']';
          }
          return '';
        }).join('');
      }
      if (typeof data.comment === 'string') return data.comment;
    } catch (e) {}
    return '';
  };
  window.hasAiTrigger = function (text, trigger) {
    try {
      var t = String(trigger || '!ai').toLowerCase();
      return String(text || '').trim().toLowerCase().indexOf(t) === 0;
    } catch (e) { return false; }
  };
  window.stripAiTrigger = function (text, trigger) {
    try {
      var raw = String(text || '').trim();
      var t = String(trigger || '!ai');
      if (raw.toLowerCase().indexOf(t.toLowerCase()) === 0) return raw.slice(t.length).trim();
      return raw;
    } catch (e) { return ''; }
  };
  window.decodeKickEmotesInText = function (text /*, data */) {
    // Emote tags arrive as [emote:name] from extractRawChatPayload — pass text through.
    return String(text || '');
  };
  window.fetchWithTimeout = function (url, opts, ms) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, Number(ms) || 8000);
    try {
      return fetch(url, Object.assign({}, opts || {}, { signal: ctrl.signal })).finally(function () {
        clearTimeout(timer);
      });
    } catch (e) {
      clearTimeout(timer);
      return Promise.reject(e);
    }
  };

  // 3.5) Kickbot service parity — group 2. The saved widget JS ALSO references
  //     higher-level services the Kickbot builder injected at runtime; none of
  //     them are defined inside the widget JS, so without these every plain
  //     chat message (StreamConsciousness.record) and every !ai trigger
  //     (extractAndBanRejectedTopics, NexusCognitiveMemory, …) would throw a
  //     ReferenceError inside the event handler and the widget would look
  //     dead on stream. Faithful minimal implementations, in-memory with a
  //     bounded localStorage persistence where the browser allows it.
  window.StreamTelemetryState = {
    viewerCount: 0, peakViewerCount: 0, isLive: false,
    streamTitle: '', streamCategory: '', hasDirectKickLock: false,
    getStreamSummary: function () {
      try {
        var live = this.isLive ? 'LIVE' : 'OFFLINE';
        var v = this.viewerCount > 0 ? this.viewerCount + ' izleyici' : 'izleyici bilgisi yok';
        var t = this.streamTitle ? ' // ' + String(this.streamTitle).slice(0, 80) : '';
        var c = this.streamCategory ? ' // ' + String(this.streamCategory).slice(0, 40) : '';
        return 'Yayın durumu: ' + live + ' // ' + v + t + c;
      } catch (e) { return 'Yayın durumu: bilinmiyor'; }
    }
  };
  (function () {
    var TIMELINE_KEY = 'nexus_sc_timeline';
    var timeline = []; // {user, text, at}
    try { var raw = window.localStorage.getItem(TIMELINE_KEY); if (raw) timeline = JSON.parse(raw).slice(-200); } catch (e) {}
    function persist() { try { window.localStorage.setItem(TIMELINE_KEY, JSON.stringify(timeline.slice(-200))); } catch (e) {} }
    window.StreamConsciousness = {
      record: function (username, text, data) {
        try {
          timeline.push({ user: String(username || '?'), text: String(text || '').slice(0, 400), at: new Date().toISOString() });
          if (timeline.length > 200) timeline = timeline.slice(-200);
          persist();
        } catch (e) {}
      },
      getSpeakerMonologueSummary: function (username, count) {
        try {
          var mine = timeline.filter(function (m) { return m.user && m.user.toLowerCase() === String(username || '').toLowerCase(); });
          if (!mine.length) return '';
          return mine.slice(-(Number(count) || 6)).map(function (m) { return m.text; }).join(' | ');
        } catch (e) { return ''; }
      },
      getStructuredRoomTranscript: function (sender) {
        try {
          var recent = timeline.slice(-25);
          return recent.map(function (m) {
            return (m.user && String(m.user).toLowerCase() === String(sender || '').toLowerCase() ? '[SEN] ' : '') + m.user + ': ' + m.text;
          }).join('\\n');
        } catch (e) { return ''; }
      },
      purgeTopicFromTimeline: function (topics) {
        try {
          var list = (Array.isArray(topics) ? topics : [topics]).map(function (t) { return String(t || '').toLowerCase(); }).filter(Boolean);
          if (!list.length) return;
          timeline = timeline.filter(function (m) {
            var low = ' ' + m.text.toLowerCase() + ' ';
            return !list.some(function (t) { return low.indexOf(' ' + t) !== -1 || low.indexOf(t) !== -1; });
          });
          persist();
        } catch (e) {}
      }
    };
  })();
  (function () {
    var MEM_KEY = 'nexus_cog_memory';
    // Shape the widget expects from load(): { dossiers: { lowerSender: profile } }.
    // The Kickbot builder persisted per-chatter profiles; this is the faithful
    // local re-implementation (bounded, localStorage-backed where allowed).
    var store = { dossiers: {} };
    try { var raw = window.localStorage.getItem(MEM_KEY); if (raw) { var j = JSON.parse(raw); if (j && typeof j === 'object') store = { dossiers: j.dossiers && typeof j.dossiers === 'object' ? j.dossiers : {} }; } } catch (e) {}
    function persist() { try { window.localStorage.setItem(MEM_KEY, JSON.stringify(store)); } catch (e) {} }
    var keys = Object.keys(store.dossiers);
    if (keys.length > 400) { keys.sort(function (a, b) { return (store.dossiers[a].lastSeenTs || 0) - (store.dossiers[b].lastSeenTs || 0); }).slice(0, keys.length - 400).forEach(function (k) { delete store.dossiers[k]; }); }
    function profileFor(sender) {
      var lower = String(sender || '?').toLowerCase();
      var p = store.dossiers[lower];
      if (!p) { p = store.dossiers[lower] = { handle: String(sender || '?'), role: 'izleyici', totalInteractions: 0, lastPrompt: '', lastSeenTs: 0 }; }
      return p;
    }
    window.NexusCognitiveMemory = {
      load: function () { return store; },
      recordInteraction: function (sender, prompt) {
        try {
          var p = profileFor(sender);
          p.totalInteractions = (Number(p.totalInteractions) || 0) + 1;
          p.lastPrompt = String(prompt || '').slice(0, 400);
          p.lastSeenTs = Date.now();
          persist();
          return p;
        } catch (e) { return profileFor(sender); }
      },
      appendDialogueTurn: function (sender, prompt, reply) {
        try {
          var p = profileFor(sender);
          p.lastPrompt = String(prompt || '').slice(0, 400);
          p.lastReply = String(reply || '').slice(0, 1200);
          p.lastSeenTs = Date.now();
          persist();
        } catch (e) {}
      },
      getRecentDialogueMessagesForSender: function (sender, prompt, maxTurns) {
        // OpenAI-style message objects — the widget SPREADS this array into
        // the messages ladder, so strings here would corrupt the request.
        try {
          var p = store.dossiers[String(sender || '').toLowerCase()];
          if (!p || !p.lastPrompt) return [];
          var n = Math.max(1, Number(maxTurns) || 1);
          var out = [{ role: 'user', content: String(p.lastPrompt).slice(0, 400) }];
          if (p.lastReply) out.push({ role: 'assistant', content: String(p.lastReply).slice(0, 1200) });
          return out.slice(-n * 2);
        } catch (e) { return []; }
      },
      wipeActiveTopicMemory: function (topics) {
        try {
          var list = (Array.isArray(topics) ? topics : [topics]).map(function (t) { return String(t || '').toLowerCase(); }).filter(Boolean);
          if (!list.length) return;
          for (var k of Object.keys(store.dossiers)) {
            var p = store.dossiers[k];
            var low = (' ' + String(p.lastPrompt || '') + ' ' + String(p.lastReply || '') + ' ').toLowerCase();
            if (list.some(function (t) { return low.indexOf(t) !== -1; })) delete store.dossiers[k];
          }
          persist();
        } catch (e) {}
      }
    };
  })();
  // IntelligenceCache / StickyResearchContext — builder-injected research
  // stores; only their wipe/clear methods are reachable from the saved JS.
  window.IntelligenceCache = {
    clearAll: function () {},
    get: function () { return null; },
    set: function () {}
  };
  window.StickyResearchContext = {
    wipeResearchMemory: function () {},
    get: function () { return null; },
    set: function () {}
  };
  // detectLanguage(text) — the TTS voice picker (Filiz for tr, Joanna else).
  window.detectLanguage = function (text) {
    try {
      var t = String(text || '');
      if (/[çğıöşüÇĞİÖŞÜ]/.test(t)) return 'tr';
      if (/\b(bir|nedir|kimdir|nasıl|için|ama|çok|değil|var mı|yok)\b/i.test(t)) return 'tr';
      return 'en';
    } catch (e) { return 'en'; }
  };
  // The builder's web-intel functions had REAL implementations behind them
  // (music lookups, DDG instant answers, weather, knowledge graph). Minimal
  // HONEST versions: resolve with "no data" shapes so the JEV router degrades
  // gracefully to the plain LLM ladder instead of throwing. Real research can
  // be wired later through our own backend.
  window.lookupMusicOrArtist = function (q) { return Promise.resolve(null); };
  window.universalLiveWebSearch = function (q) { return Promise.resolve(null); };
  window.fetchDuckDuckGoInstantAnswer = function (q) { return Promise.resolve(''); };
  window.lookupKnowledgeGraph = function (q) { return null; };
  window.unfurlLinksInPrompt = function (raw) { return Promise.resolve({ text: '', imageUrl: '' }); };
  window.fetchLiveWeather = function (q) { return Promise.resolve(null); };
  window.expandFollowUpQuery = function (raw, profile) {
    try {
      var prior = profile && profile.lastPrompt;
      if (prior && String(raw || '').length < 24 && /(o|bu|onun|hangisi|devam|neyse)/i.test(String(raw || ''))) {
        return String(prior).slice(0, 200) + ' — ' + String(raw || '');
      }
    } catch (e) {}
    return String(raw || '');
  };
  window.extractCleanEntitySearchQuery = function (q) { return String(q || '').trim(); };
  // extractAndBanRejectedTopics(text, sender) — the builder's poison-topic
  // detector. The poison regex itself is declared by the WIDGET script
  // (top-level const → global lexical binding, visible to later callers), so
  // this resolves lazily at call time, AFTER the widget JS has loaded.
  window.extractAndBanRejectedTopics = function (text, sender) {
    try {
      var re = typeof POISON_MEMORY_REGEX !== 'undefined' ? POISON_MEMORY_REGEX : null;
      if (!re) return [];
      var m = re.exec(String(text || ''));
      if (!m) return [];
      var topic = String(m[0]).toLowerCase().trim().split(/\\s+/).slice(0, 3).join(' ');
      return topic ? [topic] : [];
    } catch (e) { return []; }
  };
  // getLiveTurkishDateTime() — Kickbot's Turkish wall clock (Istanbul).
  window.getLiveTurkishDateTime = function () {
    try {
      var d = new Date();
      var days = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
      var months = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
      var utc = d.getTime() + d.getTimezoneOffset() * 60000;
      var ist = new Date(utc + 3 * 3600000); // Europe/Istanbul = UTC+3 (no DST)
      var hh = String(ist.getHours()).padStart(2, '0');
      var mm = String(ist.getMinutes()).padStart(2, '0');
      return ist.getDate() + ' ' + months[ist.getMonth()] + ' ' + ist.getFullYear() + ', ' + days[ist.getDay()] + ' ' + hh + ':' + mm + ' (TSİ)';
    } catch (e) {
      return new Date().toISOString().slice(0, 16).replace('T', ' ');
    }
  };

  // 4) Event bridge — postMessage({ type:'nexus-widget-event', event:{…} })
  //    → document.dispatchEvent(new CustomEvent('widgetEvent', { detail })).
  //    The panel preview uses it for test events; the future KICK bot feed
  //    uses the same channel. OBS simply never receives messages (harmless).
  window.addEventListener('message', function (ev) {
    try {
      var d = ev && ev.data;
      if (!d || d.type !== 'nexus-widget-event' || !d.event) return;
      document.dispatchEvent(new CustomEvent('widgetEvent', { detail: d.event }));
    } catch (e) {}
  });

  // 5) Optional poll feed: when the variable nexus_event_poll_url is set, the
  //    shim polls it every 2s and dispatches each {event_name,data} item.
  //    (Wired by the KICK bot integration; empty by default → no polling.)
  try {
    var pollUrl = String((__vars.nexus_event_poll_url && __vars.nexus_event_poll_url.value) || '');
    if (pollUrl) {
      setInterval(function () {
        try {
          fetch(pollUrl, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
            if (!j || !Array.isArray(j.events)) return;
            for (var i = 0; i < j.events.length; i++) {
              document.dispatchEvent(new CustomEvent('widgetEvent', { detail: j.events[i] }));
            }
          }).catch(function () {});
        } catch (e) {}
      }, 2000);
    }
  } catch (e) {}

  // 6) LIVE KICK FEED — the kick-bridge mini service (port 3010) relays the
  //    channel's public chat + viewer count over a raw WebSocket. The
  //    connector activates ONLY when the document is served from a real
  //    http(s) host (the OBS stream URL): the panel preview iframe (srcdoc →
  //    no location.host) and the file:// bundle stay on their existing
  //    channels and never hit the network.
  try {
    var __liveProto = window.location.protocol;
    if (window.location.host && (__liveProto === 'http:' || __liveProto === 'https:')) {
      var __ch = 'specimba';
      try {
        if (__vars.streamer_name && __vars.streamer_name.value) __ch = String(__vars.streamer_name.value);
      } catch (e) {}
      __ch = encodeURIComponent(String(__ch).trim().toLowerCase() || 'specimba');
      var __feedUrl = (__liveProto === 'https:' ? 'wss://' : 'ws://') + window.location.host +
        '/?XTransformPort=3010&ch=' + __ch;
      var __feedTries = 0;
      var __feedTimer = null;
      var __feedOpen = function () {
        try {
          var fx = new WebSocket(__feedUrl);
          fx.onopen = function () { __feedTries = 0; };
          fx.onmessage = function (m) {
            try {
              var ev = JSON.parse(m.data);
              if (ev && ev.event_name) {
                document.dispatchEvent(new CustomEvent('widgetEvent', { detail: ev }));
              }
            } catch (e) {}
          };
          fx.onclose = function () {
            // exponential backoff + jitter; OBS refresh also reconnects instantly
            var delay = Math.min(30000, 1000 * Math.pow(2, Math.max(0, __feedTries++)) + Math.floor(Math.random() * 500));
            if (__feedTimer) clearTimeout(__feedTimer);
            __feedTimer = setTimeout(__feedOpen, delay);
          };
          fx.onerror = function () { try { fx.close(); } catch (e) {} };
        } catch (e) {}
      };
      __feedOpen();
    }
  } catch (e) {}
})();
`.trim();
}

/** Minimal starter widget a "New widget" button can prefill. */
export const STARTER_WIDGET = {
  html: `<div class="nx-card" id="nx-root">
  <div class="nx-row">
    <span class="nx-dot"></span>
    <span class="nx-title" id="nx-label">WIDGET</span>
    <span class="nx-count" id="nx-count">0</span>
  </div>
  <div class="nx-msg" id="nx-msg">Waiting for events…</div>
</div>`,
  css: `:root { --nx-accent: #53fc18; --nx-bg: rgba(5, 8, 12, 0.92); }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; overflow: hidden; background: transparent;
  font-family: 'Segoe UI', system-ui, sans-serif; display: flex; align-items: flex-start; }
.nx-card { width: 100%; background: var(--nx-bg); border: 1px solid rgba(83, 252, 24, 0.3);
  border-radius: 6px; padding: 10px 12px; color: #f1f5f9; backdrop-filter: blur(8px); }
.nx-row { display: flex; align-items: center; gap: 8px; }
.nx-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--nx-accent);
  box-shadow: 0 0 8px var(--nx-accent); }
.nx-title { font-size: 12px; font-weight: 800; letter-spacing: 1px; color: var(--nx-accent); }
.nx-count { margin-left: auto; font-family: Consolas, monospace; font-size: 20px; font-weight: 900; }
.nx-msg { margin-top: 6px; font-size: 12.5px; line-height: 1.4; opacity: 0.9; min-height: 18px; }`,
  js: `// Starter widget: shows label/counter variables and reacts to chat + viewer events.
(function () {
  function val(name, fallback) {
    try {
      if (typeof userVariables !== 'undefined' && userVariables[name]) return userVariables[name].value;
    } catch (e) {}
    return fallback;
  }
  var labelEl = document.getElementById('nx-label');
  var countEl = document.getElementById('nx-count');
  var msgEl = document.getElementById('nx-msg');
  if (labelEl) labelEl.textContent = String(val('label', 'WIDGET')).toUpperCase();
  function setCount(n) { if (countEl && Number.isFinite(n)) countEl.textContent = n.toLocaleString(); }
  document.addEventListener('widgetEvent', function (ev) {
    var d = (ev && ev.detail) || {};
    if (d.event_name === 'chatMessageEvent' && d.data && msgEl) {
      var user = (d.data.sender && d.data.sender.username) || 'anon';
      var text = extractRawChatPayload(d.data) || '';
      msgEl.textContent = '@' + user + ': ' + text.slice(0, 140);
    } else if (d.event_name === 'viewerCountUpdatedEvent') {
      setCount(typeof d.data === 'number' ? d.data : Number(d.data && d.data.viewer_count));
    }
  });
})();`,
  variables: [
    { name: "label", label: "Header label", type: "text", value: "WIDGET" },
    { name: "accent_color", label: "Accent color", type: "color", value: "#53fc18" },
  ] satisfies WidgetVariable[],
};

export type BuiltWidgetDocOptions = {
  /** Bundle mode adds the OBS usage comment header. */
  bundle?: boolean;
};

/**
 * Builds the complete standalone HTML document for a widget — used BOTH for
 * the panel preview iframe (srcDoc) and the OBS bundle download.
 */
export function buildWidgetDocument(widget: WidgetDoc, opts: BuiltWidgetDocOptions = {}): string {
  const variables = parseWidgetVariables(widget.variables);
  const shim = buildWidgetShim(variables);
  const width = Math.min(WIDGET_LIMITS.size.max, Math.max(WIDGET_LIMITS.size.min, widget.width));
  const height = Math.min(WIDGET_LIMITS.size.max, Math.max(WIDGET_LIMITS.size.min, widget.height));

  const header = opts.bundle
    ? `<!--
  NEXUS OS widget bundle — ${escapeHtmlComment(widget.name)} (${width}x${height})

  OBS usage: Sources → + → Browser → check "Local file" → select this file.
  Set Width ${width} / Height ${height}. The widget is fully self-contained
  (variables are baked in at export time) and talks to the same runtime
  contract as the panel preview. Re-export from the panel after changing
  variables or code.
-->
`
    : "";

  return `${header}<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtmlText(widget.name)}</title>
<style>
html, body { margin: 0; padding: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: transparent; }
</style>
<style>
${widget.css}
</style>
</head>
<body>
${widget.html}
<script>
${shim}
</script>
<script>
${escapeForEmbed(widget.js)}
</script>
</body>
</html>`;
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeHtmlComment(s: string): string {
  return s.replace(/--+/g, "-").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Test events (panel preview → iframe postMessage)
// ---------------------------------------------------------------------------

export type WidgetTestEvent = { event_name: string; data: unknown };

/** Kick-shaped chat message event — matches what handleWidgetEvent expects. */
export function makeChatMessageEvent(username: string, text: string): WidgetTestEvent {
  return {
    event_name: "chatMessageEvent",
    data: {
      id: `test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      created_at: new Date().toISOString(),
      sender: { id: 0, username, slug: username, identity: { color: "#53fc18" } },
      content: text,
      type: "message",
    },
  };
}

export function makeViewerCountEvent(count: number): WidgetTestEvent {
  return { event_name: "viewerCountUpdatedEvent", data: { viewer_count: count } };
}
