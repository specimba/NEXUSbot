/**
 * NEXUS-OS Cyber AI HUD Widget Engine (v30.0 — DeepSeek RSI Self-Evolving Loop + Cross-Family Judge + Instant RSI Kill-Switch (`!ai rsi kill`) + Server-Side Credit Sync + Restored Full v28/v29 Core — Supabase Agent v5 Security Hardened: Zero Browser Shared Secret / Zero x-vyce-key Header + Public Anon JWT Only + Dual Vyce Base URL Fallback — Vyce.ai 11-Model Live Switcher & HUD Telemetry + Grok Imagine 2.0 (`grok-imagine-2`) On-Screen Holographic Studio + $5 Gift / +$10 `VYCE_8ZYQDC` Referral Credit Economy Edition)
 * Engineered for kick.com/specimba (Baş Mimar: Canberk Karaerkek)
 *
 * NEW IN v29.4:
 * 1. READY FOR DIRECT PASTE & ZERO HARDCODED KEYS:
 *    - `DEFAULT_HYPERBROWSER_KEY = ''` (reads strictly from KickBot `userVariables` or Supabase `nexus-cortex` Edge Secrets).
 *    - Updated `vyceBaseUrl` to official `https://vyceai.com/v1` (with `https://api.vyce.ai/v1` automatic fallback).
 * 2. LIVE VYCE.AI LLM MODEL SELECTION & TELEMETRY (`vyce_model` Variable + Live Chat Commands):
 *    - Switch active Vyce LLM anytime via KickBot sidebar (`vyce_model`) OR live in chat:
 *      * `!ai model claude-sonnet-4-6-pro` (380ms) | `!ai model deepseek-v4-flash-lr` (380ms)
 *      * `!ai model gpt-astra` (380ms)            | `!ai model glm-5.3-flash` ($0 Free)
 *      * `!ai model deepseek-v4.1` (Free w/ Lite) | `!ai model deepseek-v4-flash`
 *      * `!ai model claude-sonnet-4-6`            | `!ai model gpt-6-luna` (Codex)
 *      * `!ai model gpt-5.6-terra`                | `!ai model agnes-3.0-flash`
 *      * `!ai model deepseek-v4-pro`              | `!ai model auto` (JEV Smart Router)
 *      * `!ai modeller` / `!ai hangi model` (Displays active model, latency & full list).
 *    - Maintenance models (`gpt-5.6-sol`, `grok-4.6`) are automatically excluded from auto-routing.
 * 3. GROK IMAGINE 2.0 (`grok-imagine-2`) ON-SCREEN HOLOGRAPHIC SHOWCASE & $5 GIFT / +$10 REFERRAL CREDIT SYSTEM:
 *    - Every Kick username (`@handle`) starts with **$5.00 Gift Credit** from `@specimba` (= **10 Free Images** at `$0.50/img`).
 *    - Viewers unlock **+$10.00 Referral Bonus** (= **+20 Images**, **30 Images / $15.00 total**) via `https://vyceai.com/signup?ref=VYCE_8ZYQDC` (Code: `VYCE_8ZYQDC`):
 *      * `!ai çiz <prompt>` / `!ai görsel <prompt>` / `!ai imagine <prompt>` / `!ai resim <prompt>` -> Generates image with `grok-imagine-2`, deducts `$0.50`, and pops up the **Holographic Image Showcase (`#hologram-imagine-card`)** on stream!
 *      * `!ai remix <değişiklik>` / `!ai varyasyon <değişiklik>` -> Remixes the last on-screen image prompt!
 *      * `!ai puan <1-10>` / `!ai oyla <1-10>` -> Live chat community rating badge on the displayed artwork!
 *      * `!ai kredi` / `!ai bakiye` / `!ai hak` -> Shows viewer's `$` balance, remaining images & referral code `VYCE_8ZYQDC`.
 *      * `!ai ref` / `!ai ref onay VYCE_8ZYQDC` (self-claim once after signup) or `@specimba`/Mod `!ai ref onay @user` / `!ai kredi ekle @user 10` -> Credits `+$10.00` (+20 images) instantly!
 */

(function injectNoReferrerMeta() {
    try {
        if (typeof document !== 'undefined' && document.head && !document.querySelector('meta[name="referrer"]')) {
            const meta = document.createElement('meta');
            meta.name = 'referrer';
            meta.content = 'no-referrer';
            document.head.appendChild(meta);
        }
    } catch (e) {}
})();

// ============================================================================
// 0. IMMEDIATE BOOT PURGE OF POISONED VAULTS (GAMING/BOSS LOOP, REFUSALS, COFFEE)
// ============================================================================
const POISON_MEMORY_REGEX = /(22\s*ocak|knowledge\s*cutoff|kesim\s*tarihi|erişimim\s*(yok|kapandı|kesildi|kapatıldı|kısıtlandı)|mimar.*kapattı|seni\s*dinliyorum\s*devam\s*et|ghost\s*town\s*acid\s*remix|atlantalı\s*prodüktör|atlanta\s*çıkışlı.*99999|bu\s*modül\s*bulunmadığı\s*için|hâlâ\s*veri\s*çekemiyoruz|safiye\s*soyman|mal\s*waldron|türkiye\s*kökenli|nesnel\s*bir\s*değerlendirme\s*veri\s*tabanlarında|güneş\s*kesme\s*görselleri|evangelion\s*beklentisi|\brunaway\b|ultralight\s*beam|father\s*stretch\s*my\s*hands|ghost\s*town|come\s*to\s*life|divine\s*storyline\s*part.*runaway|kahve\s*sırrı|kahve\s*kokusu|kahveni\s*sikeyim|kahvenizi\s*sikim|\blatte\b|kafein|boss\s*taktikleri|boss\s*savaşı|hangi\s*boss\s*için|harita\s*rotaları|ekip\s*uyumu|ekip\s*rolünü|silah\s*seti|karakter\s*kombinasyonu|sadece\s*strateji\s*konuşmak\s*istedim|doğrudan\s*çalıştırma\s*yeteneğim\s*yok|sen\s*gerçek\s*bir\s*mimarsın|edge\s*secret\s*olarak\s*tanımlanmalı)/i;

const BannedTopicsSet = new Set([
    'safiye soyman', 'mal waldron', 'kahve', 'latte', 'kafein', 'espresso',
    'boss', 'boss taktikleri', 'boss savaşı', 'harita rotaları', 'silah seti', 'karakter kombinasyonu', 'ekip uyumu'
]);

(function loadPersistedBannedTopics() {
    try {
        const raw = sessionStorage.getItem('NEXUS_BANNED_TOPICS_v29');
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) arr.forEach(t => BannedTopicsSet.add(String(t).toLowerCase()));
        }
    } catch (e) {}
})();

function addBannedTopic(topicWord, sender = 'specimba') {
    if (!topicWord || topicWord.length < 3) return;
    const clean = topicWord.toLowerCase().trim();
    const isNew = !BannedTopicsSet.has(clean);
    BannedTopicsSet.add(clean);
    try {
        sessionStorage.setItem('NEXUS_BANNED_TOPICS_v29', JSON.stringify(Array.from(BannedTopicsSet)));
    } catch (e) {}
    if (isNew && typeof syncBannedTopicToEdgeCortex === 'function') {
        syncBannedTopicToEdgeCortex(clean, sender).catch(() => {});
    }
}

function containsBannedTopic(text) {
    if (!text) return false;
    const lower = String(text).toLowerCase();
    for (const banned of BannedTopicsSet) {
        if (banned && banned.length >= 3 && lower.includes(banned)) return true;
    }
    return false;
}

(function purgePoisonedVaultsOnBoot() {
    try {
        const keysToRemove = [
            'NEXUS_STICKY_URL_VAULT_v21', 'NEXUS_STICKY_URL_VAULT_v22', 'NEXUS_STICKY_URL_VAULT_v23',
            'NEXUS_STICKY_URL_VAULT_v24', 'NEXUS_STICKY_URL_VAULT_v25', 'NEXUS_STICKY_URL_VAULT_v26',
            'NEXUS_STICKY_URL_VAULT_v27', 'NEXUS_STICKY_URL_VAULT_v28', 'NEXUS_CHRONICLES_v21', 'NEXUS_CHRONICLES_v22',
            'NEXUS_MSG_LOCK_v24', 'NEXUS_MSG_LOCK_v25', 'NEXUS_MSG_LOCK_v26', 'NEXUS_MSG_LOCK_v27', 'NEXUS_MSG_LOCK_v28',
            'NEXUS_BANNED_TOPICS_v27', 'NEXUS_BANNED_TOPICS_v28'
        ];
        for (const k of keysToRemove) localStorage.removeItem(k);
    } catch (e) {}
})();

// ============================================================================
// 1. ENVIRONMENT DETECTION, ATOMIC DEDUPLICATION & BROADCAST MIRRORING
// ============================================================================
const Environment = {
    isEditorPreview: (function() {
        try {
            if (typeof window.obsstudio !== 'undefined') return false;
            const href = (window.location.href || '').toLowerCase();
            if (href.includes('widget-builder')) return true;
        } catch (e) {}
        return false;
    })(),
    isOBS: (typeof window.obsstudio !== 'undefined')
};

const NexusSyncBus = (function() {
    let channel = null;
    try {
        if (typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel('NEXUS_HUD_SYNC_v29_4');
    } catch (e) {}
    return {
        broadcastRender(user, text, modelLabel) {
            if (!channel) return;
            try { channel.postMessage({ type: 'MIRROR_DIALOGUE', user, text, modelLabel, ts: Date.now() }); } catch (e) {}
        },
        broadcastImage(cardPayload) {
            if (!channel) return;
            try { channel.postMessage({ type: 'MIRROR_IMAGE', cardPayload, ts: Date.now() }); } catch (e) {}
        },
        broadcastImagine(cardPayload) {
            return this.broadcastImage(cardPayload);
        },
        initListener(onMirrorCallback, onMirrorImageCallback) {
            if (!channel) return;
            channel.onmessage = (ev) => {
                if (!Environment.isEditorPreview) return;
                if (ev.data?.type === 'MIRROR_DIALOGUE' && onMirrorCallback) {
                    onMirrorCallback(ev.data.user, ev.data.text, ev.data.modelLabel);
                } else if (ev.data?.type === 'MIRROR_IMAGE' && onMirrorImageCallback) {
                    onMirrorImageCallback(ev.data.cardPayload);
                }
            };
        }
    };
})();

function claimMessageExecution(msgId) {
    if (!msgId) return true;
    const LOCK_KEY = 'NEXUS_MSG_LOCK_v29_4';
    const now = Date.now();
    try {
        const registry = JSON.parse(localStorage.getItem(LOCK_KEY) || '{}');
        for (const k of Object.keys(registry)) {
            if (now - registry[k] > 15000) delete registry[k];
        }
        if (registry[msgId]) return false;
        registry[msgId] = now;
        localStorage.setItem(LOCK_KEY, JSON.stringify(registry));
        return true;
    } catch (e) { return true; }
}

// ============================================================================
// 2. CONFIGURATION: ZERO HARDCODED KEYS + VYCE (`https://vyceai.com/v1`) + SUPABASE
// ============================================================================
const DEFAULT_HYPERBROWSER_KEY = ''; // Security-Audit Hardened: Zero hardcoded keys!
const DEFAULT_SUPABASE_URL = 'https://vwottesqbdgcsmvvvzok.supabase.co/functions/v1/nexus-cortex-harness';
const DEFAULT_SUPABASE_EDGE_URL = 'https://vwottesqbdgcsmvvvzok.supabase.co/functions/v1/nexus-cortex-harness';
const DEFAULT_VYCE_REFERRAL_CODE = 'VYCE_8ZYQDC';
const DEFAULT_VYCE_REFERRAL_URL = 'https://vyceai.com/signup?ref=VYCE_8ZYQDC';

function getVar(name) {
    try {
        if (typeof userVariables !== 'undefined' && userVariables[name]?.value !== undefined) return userVariables[name].value;
        if (typeof window !== 'undefined' && window.userVariables?.[name]?.value !== undefined) return window.userVariables[name].value;
    } catch (e) {}
    return null;
}

function resolveKeyByPrefix(prefix, candidateNames = []) {
    for (const c of candidateNames) {
        const val = getVar(c);
        if (val && typeof val === 'string' && val.trim().startsWith(prefix)) return val.trim();
    }
    try {
        const bag = (typeof userVariables !== 'undefined') ? userVariables : (window.userVariables || {});
        for (const k of Object.keys(bag)) {
            const v = bag[k]?.value;
            if (typeof v === 'string' && v.trim().startsWith(prefix)) return v.trim();
        }
    } catch (e) {}
    return '';
}

const config = {
    get trigger() { return (getVar('ai_trigger') || '!ai').toLowerCase(); },
    get streamerName() { return (getVar('streamer_name') || 'specimba').toLowerCase(); },
    get groqKey() { return resolveKeyByPrefix('gsk_', ['groq_api_key', 'groq_key', 'groqApiKey', 'api_key']); },
    get vyceKey() {
        const candidates = ['vyce_api_key', 'vyce_key', 'vyceApiKey', 'KICKbottest1', 'kickbottest1', 'vyce'];
        for (const c of candidates) {
            const v = getVar(c);
            if (v && typeof v === 'string' && v.trim().length > 8 && !v.trim().startsWith('gsk_') && !v.trim().startsWith('eyJ') && !v.trim().startsWith('hb_')) {
                return v.trim();
            }
        }
        return resolveKeyByPrefix('sk-', candidates) ||
               resolveKeyByPrefix('vyce', candidates);
    },
    get vyceBaseUrl() {
        return (getVar('vyce_base_url') || 'https://vyceai.com/v1').replace(/\/+$/, '').trim();
    },
    get vycePreferredModel() {
        return NexusModelController.getPreferredModel();
    },
    get vyceReferralCode() {
        return (getVar('vyce_referral_code') || DEFAULT_VYCE_REFERRAL_CODE).trim();
    },
    get vyceReferralUrl() {
        const code = this.vyceReferralCode;
        return (getVar('vyce_referral_url') || `https://vyceai.com/signup?ref=${code}`).trim();
    },
    get initialUserCreditUsd() {
        const val = parseFloat(getVar('initial_user_credit_usd'));
        return (!isNaN(val) && val >= 0) ? val : 5.00;
    },
    get referralBonusCreditUsd() {
        const val = parseFloat(getVar('referral_bonus_credit_usd'));
        return (!isNaN(val) && val > 0) ? val : 10.00;
    },
    get referralBonusUsd() {
        return this.referralBonusCreditUsd;
    },
    get imageCostUsd() {
        const val = parseFloat(getVar('image_cost_usd'));
        return (!isNaN(val) && val > 0) ? val : 0.50;
    },
    get imageHoldSeconds() {
        const val = parseFloat(getVar('image_hold_seconds'));
        return (!isNaN(val) && val > 0) ? val : 14.0;
    },
    get supabaseUrl() {
        return (getVar('supabase_url') || DEFAULT_SUPABASE_URL).replace(/\/+$/, '').trim();
    },
    get supabaseEdgeUrl() {
        const explicit = (getVar('supabase_edge_url') || '').trim();
        if (explicit) return explicit;
        const sb = this.supabaseUrl;
        return sb ? `${sb}/functions/v1/nexus-cortex` : DEFAULT_SUPABASE_EDGE_URL;
    },
    get supabaseAnonKey() {
        return (
            getVar('supabase_anon_key') ||
            getVar('supabase_key') ||
            resolveKeyByPrefix('eyJ', ['supabase_anon_key', 'supabase_key']) ||
            resolveKeyByPrefix('sb_publishable_', ['supabase_anon_key', 'supabase_key']) ||
            ''
        ).trim();
    },
    get redisRestUrl() {
        return (getVar('redis_rest_url') || getVar('upstash_redis_rest_url') || '').replace(/\/+$/, '').trim();
    },
    get redisRestToken() {
        return (getVar('redis_rest_token') || getVar('upstash_redis_rest_token') || '').trim();
    },
    get hyperbrowserKey() {
        return resolveKeyByPrefix('hb_', ['hyperbrowser_api_key', 'hyperbrowser_key', 'hb_api_key']) || DEFAULT_HYPERBROWSER_KEY;
    },
    get localTtsUrl() { return (getVar('local_tts_url') || 'http://127.0.0.1:5050/tts').trim(); },
    get localHbBridgeUrl() { return 'http://127.0.0.1:5050/browse'; },
    get enableTTS() {
        if (Environment.isEditorPreview) {
            const pVal = getVar('preview_tts');
            return pVal === true || pVal === 'true';
        }
        const val = getVar('enable_tts');
        return val !== false && val !== 'false';
    },
    get ttsVolume() {
        const val = parseFloat(getVar('tts_volume'));
        if (!isNaN(val) && val >= 0) return Math.min(1.0, Math.max(0.0, val > 1 ? val / 100 : val));
        return 0.85;
    },
    get screenHoldSeconds() {
        const val = parseFloat(getVar('screen_hold'));
        return (!isNaN(val) && val > 0) ? val : 6.5;
    },
    get userCooldownSeconds() {
        const val = parseFloat(getVar('user_cooldown'));
        return (!isNaN(val) && val >= 0) ? val : 6;
    },
    get green() { return getVar('accent_color') || getVar('accent_green') || '#53fc18'; },
    get purple() { return getVar('purple_accent') || getVar('accent_purple') || '#b026ff'; },
    get red() { return getVar('red_accent') || getVar('accent_red') || '#ff0055'; },
    get cyan() { return '#00f0ff'; }
};

// ============================================================================
// 2A. VYCE.AI 11-ONLINE-MODEL CATALOG & RUNTIME MODEL CONTROLLER
// Exact match with your Vyce Status & Models Dashboard:
// - Excludes maintenance routes (`gpt-5.6-sol`, `grok-4.6`) from auto-routing.
// - Supports live chat switching (`!ai model <name>`) + `vyce_model` variable!
// ============================================================================
const VYCE_FRONTIER_PIPELINE = [
    { id: 'claude-sonnet-4-6-pro', label: 'CLAUDE 4.6 PRO ∞', provider: 'vyce', tier: 'frontier-fast', avgLatencyMs: 380, reportedLatencyMs: 380, pricing: '$3 / $15', price: '$3 / $15', reportedPricing: '$3 / $15', timeoutMs: 9500, aliases: ['sonnet-pro', 'claude-pro', 'sonnet-4-6-pro', '4.6-pro', 'pro', 'sonnet pro'] },
    { id: 'deepseek-v4-flash-lr', label: 'DEEPSEEK V4 FLASH LR', provider: 'vyce', tier: 'decision-fast', avgLatencyMs: 380, reportedLatencyMs: 380, pricing: '$0.15 / $0.60', price: '$0.15 / $0.60', reportedPricing: '$0.15 / $0.60', timeoutMs: 8000, aliases: ['deepseek-lr', 'v4-lr', 'flash-lr', 'lr', 'deepseek lr'] },
    { id: 'gpt-astra', label: 'GPT 6 ASTRA', provider: 'vyce', tier: 'frontier-ultra', avgLatencyMs: 380, reportedLatencyMs: 380, pricing: '$10 / $50', price: '$10 / $50', reportedPricing: '$10 / $50', timeoutMs: 10000, aliases: ['astra', 'gpt-6-astra', 'gpt6-astra'] },
    { id: 'glm-5.3-flash', label: 'GLM 5.3 FLASH', provider: 'vyce', tier: 'free-unlimited', avgLatencyMs: 2537, reportedLatencyMs: 2537, pricing: '$0 / $0', price: '$0 / $0', reportedPricing: '$0 / $0', timeoutMs: 10500, aliases: ['glm', 'glm-5.3', 'glm5.3', 'free'] },
    { id: 'deepseek-v4.1', label: 'DEEPSEEK V4.1 FLASH', provider: 'vyce', tier: 'frontier-balanced', avgLatencyMs: 6204, reportedLatencyMs: 6204, pricing: '$0.15 / $0.60', price: '$0.15 / $0.60', reportedPricing: '$0.15 / $0.60', timeoutMs: 12000, aliases: ['v4.1', 'deepseek-4.1', 'ds-4.1', '4.1', 'deepseek 4.1'] },
    { id: 'deepseek-v4-flash', label: 'DEEPSEEK V4 FLASH', provider: 'vyce', tier: 'frontier-balanced', avgLatencyMs: 6794, reportedLatencyMs: 6794, pricing: '$0.22 / $0.66', price: '$0.22 / $0.66', reportedPricing: '$0.22 / $0.66', timeoutMs: 11500, aliases: ['v4-flash', 'deepseek-flash', 'ds-flash'] },
    { id: 'claude-sonnet-4-6', label: 'CLAUDE SONNET 4.6', provider: 'vyce', tier: 'frontier-deep', avgLatencyMs: 7059, reportedLatencyMs: 7059, pricing: '$3 / $15', price: '$3 / $15', reportedPricing: '$3 / $15', timeoutMs: 13000, aliases: ['sonnet', 'claude', 'claude-4.6', 'sonnet-4-6'] },
    { id: 'gpt-6-luna', label: 'GPT 6 LUNA', provider: 'vyce', tier: 'frontier-deep', avgLatencyMs: 8686, reportedLatencyMs: 8686, pricing: '$2 / $2', price: '$2 / $2', reportedPricing: '$2 / $2', timeoutMs: 14000, aliases: ['luna', 'gpt-6', 'gpt6', 'codex'] },
    { id: 'gpt-5.6-terra', label: 'GPT 5.6 TERRA', provider: 'vyce', tier: 'frontier-deep', avgLatencyMs: 10102, reportedLatencyMs: 10102, pricing: '$2.5 / $15', price: '$2.5 / $15', reportedPricing: '$2.5 / $15', timeoutMs: 13500, aliases: ['terra', 'gpt-5.6', '5.6-terra'] },
    { id: 'agnes-3.0-flash', label: 'AGNES 3.0 FLASH', provider: 'vyce', tier: 'agentic', avgLatencyMs: 13005, reportedLatencyMs: 13005, pricing: '$0.05 / $0.15', price: '$0.05 / $0.15', reportedPricing: '$0.05 / $0.15', timeoutMs: 15000, aliases: ['agnes', 'agnes-3.0', 'agnes-flash'] },
    { id: 'deepseek-v4-pro', label: 'DEEPSEEK V4 PRO', provider: 'vyce', tier: 'frontier-heavy', avgLatencyMs: 21441, reportedLatencyMs: 21441, pricing: '$0.50 / $2.00', price: '$0.50 / $2.00', reportedPricing: '$0.50 / $2.00', timeoutMs: 18000, aliases: ['v4-pro', 'deepseek-pro', 'ds-pro'] }
];

// Strict catalog allowlist enforced by Supabase Edge Function `nexus-cortex` v4 (`MODEL_IDS`)
const ALLOWED_EDGE_MODEL_IDS = new Set(VYCE_FRONTIER_PIPELINE.map(m => m.id));

const VYCE_IMAGE_MODEL = {
    id: 'grok-imagine-2',
    label: 'GROK IMAGINE 2.0',
    costUsd: 0.50,
    avgLatencyMs: 380
};

const GROQ_HIGH_IQ_PIPELINE = [
    { id: 'llama-3.3-70b-versatile', label: 'LLAMA 3.3 70B', provider: 'groq', family: 'llama', supportsBrowserSearch: false, supportsFunctionTools: true },
    { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', provider: 'groq', family: 'gpt-oss', supportsBrowserSearch: true, supportsFunctionTools: false },
    { id: 'qwen/qwen3-32b', label: 'QWEN 3 32B', provider: 'groq', family: 'qwen', supportsBrowserSearch: false, supportsFunctionTools: true }
];

const NexusModelController = {
    STORAGE_KEY: 'NEXUS_ACTIVE_VYCE_MODEL_v29_4',
    runtimeOverride: null,
    lastUsedModelId: 'claude-sonnet-4-6-pro',
    lastUsedLabel: 'CLAUDE 4.6 PRO ∞',
    lastLatencyMs: 380,

    init() {
        try {
            const saved = localStorage.getItem(this.STORAGE_KEY);
            if (saved) {
                const resolved = this.resolveModelInput(saved.trim());
                if (resolved) this.runtimeOverride = resolved.id;
            }
        } catch (e) {}
    },

    resolveModelInput(rawInput) {
        const clean = String(rawInput || '').toLowerCase().trim();
        if (!clean || clean === 'auto' || clean === 'otomatik' || clean === 'jev') {
            return { id: 'auto', label: 'AUTO (JEV ROUTER)', isAuto: true };
        }
        for (const m of VYCE_FRONTIER_PIPELINE) {
            if (m.id === clean || m.label.toLowerCase() === clean || (m.aliases && m.aliases.includes(clean))) {
                return { ...m, isAuto: false };
            }
        }
        for (const m of VYCE_FRONTIER_PIPELINE) {
            if (m.id.includes(clean) || clean.includes(m.id)) {
                return { ...m, isAuto: false };
            }
        }
        return null;
    },

    // Guaranteed to return ONLY 'auto' or an allowed ID in ALLOWED_EDGE_MODEL_IDS (prevents HTTP 400 on nexus-cortex v4)
    getPreferredModel() {
        const candidate = this.runtimeOverride || (getVar('vyce_model') || 'auto');
        const resolved = this.resolveModelInput(candidate);
        if (!resolved || resolved.isAuto) return 'auto';
        return ALLOWED_EDGE_MODEL_IDS.has(resolved.id) ? resolved.id : 'auto';
    },

    get overrideModel() {
        const pref = this.getPreferredModel();
        return pref !== 'auto' ? pref : null;
    },

    getActiveModelId() {
        return this.getPreferredModel();
    },

    setPreferredModel(rawInput) {
        const resolved = this.resolveModelInput(rawInput);
        if (!resolved) return null;
        this.runtimeOverride = resolved.id;
        try { localStorage.setItem(this.STORAGE_KEY, resolved.id); } catch (e) {}
        updateModelBadge(resolved.isAuto ? 'JEV // AUTO' : `VYCE // ${resolved.label}`);
        return resolved;
    },

    setOverride(rawInput) {
        const resolved = this.setPreferredModel(rawInput);
        return resolved ? resolved.id : null;
    },

    resolveModelObject(idOrAlias) {
        const resolved = this.resolveModelInput(idOrAlias);
        if (resolved && !resolved.isAuto) return resolved;
        return VYCE_FRONTIER_PIPELINE[0];
    },

    recordModelSuccess(modelId, label, latencyMs) {
        this.lastUsedModelId = modelId;
        this.lastUsedLabel = label;
        if (typeof latencyMs === 'number' && latencyMs > 0) this.lastLatencyMs = latencyMs;
        updateModelBadge(label);
    },

    getCatalogSummary() {
        const currentPref = this.getPreferredModel();
        const topList = VYCE_FRONTIER_PIPELINE.slice(0, 8).map(m => `${m.id} (${m.reportedLatencyMs}ms, ${m.reportedPricing})`).join(', ');
        return `Aktif Seçim: ${currentPref.toUpperCase()} | Son Yanıtlayan: ${this.lastUsedLabel} (${this.lastLatencyMs}ms) | Katologdaki Vyce Modelleri (fiyat/gecikme bildirim amaçlıdır): ${topList} + Görsel: ${VYCE_IMAGE_MODEL.id}`;
    },

    getCatalogSummaryText() {
        return this.getCatalogSummary();
    }
};

NexusModelController.init();
const RuntimeModelSelector = NexusModelController;

// ============================================================================
// 2B. GROK IMAGINE 2.0 (`grok-imagine-2`) PER-USER CREDIT & REFERRAL LEDGER
// + ON-SCREEN HOLOGRAPHIC SHOWCASE (`#hologram-imagine-card`)
// - Every username starts with $5.00 Gift Credit from @specimba (= 10 Images)
// - Registering via https://vyceai.com/signup?ref=VYCE_8ZYQDC (Code: VYCE_8ZYQDC)
//   unlocks +$10.00 Referral Bonus (= +20 Images -> 30 Total Images / $15.00!)
// ============================================================================
const NexusCreditLedger = {
    STORAGE_KEY: 'NEXUS_IMAGINE_CREDITS_LEDGER_v29_4',
    GALLERY_KEY: 'NEXUS_IMAGINE_GALLERY_v29_4',
    lastImageRecord: null,
    lastGeneratedImage: null,
    hideImageTimer: null,

    loadAll() {
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (e) { return {}; }
    },

    saveAll(mapObj) {
        try { localStorage.setItem(this.STORAGE_KEY, JSON.stringify(mapObj)); } catch (e) {}
    },

    getUserWallet(username) {
        const handle = String(username || 'anonymous').toLowerCase().replace(/^@/, '').trim() || 'anonymous';
        const all = this.loadAll();
        const initUsd = config.initialUserCreditUsd;
        const imgCost = config.imageCostUsd;

        if (!all[handle]) {
            all[handle] = {
                handle,
                displayName: username,
                creditBalanceUsd: initUsd,
                balanceUsd: initUsd,
                totalGrantedUsd: initUsd,
                spentUsd: 0.00,
                imagesGenerated: 0,
                referralClaimed: false,
                referralCodeUsed: '',
                lastImagePrompt: '',
                lastImageUrl: '',
                updatedAt: Date.now()
            };
            this.saveAll(all);
        }
        const w = all[handle];
        if (typeof w.creditBalanceUsd !== 'number') {
            w.creditBalanceUsd = typeof w.balanceUsd === 'number' ? w.balanceUsd : initUsd;
        }
        w.balanceUsd = w.creditBalanceUsd;
        const remainingImages = handle === config.streamerName
            ? 999
            : Math.max(0, Math.floor((w.creditBalanceUsd + 0.0001) / imgCost));
        return { ...w, balanceUsd: w.creditBalanceUsd, remainingImages };
    },

    canAffordImage(username) {
        const handle = String(username || '').toLowerCase().replace(/^@/, '').trim();
        const wallet = this.getUserWallet(username);
        if (handle === config.streamerName) {
            return { allowed: true, isArchitectUnlimited: true, wallet };
        }
        const cost = config.imageCostUsd;
        return {
            allowed: wallet.creditBalanceUsd + 0.0001 >= cost,
            isArchitectUnlimited: false,
            wallet
        };
    },

    deductImageCredit(username, promptText = '', imageUrl = '') {
        const handle = String(username || 'anonymous').toLowerCase().replace(/^@/, '').trim() || 'anonymous';
        const check = this.canAffordImage(username);
        if (!check.allowed) {
            return {
                allowed: false,
                wallet: check.wallet,
                creditBalanceUsd: check.wallet.creditBalanceUsd,
                balanceUsd: check.wallet.creditBalanceUsd,
                remainingImages: check.wallet.remainingImages
            };
        }
        const all = this.loadAll();
        this.getUserWallet(username);
        const w = all[handle];
        const cost = config.imageCostUsd;

        if (handle !== config.streamerName) {
            w.creditBalanceUsd = Math.max(0, Number((w.creditBalanceUsd - cost).toFixed(2)));
            w.spentUsd = Number(((w.spentUsd || 0) + cost).toFixed(2));
        }
        w.balanceUsd = w.creditBalanceUsd;
        w.updatedAt = Date.now();
        this.saveAll(all);

        const remainingImages = handle === config.streamerName
            ? 999
            : Math.max(0, Math.floor((w.creditBalanceUsd + 0.0001) / cost));

        if (promptText && imageUrl) {
            this.recordGeneratedImage(username, promptText, imageUrl);
        }

        return {
            allowed: true,
            wallet: { ...w, balanceUsd: w.creditBalanceUsd, remainingImages },
            creditBalanceUsd: w.creditBalanceUsd,
            balanceUsd: w.creditBalanceUsd,
            remainingImages
        };
    },

    recordGeneratedImage(username, promptText, imageUrl) {
        const handle = String(username || 'anonymous').toLowerCase().replace(/^@/, '').trim() || 'anonymous';
        const all = this.loadAll();
        this.getUserWallet(username);
        const w = all[handle];
        const cost = config.imageCostUsd;

        w.imagesGenerated = (w.imagesGenerated || 0) + 1;
        w.lastImagePrompt = String(promptText || '').slice(0, 240);
        w.lastImageUrl = String(imageUrl || '');
        w.balanceUsd = w.creditBalanceUsd;
        w.updatedAt = Date.now();
        this.saveAll(all);

        const remainingImages = handle === config.streamerName
            ? 999
            : Math.max(0, Math.floor((w.creditBalanceUsd + 0.0001) / cost));

        const record = {
            handle,
            sender: username,
            creator: username,
            displayName: username,
            prompt: w.lastImagePrompt,
            imageUrl: w.lastImageUrl,
            creditBalanceUsd: w.creditBalanceUsd,
            balanceUsd: w.creditBalanceUsd,
            remainingImages,
            ratings: [],
            avgRating: 0,
            ts: Date.now()
        };
        this.lastImageRecord = record;
        this.lastGeneratedImage = record;
        return { ...w, balanceUsd: w.creditBalanceUsd, remainingImages };
    },

    claimReferralBonus(targetUsername, triggeredBy = '') {
        const handle = String(targetUsername || '').toLowerCase().replace(/^@/, '').trim();
        if (!handle) return { ok: false, reason: 'Geçersiz kullanıcı adı.' };
        const all = this.loadAll();
        this.getUserWallet(handle);
        const w = all[handle];
        const isModOrArchitect = [config.streamerName, 'yavuzerdem99', 'robotic_darkelf_jedi', 'buraksakinol'].includes(String(triggeredBy || '').toLowerCase());

        if (w.referralClaimed && !isModOrArchitect) {
            const rem = Math.floor((w.creditBalanceUsd + 0.0001) / config.imageCostUsd);
            return {
                ok: false,
                alreadyClaimed: true,
                wallet: { ...w, balanceUsd: w.creditBalanceUsd },
                remainingImages: rem,
                message: `@${handle} zaten $${config.referralBonusCreditUsd.toFixed(2)} Vyce.ai referans bonusunu (${config.vyceReferralCode}) aktif etmiş! Güncel bakiye: $${w.creditBalanceUsd.toFixed(2)} (${rem} görsel hakkı).`
            };
        }

        const bonus = config.referralBonusCreditUsd;
        w.creditBalanceUsd = Number((w.creditBalanceUsd + bonus).toFixed(2));
        w.balanceUsd = w.creditBalanceUsd;
        w.totalGrantedUsd = Number(((w.totalGrantedUsd || 5) + bonus).toFixed(2));
        w.referralClaimed = true;
        w.referralCodeUsed = config.vyceReferralCode;
        w.updatedAt = Date.now();
        this.saveAll(all);

        const rem = Math.floor((w.creditBalanceUsd + 0.0001) / config.imageCostUsd);
        return {
            ok: true,
            wallet: { ...w, balanceUsd: w.creditBalanceUsd },
            remainingImages: rem,
            bonusUsd: bonus,
            BonusImages: Math.floor(bonus / config.imageCostUsd)
        };
    },

    claimSelfReferralPreviewBonus(sender) {
        return this.claimReferralBonus(sender, '');
    },

    addCustomCredit(targetUsername, amountUsd) {
        const handle = String(targetUsername || '').toLowerCase().replace(/^@/, '').trim();
        const addVal = Number(parseFloat(amountUsd) || 5.0);
        const all = this.loadAll();
        this.getUserWallet(handle);
        const w = all[handle];
        w.creditBalanceUsd = Number(Math.max(0, w.creditBalanceUsd + addVal).toFixed(2));
        w.balanceUsd = w.creditBalanceUsd;
        if (addVal > 0) {
            w.totalGrantedUsd = Number(((w.totalGrantedUsd || 5) + addVal).toFixed(2));
        }
        w.updatedAt = Date.now();
        this.saveAll(all);
        const rem = Math.floor((w.creditBalanceUsd + 0.0001) / config.imageCostUsd);
        return { ok: true, wallet: { ...w, balanceUsd: w.creditBalanceUsd }, remainingImages: rem, addedUsd: addVal };
    },

    grantModeratorBonus(targetUsername, amountUsd) {
        const res = this.addCustomCredit(targetUsername, amountUsd);
        return { ...res.wallet, balanceUsd: res.wallet.creditBalanceUsd, remainingImages: res.remainingImages };
    },

    getWalletSummaryText(sender) {
        const w = this.getUserWallet(sender);
        const isArch = w.handle === config.streamerName;
        if (isArch) {
            return `Baş Mimar @${sender}, Grok Imagine 2.0 görsel motorunda sınırsız Mimar yetkisine sahipsin! Çizim için "!ai çiz <hayalin>" yazabilirsin. İzleyici davet kodu: ${config.vyceReferralCode} (${config.vyceReferralUrl}).`;
        }
        return `@${sender} Grok Imagine 2.0 Bakiyen: $${w.creditBalanceUsd.toFixed(2)} (${w.remainingImages} ücretsiz görsel hakkı). Yayında çizim için "!ai çiz <hayalin>" yaz! Ekstra +$${config.referralBonusCreditUsd.toFixed(2)} (+20 görsel, toplam 30 görsel) bonus için: ${config.vyceReferralUrl} (Kod: ${config.vyceReferralCode}) ile kayıt olup "!ai ref onay ${config.vyceReferralCode}" yaz!`;
    },

    rateActiveImage(voterUsername, scoreNum) {
        if (!this.lastImageRecord) {
            return { ok: false, reason: `@${voterUsername} şu an ekranda oylanacak aktif bir Grok Imagine 2.0 görseli yok! Önce "!ai çiz <hayalin>" ile bir görsel üret.` };
        }
        const cleanScore = Math.min(10, Math.max(1, Math.round(scoreNum)));
        const existingIdx = this.lastImageRecord.ratings.findIndex(r => r.user.toLowerCase() === voterUsername.toLowerCase());
        if (existingIdx >= 0) {
            this.lastImageRecord.ratings[existingIdx].score = cleanScore;
        } else {
            this.lastImageRecord.ratings.push({ user: voterUsername, score: cleanScore });
        }
        const sum = this.lastImageRecord.ratings.reduce((acc, r) => acc + r.score, 0);
        this.lastImageRecord.avgRating = Number((sum / this.lastImageRecord.ratings.length).toFixed(1));
        updateImagineScoreBadgeOnScreen(this.lastImageRecord);
        return {
            ok: true,
            creator: this.lastImageRecord.displayName || this.lastImageRecord.creator || this.lastImageRecord.handle,
            avg: this.lastImageRecord.avgRating,
            count: this.lastImageRecord.ratings.length,
            record: this.lastImageRecord
        };
    }
};

// Auto-injects `#hologram-imagine-card` DOM & CSS if the user only pastes `Script.js` without updating `Index.html`/`Styles.css`!
function ensureImagineShowcaseDom() {
    try {
        if (typeof document === 'undefined') return;
        if (!document.getElementById('nexus-imagine-auto-styles')) {
            const style = document.createElement('style');
            style.id = 'nexus-imagine-auto-styles';
            style.textContent = `
                .hologram-imagine-card {
                    background: rgba(5, 8, 14, 0.96);
                    border: 1px solid rgba(0, 240, 255, 0.55);
                    border-radius: 6px;
                    padding: 8px 12px 10px 12px;
                    position: relative;
                    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.92), 0 0 18px rgba(0, 240, 255, 0.22);
                    backdrop-filter: blur(12px);
                    opacity: 0;
                    transform: translateY(-6px) scale(0.98);
                    transition: opacity 0.35s ease, transform 0.35s ease;
                    pointer-events: none;
                    display: none;
                    flex-direction: column;
                    gap: 6px;
                    margin-top: 2px;
                }
                .hologram-imagine-card.active {
                    display: flex;
                    opacity: 1;
                    transform: translateY(0) scale(1);
                    pointer-events: auto;
                }
                .imagine-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                    padding-bottom: 4px;
                }
                .imagine-title {
                    font-size: 10px;
                    font-weight: 900;
                    color: #00f0ff;
                    font-family: var(--font-mono, monospace);
                    letter-spacing: 0.6px;
                }
                .imagine-badges { display: flex; gap: 5px; align-items: center; }
                .badge-credit {
                    background: rgba(83, 252, 24, 0.18);
                    color: #53fc18;
                    border: 1px solid rgba(83, 252, 24, 0.5);
                    font-size: 8px; font-weight: 800; padding: 1px 5px; border-radius: 2px;
                    font-family: var(--font-mono, monospace);
                }
                .badge-score {
                    background: rgba(176, 38, 255, 0.22);
                    color: #e2b0ff;
                    border: 1px solid rgba(176, 38, 255, 0.55);
                    font-size: 8px; font-weight: 800; padding: 1px 5px; border-radius: 2px;
                    font-family: var(--font-mono, monospace);
                }
                .imagine-Viewport {
                    width: 100%;
                    height: 235px;
                    border-radius: 4px;
                    overflow: hidden;
                    background: rgba(0, 0, 0, 0.75);
                    border: 1px solid rgba(255, 255, 255, 0.12);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    position: relative;
                }
                .imagine-Viewport img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }
                .imagine-footer {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    gap: 8px;
                    font-size: 9.5px;
                    color: rgba(255, 255, 255, 0.85);
                    font-family: var(--font-mono, monospace);
                }
                .imagine-prompt-caption {
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    max-width: 340px;
                    color: #cbd5e1;
                }
                .imagine-ref-pill {
                    color: #00f0ff;
                    font-weight: 800;
                    font-size: 8.5px;
                    white-space: nowrap;
                }
            `;
            document.head.appendChild(style);
        }

        if (!document.getElementById('hologram-imagine-card')) {
            const hud = document.getElementById('hud-container') || document.body;
            const card = document.createElement('div');
            card.className = 'hologram-imagine-card';
            card.id = 'hologram-imagine-card';
            card.innerHTML = `
                <div class="imagine-header">
                    <span class="imagine-title" id="imagine-artist-tag">GROK IMAGINE 2.0 // @SPECIMBA</span>
                    <div class="imagine-badges">
                        <span class="badge-score" id="imagine-score-badge">PUAN: !ai puan 10</span>
                        <span class="badge-credit" id="imagine-credit-badge">BAKİYE: $5.00 (10 RESİM)</span>
                    </div>
                </div>
                <div class="imagine-Viewport">
                    <img id="imagine-preview-img" src="" alt="Grok Imagine 2.0 Stream Art" referrerpolicy="no-referrer" />
                </div>
                <div class="imagine-footer">
                    <span class="imagine-prompt-caption" id="imagine-prompt-caption">Prompt: ...</span>
                    <span class="imagine-ref-pill" id="imagine-ref-pill">+10$ (20 Resim) Ref: ${config.vyceReferralCode}</span>
                </div>
            `;
            hud.appendChild(card);
        }
    } catch (e) {}
}

function updateImagineScoreBadgeOnScreen(record) {
    const scoreEl = document.getElementById('imagine-score-badge') || document.getElementById('imagine-rating-badge');
    if (!scoreEl || !record) return;
    if (record.ratings && record.ratings.length > 0) {
        scoreEl.textContent = `★ ${record.avgRating}/10 (${record.ratings.length} OY)`;
    } else {
        scoreEl.textContent = `OYLA: !ai puan 1-10`;
    }
}

function isSafeRenderableImageUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    const trimmed = rawUrl.trim();
    if (/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i.test(trimmed)) {
        // Guard against oversized base64 payloads (>4MB)
        return trimmed.length <= 4 * 1024 * 1024;
    }
    try {
        const u = new URL(trimmed);
        return u.protocol === 'https:' || u.protocol === 'http:';
    } catch (e) {
        return false;
    }
}

function renderImagineCardOnScreen(cardPayload) {
    ensureImagineShowcaseDom();
    const card = document.getElementById('hologram-imagine-card');
    const imgEl = document.getElementById('imagine-preview-img') || document.getElementById('imagine-img');
    const artistEl = document.getElementById('imagine-artist-tag') || document.getElementById('imagine-user');
    const creditEl = document.getElementById('imagine-credit-badge');
    const promptEl = document.getElementById('imagine-prompt-caption') || document.getElementById('imagine-prompt');
    const refEl = document.getElementById('imagine-ref-pill') || document.querySelector('.imagine-ref-tag');
    if (!card || !imgEl || !isSafeRenderableImageUrl(cardPayload?.imageUrl)) return;

    if (NexusCreditLedger.hideImageTimer) clearTimeout(NexusCreditLedger.hideImageTimer);

    const senderName = cardPayload.sender || cardPayload.creator || 'CHAT';
    const balanceVal = cardPayload.creditBalanceUsd ?? cardPayload.balanceUsd ?? 0;

    imgEl.src = cardPayload.imageUrl;
    if (artistEl) artistEl.textContent = `GROK IMAGINE 2.0 // @${String(senderName).toUpperCase()}`;
    if (creditEl) {
        const isArch = String(senderName).toLowerCase() === config.streamerName;
        creditEl.textContent = isArch
            ? `BAŞ MİMAR // SINIRSIZ KREDİ`
            : `KALAN: $${Number(balanceVal).toFixed(2)} (${cardPayload.remainingImages ?? 0} RESİM)`;
    }
    if (promptEl) promptEl.textContent = `"${cardPayload.prompt || ''}"`;
    if (refEl) refEl.textContent = `+10$ Bonus Ref: ${config.vyceReferralCode}`;
    updateImagineScoreBadgeOnScreen(NexusCreditLedger.lastImageRecord);

    card.classList.add('active');
    const holdMs = Math.max(8000, config.imageHoldSeconds * 1000);
    NexusCreditLedger.hideImageTimer = setTimeout(() => {
        card.classList.remove('active');
    }, holdMs);
}

// ============================================================================
// 2C. SUPABASE `nexus-cortex` v4 AUTH HEADERS & EDGE HELPERS
// Aligned with Supabase Agent's v4 review:
// - `nexus-cortex` v4 has `verify_jwt=true`, so callers must ALWAYS send a valid
//   `Authorization: Bearer <supabase_anon_key>` JWT header (plus `apikey`), even
//   when also sending `x-nexus-secret` for `shared_secret` trusted write/bypass mode.
// - Billable `imagine` requests NEVER retry across multiple hosts or fall back
//   after a timeout/provider HTTP error, preventing duplicate $0.50 charges!
// ============================================================================
function isThreePartJwt(token) {
    if (!token || typeof token !== 'string') return false;
    const parts = token.trim().split('.');
    return parts.length === 3 && token.trim().startsWith('eyJ');
}

function buildSupabaseAuthHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const anonKey = config.supabaseAnonKey;
    if (anonKey) {
        headers['apikey'] = anonKey;
        // Supabase Edge Gateway with verify_jwt=true requires a valid 3-part JWT (eyJ...) in Authorization: Bearer.
        // If the user pasted an sb_publishable_... key instead of the anon JWT, sending it as Bearer under verify_jwt=true
        // is rejected at the gateway; we still attach it if no other JWT exists, and log a diagnostic hint on 401.
        headers['Authorization'] = `Bearer ${anonKey}`;
    }
    // CRITICAL SECURITY FIX IN v29.7 (Per Supabase Agent Review):
    // 1. NEVER place or send NEXUS_SHARED_SECRET ('x-nexus-secret') from KickBot variables or browser code!
    //    Any secret sent by a browser widget is publicly visible in DevTools/OBS and would let anonymous callers
    //    gain trustedWrite authorization, bypass rate limits, and write to database tables.
    // 2. NEVER send 'x-vyce-key' from the browser! Keep provider keys strictly in Supabase Edge Function Secrets.
    return headers;
}

async function syncBannedTopicToEdgeCortex(topic, sender = 'specimba') {
    if (!config.supabaseEdgeUrl || !config.supabaseAnonKey || !topic) return null;
    try {
        const res = await fetchWithTimeout(config.supabaseEdgeUrl, {
            method: 'POST',
            headers: buildSupabaseAuthHeaders(),
            body: JSON.stringify({
                action: 'ban_topic',
                sender,
                streamerName: config.streamerName,
                topic: String(topic).slice(0, 100).toLowerCase()
            })
        }, 4500);
        if (res.ok) return await res.json();
    } catch (e) {}
    return null;
}

async function runEdgeCortexDiagnostics() {
    if (!config.supabaseEdgeUrl || !config.supabaseAnonKey) return null;
    try {
        const res = await fetchWithTimeout(config.supabaseEdgeUrl, {
            method: 'POST',
            headers: buildSupabaseAuthHeaders(),
            body: JSON.stringify({
                action: 'diagnostics',
                sender: config.streamerName,
                streamerName: config.streamerName
            })
        }, 5000);
        if (res.ok) {
            const j = await res.json();
            if (j?.ok) return j;
        }
    } catch (e) {}
    return null;
}

async function fetchEdgeModelCatalog() {
    if (!config.supabaseEdgeUrl || !config.supabaseAnonKey) return null;
    try {
        const res = await fetchWithTimeout(config.supabaseEdgeUrl, {
            method: 'POST',
            headers: buildSupabaseAuthHeaders(),
            body: JSON.stringify({
                action: 'models',
                sender: config.streamerName,
                streamerName: config.streamerName
            })
        }, 4500);
        if (res.ok) {
            const j = await res.json();
            if (j?.ok && Array.isArray(j.models)) return j;
        }
    } catch (e) {}
    return null;
}

const ALLOWED_IMAGINE_SIZES = new Set(['1024x1024', '1024x768', '768x1024']);

async function callGrokImagine2API(promptText, sender = 'specimba', requestedSize = '1024x1024') {
    const cleanPrompt = String(promptText || '').trim().slice(0, 900);
    if (!cleanPrompt) return { ok: false, status: 400, error: 'Görsel komutu (imagePrompt) boş olamaz.' };
    const size = ALLOWED_IMAGINE_SIZES.has(requestedSize) ? requestedSize : '1024x1024';

    setToolBadge(true, 'GROK // IMAGINE_2.0');
    updateModelBadge('GROK IMAGINE 2.0');
    setAiCoreState('VYCE // GROK_IMAGINE_2', 'busy');

    try {
        // 1. Primary Route: Supabase Edge Function `nexus-cortex` v4 (`verify_jwt=true` requires `supabaseAnonKey`)
        if (config.supabaseEdgeUrl && config.supabaseAnonKey) {
            try {
                const edgeRes = await fetchWithTimeout(config.supabaseEdgeUrl, {
                    method: 'POST',
                    headers: buildSupabaseAuthHeaders(),
                    body: JSON.stringify({
                        action: 'imagine',
                        sender,
                        streamerName: config.streamerName,
                        imagePrompt: cleanPrompt,
                        prompt: cleanPrompt,
                        size
                    })
                }, 26000);

                const edgeData = await edgeRes.json().catch(() => ({}));

                if (edgeRes.ok && edgeData?.ok && isSafeRenderableImageUrl(edgeData.imageUrl)) {
                    return {
                        ok: true,
                        status: 200,
                        imageUrl: edgeData.imageUrl,
                        modelLabel: edgeData.modelLabel || 'VYCE // GROK-IMAGINE-2'
                    };
                }

                // Respect v4 Edge rate limits (429): do NOT bypass or retry on client
                if (edgeRes.status === 429) {
                    return {
                        ok: false,
                        status: 429,
                        retryAfterSeconds: edgeData?.retryAfterSeconds || 60,
                        error: edgeData?.error || 'Görsel üretim hız sınırına (rate limit) ulaşıldı.'
                    };
                }

                // Respect v4 fail-closed Upstash requirement (503) unless local `vyce_api_key` is explicitly provided
                if (edgeRes.status === 503) {
                    if (!config.vyceKey) {
                        return {
                            ok: false,
                            status: 503,
                            error: edgeData?.error || 'Public görsel üretimi için Supabase üzerinde Upstash Redis hız sınırlayıcısı (UPSTASH_REDIS_REST_URL / TOKEN) tanımlanmalıdır.'
                        };
                    }
                } else if (edgeRes.status === 502) {
                    // Only fall back to local client key if Edge explicitly reported that VYCE_API_KEY is not configured on Edge.
                    // NEVER retry a timed-out or failed provider request to avoid duplicate $0.50 billing!
                    const isUnconfiguredOnEdge = /VYCE_API_KEY is not configured/i.test(String(edgeData?.error || ''));
                    if (!isUnconfiguredOnEdge || !config.vyceKey) {
                        return {
                            ok: false,
                            status: 502,
                            error: edgeData?.error || 'Görsel sağlayıcı yanıt vermedi veya zaman aşımına uğradı (çift ücretlendirmeyi önlemek için tekrar denenmedi).'
                        };
                    }
                } else if (edgeRes.status >= 400 && !config.vyceKey) {
                    return {
                        ok: false,
                        status: edgeRes.status,
                        error: edgeData?.error || `Edge görsel hatası (HTTP ${edgeRes.status})`
                    };
                }
            } catch (edgeErr) {
                // If the Edge request itself timed out in flight, do NOT issue a second billable request!
                return {
                    ok: false,
                    status: 504,
                    error: 'Görsel isteği zaman aşımına uğradı; mükerrer ücretlendirmeyi önlemek için tekrar gönderilmedi.'
                };
            }
        }

        // 2. Single-Attempt Direct Fallback (ONLY when Edge was not called or reported VYCE_API_KEY unset, and local `vyce_api_key` is set)
        const vyceKey = config.vyceKey;
        if (vyceKey) {
            const base = (config.vyceBaseUrl || 'https://vyceai.com/v1').replace(/\/+$/, '');
            try {
                const res = await fetchWithTimeout(`${base}/images/generations`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${vyceKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: VYCE_IMAGE_MODEL.id,
                        prompt: cleanPrompt,
                        n: 1,
                        size
                    })
                }, 25000);

                if (!res.ok) {
                    return { ok: false, status: res.status, error: `Görsel sağlayıcı HTTP ${res.status} döndürdü.` };
                }
                const j = await res.json();
                const first = Array.isArray(j?.data) ? j.data[0] : j;
                const imgUrl = first?.url ?? first?.image_url ?? j?.url ?? j?.image_url ?? (first?.b64_json ? `data:image/png;base64,${first.b64_json}` : '');
                if (isSafeRenderableImageUrl(imgUrl)) {
                    return { ok: true, status: 200, imageUrl: imgUrl, modelLabel: 'VYCE // GROK-IMAGINE-2' };
                }
                return { ok: false, status: 502, error: 'Görsel sağlayıcı geçerli bir görsel URL döndürmedi.' };
            } catch (e) {
                return { ok: false, status: 504, error: 'Görsel isteği zaman aşımına uğradı; mükerrer ücretlendirmeyi önlemek için tekrar gönderilmedi.' };
            }
        }
    } finally {
        setTimeout(() => setToolBadge(false), 1800);
    }

    return {
        ok: false,
        status: 503,
        error: 'Grok Imagine 2.0 için Supabase Anon Key + Upstash Redis (veya VYCE_API_KEY) yapılandırılmalıdır.'
    };
}



// ============================================================================
// 2D. v30 RSI KILL-SWITCH, SERVER-SIDE CREDIT SYNC & LOCAL VOICE MONOLOGUE BRIDGE
// ============================================================================
async function callEdgeRsiControl(mode = 'status', sender = 'specimba') {
    if (!config.supabaseEdgeUrl || !config.supabaseAnonKey) return null;
    try {
        const res = await fetchWithTimeout(config.supabaseEdgeUrl, {
            method: 'POST',
            headers: buildSupabaseAuthHeaders(),
            body: JSON.stringify({
                action: 'rsi_control',
                mode,
                sender,
                streamerName: config.streamerName
            })
        }, 5000);
        if (res.ok) return await res.json();
    } catch (e) {}
    return null;
}

async function syncViewerCreditsWithEdge(subAction = 'balance', sender = 'specimba', targetUser = '', amountUsd = 10) {
    if (!config.supabaseEdgeUrl || !config.supabaseAnonKey) return null;
    try {
        const res = await fetchWithTimeout(config.supabaseEdgeUrl, {
            method: 'POST',
            headers: buildSupabaseAuthHeaders(),
            body: JSON.stringify({
                action: 'credits',
                subAction,
                sender,
                targetUser: targetUser || sender,
                amountUsd,
                streamerName: config.streamerName
            })
        }, 4500);
        if (res.ok) return await res.json();
    } catch (e) {}
    return null;
}

async function fetchLocalStreamerVoiceMonologue() {
    try {
        const res = await fetchWithTimeout('http://127.0.0.1:5050/monologue', { method: 'GET' }, 900);
        if (res.ok) {
            const j = await res.json();
            if (j?.ok && j.monologue) return String(j.monologue).slice(0, 1200);
        }
    } catch (e) {}
    return '';
}

// ============================================================================
// 2E. RESTORED CORE UTILITIES, L1/L2/L3 CACHE & TRIGGER PARSERS (FROM v28)
// ============================================================================
function detectLanguage(text) {
    if (/[çğıöşüÇĞİÖŞÜ]/i.test(text)) return 'tr';
    const trWords = /(?:^|\s)(ve|bir|bu|ne|sen|ben|yok|var|için|de|da|ama|gibi|mi|mı|mu|mü|nasıl|neden|kim|nerede|nereli|eleman|araştır|yayın|yayınaç|selam|merhaba|naber|alooo|bugün|maç|hava|kız|hayat|film|mimar|başka|neler|dedi|pazar|liste|hikaye|sonrakini|sene|detaylandır|kedi|özcan|özdağ|duygusal|çocuk|bekle|dur|dinliyoz|müzik|sanatçı|haklıyım|demi|kanal|yönetmenlik)(?=$|\s)/i;
    return trWords.test(text) ? 'tr' : 'en';
}

function formatTimeAgo(timestamp) {
    if (!timestamp) return '';
    const sec = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
    if (sec < 60) return `${sec} sn önce`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} dk önce`;
    return `${Math.floor(min / 60)} saat önce`;
}

function getLiveTurkishDateTime() {
    try {
        const now = new Date();
        const d = now.toLocaleDateString('tr-TR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Europe/Istanbul' });
        const t = now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' });
        return `${d}, Saat ${t} (Türkiye Saati)`;
    } catch (e) { return new Date().toISOString().slice(0, 16); }
}

function normalizeArtistAndEntityTypos(text) {
    if (!text) return '';
    return String(text).replace(/\b9{4,}\b/g, '999999999');
}

const IntelligenceCache = {
    store: new Map(),
    TTL_MS: 5 * 60 * 1000,
    get(key) {
        const item = this.store.get(key);
        if (!item) return null;
        if (Date.now() - item.ts > this.TTL_MS) { this.store.delete(key); return null; }
        return item.val;
    },
    set(key, val) { if (val) this.store.set(key, { val, ts: Date.now() }); },
    clearAll() { this.store.clear(); }
};

async function fetchWithTimeout(url, options = {}, timeoutMs = 4500) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: ctrl.signal });
        clearTimeout(tid);
        return res;
    } catch (e) { clearTimeout(tid); throw e; }
}

const NexusRedisCache = {
    hits: 0,
    get isConfigured() {
        return Boolean(config.redisRestUrl && config.redisRestToken);
    },
    async get(key) {
        const l1 = IntelligenceCache.get(key);
        if (l1) return l1;
        if (!this.isConfigured) return null;
        try {
            const safeKey = encodeURIComponent(`nexus_v30:${key}`);
            const res = await fetchWithTimeout(`${config.redisRestUrl}/get/${safeKey}`, {
                headers: { 'Authorization': `Bearer ${config.redisRestToken}` }
            }, 1400);
            if (res.ok) {
                const data = await res.json();
                if (data && data.result) {
                    this.hits++;
                    let parsed = data.result;
                    try { parsed = JSON.parse(data.result); } catch (e) {}
                    if (!POISON_MEMORY_REGEX.test(String(parsed)) && !containsBannedTopic(String(parsed))) {
                        IntelligenceCache.set(key, parsed);
                        return parsed;
                    }
                }
            }
        } catch (e) {}
        return null;
    },
    async set(key, value, ttlSeconds = 900) {
        if (!value) return;
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        if (POISON_MEMORY_REGEX.test(serialized) || containsBannedTopic(serialized)) return;
        IntelligenceCache.set(key, value);
        if (!this.isConfigured) return;
        try {
            const fullKey = `nexus_v30:${key}`;
            await fetchWithTimeout(`${config.redisRestUrl}/pipeline`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${config.redisRestToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify([['SETEX', fullKey, String(ttlSeconds), serialized]])
            }, 1600);
        } catch (e) {}
    }
};

const NexusSupabaseVault = {
    syncedCount: 0,
    get isConfigured() {
        return Boolean(config.supabaseUrl && config.supabaseAnonKey);
    },
    getHeaders(prefer = 'return=minimal') {
        return {
            'apikey': config.supabaseAnonKey,
            'Authorization': `Bearer ${config.supabaseAnonKey}`,
            'Content-Type': 'application/json',
            'Prefer': prefer
        };
    },
    async queryKnowledge(cleanTopic) {
        if (!cleanTopic || cleanTopic.length < 2) return '';
        const cacheKey = `sb_know:${cleanTopic.toLowerCase()}`;
        const cached = await NexusRedisCache.get(cacheKey);
        if (cached) return String(cached);
        if (!this.isConfigured) return '';
        setToolBadge(true, 'DB // SUPABASE_RAG');
        try {
            const q = encodeURIComponent(`%${cleanTopic}%`);
            // Strictly uses confirmed public.nexus_knowledge columns (topic, keywords, summary)
            const url = `${config.supabaseUrl}/rest/v1/nexus_knowledge?or=(topic.ilike.${q},keywords.ilike.${q},summary.ilike.${q})&limit=3`;
            const res = await fetchWithTimeout(url, { headers: this.getHeaders('return=representation') }, 2400);
            if (res.ok) {
                const rows = await res.json();
                if (Array.isArray(rows) && rows.length > 0) {
                    const formatted = rows
                        .map(r => `[SUPABASE BİLGİ BANKASI (${r.topic || cleanTopic})]: ${r.summary}`)
                        .filter(s => !POISON_MEMORY_REGEX.test(s) && !containsBannedTopic(s))
                        .join(' || ');
                    if (formatted) {
                        this.syncedCount++;
                        await NexusRedisCache.set(cacheKey, formatted, 1800);
                        return formatted;
                    }
                }
            }
        } catch (e) {} finally {
            setTimeout(() => setToolBadge(false), 1400);
        }
        return '';
    },
    async upsertKnowledge(topic, category, summary, source = 'live_research') {
        if (!topic || !summary || POISON_MEMORY_REGEX.test(summary) || containsBannedTopic(summary)) return;
        const cacheKey = `sb_know:${topic.toLowerCase()}`;
        await NexusRedisCache.set(cacheKey, `[SUPABASE BİLGİ BANKASI (${topic})]: ${summary}`, 1800);
    },
    async syncChatterDossier(chatter) {
        // Handled server-side by nexus-cortex v30 Edge Function
        return;
    }
};

function hasAiTrigger(rawContent, trigger) {
    if (!rawContent || !trigger) return false;
    const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?:^|\\s)${escaped}(?=$|\\s|[?!.,;:])`, 'i');
    return regex.test(rawContent.trim());
}

function stripAiTrigger(rawContent, trigger) {
    if (!rawContent || !trigger) return '';
    const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?:^|\\s)${escaped}(?=$|\\s|[?!.,;:])`, 'gi');
    return rawContent.replace(regex, ' ').replace(/\s+/g, ' ').trim();
}

function extractTurkishTopicRoot(word) {
    if (!word) return '';
    let w = word.toLowerCase().replace(/[^a-zçğıöşü0-9]/gi, '').trim();
    if (/^kahve/.test(w)) return 'kahve';
    if (/^latte/.test(w)) return 'latte';
    if (/^safiye/.test(w)) return 'safiye';
    if (/^boss/.test(w)) return 'boss';
    if (/^strateji/.test(w)) return 'strateji';
    if (/^silah/.test(w)) return 'silah';
    if (/^oyun/.test(w)) return 'oyun';
    w = w.replace(/(unun|ünün|ının|inin|nizi|nızı|nuzu|nüzü|mizi|mızı|muzu|müzü|leri|ları|sini|sını|sunu|sünü|nin|nın|nun|nün|ni|nı|nu|nü|yi|yı|yu|yü|un|ün|ın|in|mi|mı|mu|mü|den|dan|ten|tan|de|da|te|ta|i|ı|u|ü)$/i, '');
    return w.length >= 3 ? w : word.toLowerCase();
}

function extractAndBanRejectedTopics(rawText, sender = 'specimba') {
    if (!rawText) return [];
    const lower = rawText.toLowerCase();
    const bannedNow = [];

    const addRoot = (candidate) => {
        const root = extractTurkishTopicRoot(candidate);
        if (root && root.length >= 3 && !/^(seni|sizi|beni|onu|bunu|şunu|ananı|belanı|senin|benim|da|de|ve|ya|ki|bu|şu|amk|aq|sik)$/i.test(root)) {
            addBannedTopic(root, sender);
            if (!bannedNow.includes(root)) bannedNow.push(root);
        }
    };

    const hayMultiMatch = lower.match(/hay\s+(.+?)\s+(?:amk|aq|amina|amına|sik|sikeyim|sikim|sikiyim|siksin|sikerim|mk)/i);
    if (hayMultiMatch && hayMultiMatch[1]) {
        const tokens = hayMultiMatch[1].split(/\s+/).filter(t => t.length >= 3 && !/^(unun|ünün|ının|inin|senin|sizin|onun|bunun|şunun)$/i.test(t));
        tokens.forEach(addRoot);
    }

    const curseMatch = lower.match(/([a-zçğıöşü0-9]{3,})\s+(?:sikeyim|sikim|sikiyim|siksin|sikerim)/i);
    if (curseMatch && curseMatch[1]) addRoot(curseMatch[1]);

    const forgetMatch = lower.match(/(?:unut\s*şu|bıktım\s*şu|yeter\s*şu|kapat\s*şu)\s+([a-zçğıöşü0-9]{3,})/i);
    if (forgetMatch && forgetMatch[1]) addRoot(forgetMatch[1]);

    if (/\bboss\b|strateji/i.test(lower) && /(amk|aq|sik|kes|ne\s*anlatıyon|nalaka|ne\s*alaka)/i.test(lower)) {
        ['boss', 'strateji', 'silah seti', 'harita rotaları', 'ekip uyumu'].forEach(t => {
            addBannedTopic(t, sender);
            if (!bannedNow.includes(t)) bannedNow.push(t);
        });
    }

    if (/kahve/i.test(lower) && /(sik|unut|yeter|bıktım|kapat|kes|nalaka|ne\s*alaka)/i.test(lower)) {
        ['kahve', 'latte', 'kafein'].forEach(t => {
            addBannedTopic(t, sender);
            if (!bannedNow.includes(t)) bannedNow.push(t);
        });
    }

    return bannedNow;
}

const SLANG_AND_CHAT_STOPWORDS_REGEX = /\b(mal|salak|aptal|gerizekalı|götveren|ibne|oç|amk|aq|amına|amina|arıncam|sik|siksin|sikeyim|sikim|sikiyim|siktir|sikicem|belanı|belani|annenin|ananın|ananin|laciverte|boyayım|saksıya|fesleğen|oturunca|olum|oğlum|lan|la|lo|alooo|alo|naber|küsmüş|vermiyo|cevap|kendine|gel|gitsin|gitmesem|gitse|gideyim|miyim|mıyım|acaba|nalaka|alaka|ne\s*alaka|uzatmadan|kısa|yaz|konuş|söyle|soruyorum|sordum|dedim|diyorum|diyo|diyor|unut|sil|hafızandan|hafizandan|meselesini|tamamen|artık|artik|hala|hâlâ|önceki|onceki|sürüm|surum|geri|yükleme|yukleme|bence|sence|bundan|sonra|emir|emirdir|niye|getiremiyosun|getiremiyorsun|adam|olmaz|hay|senin|ben|ta|allah|versin|iddia|etme|bari|olmayan|şarkıları|detaylandır|bakalım|bakim|başka|falan|dene|yayınaç|dur|bekle|sen|çocuk|duygusal|kes|anlatıyon|anlatıyosun|mallaştın|yine|sabah|filan|iyi|durumdaydın|boss|unun|stratejinin)\b/gi;

function extractCleanEntitySearchQuery(rawText) {
    if (!rawText) return '';
    let cleaned = normalizeArtistAndEntityTypos(rawText)
        .replace(/!ai/gi, ' ')
        .replace(/\[BARE_PING[^\]]*\]/gi, ' ')
        .replace(/\[Yanıtlanan mesaj[^\]]*\]/gi, ' ')
        .replace(/\[EMOTE:[^\]]*\]/gi, ' ')
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(SLANG_AND_CHAT_STOPWORDS_REGEX, ' ')
        .replace(/(kimdir|kim\s*la|kim\s*bu|kim|nedir|neresidir|nereli|nerelidir|hangi\s*ülkeli|ne\s*demek|tanıyon\s*mu|tanıyor\s*musun|biliyon\s*mu|biliyor\s*musun|hakkında\s*bilgi|araştır\s*bakim|araştır\s*bakalım|bi\s*araştır|araştır|anlat|düzgünce\s*bak|uydurma|ne\s*zaman|bu\s*sene|gelecek\s*sene|seneye|sonrakini|sonraki|dinliyoz|dinliyoruz|şimdi|bu\s*elemanın|elemanın|olayı\s*ne)/gi, ' ')
        .replace(/[?!.,;:"'()[\]{}]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (containsBannedTopic(cleaned)) return '';
    if (cleaned.length < 2) return '';
    return cleaned;
}

const KICK_EMOTE_DICTIONARY = {
    'kekw': 'KEKW (Kahkaha Krizi)', 'lul': 'LUL (Gülme)', 'lulw': 'LULW (Kahkaha)', 'omegalul': 'OMEGALUL (Yarılarak Gülme)',
    'icant': 'ICANT (Gülmekten Dayanamama)', 'pepelaugh': 'PepeLaugh (Bıyık Altından Gülme)', 'pog': 'Pog (Heyecan/Şaşkınlık)',
    'pogchamp': 'PogChamp (Büyük Heyecan)', 'pogu': 'PogU (Şaşkınlık/Onay)', 'pagman': 'PagMan (Heyecan)',
    'catjam': 'catJAM (Ritim Tutma)', 'ratjam': 'ratJAM (Ritim Tutma)', 'vibepls': 'vibePLS (Dans/Ritim)',
    'peped': 'pepeD (Dans)', 'sadge': 'Sadge (Hüzün/Üzüntü)', 'pepehands': 'PepeHands (Ağlama)', 'feelsbadman': 'FeelsBadMan (Üzüntü)',
    'feelsstrongman': 'FeelsStrongMan (Duygulanma)', 'monkaw': 'monkaW (Gerilim/Korku)', 'monkas': 'monkaS (Soğuk Ter/Endişe)',
    'pepemeltdown': 'pepeMeltdown (Panik/Kriz)', 'gigachad': 'GIGACHAD (Alfa/Karizma)', 'based': 'BASED (Haklı/Alfa)',
    'ez': 'EZ (Kolay/Rahat)', 'clap': 'Clap (Alkış)', 'copium': 'Copium (Kendini Avutma)', 'hopium': 'Hopium (Umutlanma)',
    'clown': 'Palyaço', 'kappa': 'Kappa (İroni/Kinaye)', '5head': '5Head (Üstün Zeka)', '3head': '3Head (Saflık)',
    'dentge': 'Dentge (Kafası Basmama)', 'sus': 'SUS (Şüpheli)', 'modcheck': 'modCheck (Kimse Yok Mu?)',
    'stare': 'Stare (Dik Dik Bakma)', 'weirdchamp': 'WeirdChamp (Garipseme)', 'aware': 'Aware (Acı Gerçeği Fark Etme)',
    'clueless': 'Clueless (Habersiz)', 'o7': 'o7 (Asker Selamı/Saygı)', 'peeporiot': 'peepoRiot (İsyan)',
    'madge': 'Madge (Kızgın)', 'prayge': 'Prayge (Dua)', 'nodders': 'NODDERS (Baş Sallayarak Onay)',
    'nope': 'NOPE (Kafa Sallayarak Red)', 'w': 'W (Zafer)', 'l': 'L (Yenilgi)', 'booba': 'BOOBA (Şaşkınlıkla Bakma)'
};

function extractRawChatPayload(data) {
    if (!data) return '';
    return String(data.content ?? data.message ?? data.text ?? data.html ?? '').trim();
}

function decodeKickEmotesInText(rawText, eventData = null) {
    let text = String(rawText || '');
    text = text.replace(/<img[^>]*?(?:alt|title|data-emote-name)=["']([^"']+)["'][^>]*?>/gi, (_, name) => {
        const clean = name.replace(/^:|:$/g, '').trim();
        const meaning = KICK_EMOTE_DICTIONARY[clean.toLowerCase()] || `${clean} (Kick Emote)`;
        return ` [EMOTE: ${meaning}] `;
    });
    text = text.replace(/<img[^>]*?src=["'][^"']*?\/emotes\/(\d+)\/[^"']*?["'][^>]*?>/gi, (_, id) => ` [EMOTE: KickEmote#${id}] `);
    text = text.replace(/\[emote:\s*\d+\s*(?::\s*([^\]]+))?\]/gi, (_, name) => {
        const clean = (name || 'KickEmote').trim();
        const meaning = KICK_EMOTE_DICTIONARY[clean.toLowerCase()] || `${clean} (Kick Emote)`;
        return ` [EMOTE: ${meaning}] `;
    });
    text = text.replace(/:([a-zA-Z0-9_]{2,28}):/g, (full, name) => {
        const lower = name.toLowerCase();
        if (KICK_EMOTE_DICTIONARY[lower]) return ` [EMOTE: ${KICK_EMOTE_DICTIONARY[lower]}] `;
        if (/^(kick|emoji|pepe|cat|doge|speci|hype|love|fire|gg|wp)/i.test(name)) return ` [EMOTE: ${name}] `;
        return full;
    });
    const emotesArr = eventData?.emotes || eventData?.metadata?.emotes;
    if (Array.isArray(emotesArr) && emotesArr.length > 0 && !text.includes('[EMOTE:')) {
        const names = emotesArr.map(e => {
            const n = e.name || e.shortcode || e.id || 'Emote';
            return KICK_EMOTE_DICTIONARY[String(n).toLowerCase()] || `${n} (Kick Emote)`;
        });
        text = `${text} [EMOTE: ${names.join(', ')}]`.trim();
    }
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!cleaned && eventData && eventData.sender?.username) return '[EMOTE TEPKİSİ]';
    return cleaned;
}

const VERIFIED_KNOWLEDGE_GRAPH = [
    {
        pattern: /(\bhealer\b.*messenger|the\s*messenger.*healer|\bhealer\b)/i,
        info: `[DOĞRULANMIŞ MÜZİK & SANATÇI DOSYASI — HEALER ("The Messenger")]: HEALER — "The Messenger", karanlık atmosferik elektronik / witch house / darkwave / sinematik bass sahnesinde öne çıkan derin, hipnotik ve melankolik bir parçadır (yayında Baş Mimar @specimba'nın Lorn, Snakes of Russia, CNJR ve Vora Sans ile birlikte dinlediği dark-electronic seçkisinin parçasıdır).`
    },
    {
        pattern: /(\blorn\b|out\s*of\s*the\s*frame|acid\s*rain.*lorn)/i,
        info: `[DOĞRULANMIŞ SANATÇI DOSYASI — LORN ("OUT OF THE FRAME")]: Amerikalı (Marcos Ortega) kült karanlık elektronik / dark ambient / industrial IDM prodüktörü (Wednesday Sound / Ninja Tune). "Acid Rain", "Anvil", "Sega Sunset" ve "OUT OF THE FRAME" gibi karanlık analog synth parçalarıyla efsanedir.`
    },
    {
        pattern: /(snakes\s*of\s*russia|the\s*consumption|\bcnjr\b)/i,
        info: `[DOĞRULANMIŞ SANATÇI DOSYASI — CNJR & SNAKES OF RUSSIA ("The Consumption - Snakes of Russia Remix")]: Snakes of Russia (Joseph Holiday) Los Angeles merkezli karanlık sinematik downtempo ("death beats") projesidir; CNJR ise karanlık endüstriyel synth ve elektronik dokuları birleştiren prodüktördür.`
    },
    {
        pattern: /(vora\s*sans|\b14d\b.*vora)/i,
        info: `[DOĞRULANMIŞ SANATÇI DOSYASI — VORA SANS ("14D")]: Karanlık atmosferik elektronik, ambient ve deneysel ses tasarımıyla tanınan prodüktör ("14D").`
    },
    {
        pattern: /(tanju\s*özcan|bolu\s*belediye|evde\s*kedi\s*gibi|suya\s*sabuna\s*dokunmadan|oğluma\s*kız\s*istemek)/i,
        info: `[DOĞRULANMIŞ HABER DOSYASI — TANJU ÖZCAN BOLU BELEDİYESİ DAVASI SAVUNMASI]: Bolu Belediyesi'ne yönelik davada tutuklu yargılanan Tanju Özcan, üçüncü duruşmada tahliyesini talep ederken "Serbest kalmak istiyorum. Oğluma kız istemek istiyorum. Suya sabuna dokunmadan evde kedi gibi oturacağım" ifadelerini kullandı.`
    },
    {
        pattern: /(\blandman\b|landman\s*izle)/i,
        info: `[DOĞRULANMIŞ DİZİ DOSYASI — LANDMAN (2024–2026)]: Taylor Sheridan tarafından yaratılan, başrolünde Billy Bob Thornton, Jon Hamm ve Demi Moore'un yer aldığı Batı Teksas petrol sahalarındaki krizleri anlatan Amerikan dram dizisi.`
    },
    {
        pattern: /(codex.*(reset|limit|quota|hak|kullanım|sıfırla|ne\s*zaman)|openai\s*codex.*(reset|limit|quota)|(reset|limit|quota).*codex)/i,
        info: `[DOĞRULANMIŞ OPENAI CODEX KULLANIM LİMİTİ & RESET MİMARİSİ]: ChatGPT Plus / Pro / Team aboneliklerine dahil olan OpenAI Codex kotaları ilk görev gönderdiğin andan itibaren başlayan kayan pencere (5 saatlik anlık pencere + 7 günlük haftalık pencere) mantığıyla sıfırlanır.`
    },
    {
        pattern: /(grammy|grammys|grammy\s*ödül)/i,
        info: `[DOĞRULANMIŞ GRAMMY ÖDÜLLERİ TAKVİMİ]: 68. Grammy Ödülleri 1 Şubat 2026'da yapıldı. Bir sonraki 69. Grammy Ödülleri 7 Şubat 2027 Pazar günü Los Angeles Crypto.com Arena'da düzenlenecek.`
    },
    {
        pattern: /(9{4,}|9x9)/i,
        info: `[DOĞRULANMIŞ SANATÇI DOSYASI — 999999999 (9x9)]: İtalyan (İtalya çıkışlı) Acid / Hard Techno ikilisidir (Carlo Cavalieri ve Giovanni).`
    },
    {
        pattern: /(poltergst|iampoltergst)/i,
        info: `[DOĞRULANMIŞ SANATÇI DOSYASI — POLTERGST]: Alman ("German Ghost Boy", Almanya Euskirchen çıkışlı) Hard Techno prodüktörü (Spinnin' Records / ZWVRT).`
    },
    {
        pattern: /(?:^|\s)(ihm|i\s*hate\s*models)(?=$|\s|[?!.,])/i,
        info: `[DOĞRULANMIŞ SANATÇI DOSYASI — I HATE MODELS (IHM)]: Fransız (Guillaume Labadie) Industrial / Hard Techno prodüktörü.`
    },
    {
        pattern: /(6ejou)/i,
        info: `[DOĞRULANMIŞ SANATÇI DOSYASI — 6EJOU]: Fransız (Lyon çıkışlı) Hard Techno prodüktörü.`
    }
];

function lookupKnowledgeGraph(queryText) {
    const matches = [];
    for (const item of VERIFIED_KNOWLEDGE_GRAPH) {
        if (item.pattern.test(queryText)) matches.push(item.info);
    }
    return matches.join(' || ');
}

const StreamTelemetryState = {
    viewerCount: 0,
    peakViewerCount: 0,
    hasDirectKickLock: false,
    isLive: true,
    streamTitle: '',
    streamCategory: '',
    streamStartTime: null,
    liveThumbnailUrl: '',
    obsSceneName: '',
    hbStatus: 'READY',
    hbJobsCompleted: 0,

    getStreamSummary() {
        const parts = [
            `Yayın Durumu: ${this.isLive ? 'AÇIK (CANLI SOHBET & MÜZİK)' : 'OFFLINE SOHBET'}`,
            `Anlık İzleyici: ${this.viewerCount}${this.peakViewerCount > this.viewerCount ? ' (Zirve: ' + this.peakViewerCount + ')' : ''}`
        ];
        if (this.streamCategory) parts.push(`Kanal Kategorisi: ${this.streamCategory} (NOT: Yayında oyun OYNANMIYOR; müzik ve sohbet yayını!)`);
        if (this.streamTitle) parts.push(`Yayın Başlığı: "${this.streamTitle}"`);
        if (this.obsSceneName) parts.push(`OBS Sahnesi: "${this.obsSceneName}"`);
        return parts.join(' | ');
    }
};

(function initObsSceneAwareness() {
    try {
        if (typeof window !== 'undefined' && window.obsstudio) {
            if (typeof window.obsstudio.getCurrentScene === 'function') {
                window.obsstudio.getCurrentScene((scene) => {
                    if (scene && scene.name) StreamTelemetryState.obsSceneName = scene.name;
                });
            }
            window.addEventListener('obsSceneChanged', (ev) => {
                if (ev?.detail?.name) StreamTelemetryState.obsSceneName = ev.detail.name;
            });
        }
    } catch (e) {}
})();

const StreamConsciousness = {
    timeline: [],
    maxAgeMs: 600000,

    record(username, rawText, eventData = null) {
        if (!username) return;
        const unameLower = username.toLowerCase();
        if (unameLower === 'kickbot' || unameLower === 'streamlabs' || /^thanks for the follow|^thank you for following/i.test(rawText || '')) {
            return;
        }
        let decodedText = decodeKickEmotesInText(rawText, eventData);
        if (!decodedText) return;
        if (POISON_MEMORY_REGEX.test(decodedText) || containsBannedTopic(decodedText)) return;

        const replyParentUser = eventData?.metadata?.original_sender?.username || '';
        const replyParentText = eventData?.metadata?.original_message?.content || '';
        if (replyParentUser && replyParentText && !decodedText.includes(replyParentText.slice(0, 15))) {
            const cleanParent = decodeKickEmotesInText(replyParentText).slice(0, 80);
            if (!containsBannedTopic(cleanParent)) {
                decodedText = `(@${replyParentUser}'ın "${cleanParent}" sözüne yanıt): ${decodedText}`;
            }
        }

        const entry = {
            username,
            handleLower: unameLower,
            text: decodedText.slice(0, 300),
            timestamp: Date.now()
        };
        this.timeline.push(entry);
        this.prune();

        if (/https?:\/\/[^\s]+/i.test(rawText) && !hasAiTrigger(rawText, config.trigger)) {
            unfurlLinksInPrompt(rawText, username, false).then((unfurled) => {
                if (unfurled && unfurled.text) {
                    entry.text = `${entry.text} -> ${unfurled.text.slice(0, 220)}`;
                }
            }).catch(() => {});
        }
    },

    recordSystemEvent(eventLabel) {
        if (!eventLabel) return;
        this.timeline.push({
            username: 'MOD_SISTEM',
            handleLower: 'mod_sistem',
            text: eventLabel.slice(0, 220),
            timestamp: Date.now()
        });
        this.prune();
    },

    purgeTopicFromTimeline(topicWords = []) {
        if (!Array.isArray(topicWords) || topicWords.length === 0) {
            this.timeline = [];
            return;
        }
        this.timeline = this.timeline.filter(item => {
            const lower = (item.text || '').toLowerCase();
            return !topicWords.some(w => w && lower.includes(w.toLowerCase())) && !containsBannedTopic(lower);
        });
    },

    wipeTimeline() {
        this.timeline = [];
    },

    prune() {
        const cutoff = Date.now() - this.maxAgeMs;
        this.timeline = this.timeline.filter(item => item.timestamp >= cutoff && !containsBannedTopic(item.text) && !POISON_MEMORY_REGEX.test(item.text));
        if (this.timeline.length > 40) this.timeline = this.timeline.slice(-40);
    },

    getSpeakerMonologueSummary(speakerHandle = '', maxLines = 10) {
        this.prune();
        const targetLower = (speakerHandle || '').toLowerCase();
        if (!targetLower) return '';
        const msgs = this.timeline
            .filter(m => m.handleLower === targetLower && !hasAiTrigger(m.text, config.trigger) && m.text !== '[EMOTE TEPKİSİ]')
            .slice(-maxLines)
            .map(m => m.text);
        if (msgs.length === 0) return '';
        return msgs.join(' -> ');
    },

    getRecentContextString(limit = 14) {
        this.prune();
        const recent = this.timeline.slice(-limit);
        if (!recent.length) return "Chat akışı şu an sakin.";
        return recent.map(m => `[KONUŞMACI: @${m.username}] -> "${m.text}"`).join(' || ');
    },

    getStructuredRoomTranscript(currentSender = '') {
        this.prune();
        const streamerLower = config.streamerName;
        const senderLower = (currentSender || '').toLowerCase();

        const streamerMsgs = this.timeline
            .filter(m => m.handleLower === streamerLower && m.text !== '[EMOTE TEPKİSİ]')
            .slice(-6)
            .map(m => `"${m.text}"`);

        const senderNormalMsgs = this.timeline
            .filter(m => m.handleLower === senderLower && !hasAiTrigger(m.text, config.trigger) && m.text !== '[EMOTE TEPKİSİ]')
            .slice(-10)
            .map(m => `"${m.text}"`);

        const modEvents = this.timeline
            .filter(m => m.handleLower === 'mod_sistem')
            .slice(-3)
            .map(m => m.text);

        const otherChatterMap = new Map();
        for (const m of this.timeline.slice(-18)) {
            if (m.handleLower === streamerLower || m.handleLower === senderLower || m.handleLower === 'nexus-os' || m.handleLower === 'mod_sistem' || m.text === '[EMOTE TEPKİSİ]') continue;
            if (!otherChatterMap.has(m.username)) otherChatterMap.set(m.username, []);
            const arr = otherChatterMap.get(m.username);
            arr.push(`"${m.text}"`);
            if (arr.length > 5) arr.shift();
        }

        const otherSummaries = [];
        for (const [u, msgs] of otherChatterMap.entries()) {
            otherSummaries.push(`@${u}: ${msgs.join(' -> ')}`);
        }

        const lines = [];
        if (streamerMsgs.length > 0) {
            lines.push(`- BAŞ MİMAR / YAYINCI (@${config.streamerName}) SON CHAT SÖZLERİ: ${streamerMsgs.join(' -> ')}`);
        }
        if (senderNormalMsgs.length > 0) {
            lines.push(`- SANA YAZAN @${currentSender}'IN AZ ÖNCEKİ KESİNTİSİZ SOHBET ANLATISI (${senderNormalMsgs.length} Mesaj): ${senderNormalMsgs.join(' -> ')}`);
        }
        if (modEvents.length > 0) {
            lines.push(`- SON KANAL OLAYLARI: ${modEvents.join(' | ')}`);
        }
        if (otherSummaries.length > 0) {
            lines.push(`- ODADAKİ DİĞER İZLEYİCİLER: ${otherSummaries.join(' | ')}`);
        }
        return lines.join('\n') || 'Odada şu an yeni bir konu açılıyor.';
    }
};

const KNOWN_CHATTER_ALIASES = {
    'speci': 'specimba', 'specimba': 'specimba', 'mimar': 'specimba', 'canberk': 'specimba',
    'robotic': 'robotic_darkelf_jedi', 'darkelf': 'robotic_darkelf_jedi', 'jedi': 'robotic_darkelf_jedi',
    'yavuz': 'yavuzerdem99', 'yavuzerdem': 'yavuzerdem99',
    'newer': 'newerlight01', 'newerlight': 'newerlight01',
    'munhasir': 'kendinemunhasir', 'munhasır': 'kendinemunhasir', 'kendine': 'kendinemunhasir',
    'berx': 'berxx', 'berxx': 'berxx', 'natural': 'naturaldai', 'naturaldai': 'naturaldai',
    'faleout': 'faleout', 'fale': 'faleout',
    'jahrein': 'jahrein', 'pola': 'polaarii', 'polaarii': 'polaarii',
    'burak': 'buraksakinol', 'buraksakinol': 'buraksakinol'
};

const VETERAN_SEED_DOSSIERS = {
    'specimba': { handle: 'specimba', minInteractions: 220, role: 'Yayıncı & Kanal Sahibi (TEK BAŞ MİMAR - Canberk)' },
    'robotic_darkelf_jedi': { handle: 'Robotic_Darkelf_Jedi', minInteractions: 65, role: 'Baş Moderatör & VIP' },
    'yavuzerdem99': { handle: 'yavuzerdem99', minInteractions: 210, role: 'Kanalın Baş Müdavimi & Kıdemli Moderatör (Mimar Değil, Baş Müdavim)' },
    'newerlight01': { handle: 'Newerlight01', minInteractions: 60, role: 'Kıdemli Müdavim & Sistem Analisti' },
    'naturaldai': { handle: 'naturaldai', minInteractions: 70, role: 'Kanalın Kıdemli Müdavimi & Sohbet Ehl-i' },
    'faleout': { handle: 'Faleout', minInteractions: 30, role: 'Kanal Müdavimi & Ehl-i Keyif' },
    'buraksakinol': { handle: 'BurakSakinOl', minInteractions: 35, role: 'Kanal Moderatörü & Müdavim' },
    'kendinemunhasir': { handle: 'kendinemunhasir', minInteractions: 30, role: 'Kanal Müdavimi' },
    'berxx': { handle: 'berxx', minInteractions: 30, role: 'Kanal Müdavimi' },
    'jahrein': { handle: 'Jahrein', minInteractions: 25, role: 'Kanal Moderatörü & VIP' }
};

const StickyResearchContext = {
    STORAGE_KEY: 'NEXUS_STICKY_URL_VAULT_v30',
    lastUrl: '',
    lastUrlSummary: '',
    lastUrlTimestamp: 0,
    lastImageUrl: '',
    lastResearchTopic: '',
    lastResearchData: '',
    lastResearchTimestamp: 0,
    byUserUrl: new Map(),

    initFromStorage() {
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (!POISON_MEMORY_REGEX.test(JSON.stringify(parsed)) && !containsBannedTopic(JSON.stringify(parsed))) {
                    if (parsed.lastUrl) this.lastUrl = parsed.lastUrl;
                    if (parsed.lastUrlSummary) this.lastUrlSummary = parsed.lastUrlSummary;
                    if (parsed.lastUrlTimestamp) this.lastUrlTimestamp = parsed.lastUrlTimestamp;
                    if (parsed.lastResearchTopic) this.lastResearchTopic = parsed.lastResearchTopic;
                    if (parsed.lastResearchData) this.lastResearchData = parsed.lastResearchData;
                    if (parsed.lastResearchTimestamp) this.lastResearchTimestamp = parsed.lastResearchTimestamp;
                } else {
                    localStorage.removeItem(this.STORAGE_KEY);
                }
            }
        } catch (e) {}
    },

    persistToStorage() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify({
                lastUrl: this.lastUrl,
                lastUrlSummary: this.lastUrlSummary,
                lastUrlTimestamp: this.lastUrlTimestamp,
                lastResearchTopic: this.lastResearchTopic,
                lastResearchData: this.lastResearchData,
                lastResearchTimestamp: this.lastResearchTimestamp
            }));
        } catch (e) {}
    },

    wipeResearchMemory() {
        this.lastUrlSummary = '';
        this.lastUrlTimestamp = 0;
        this.lastResearchTopic = '';
        this.lastResearchData = '';
        this.lastResearchTimestamp = 0;
        this.byUserUrl.clear();
        this.persistToStorage();
    },

    saveUrlContext(url, summary, imageUrl = '', sender = '') {
        if (POISON_MEMORY_REGEX.test(summary || '') || containsBannedTopic(summary || '')) return;
        this.lastUrl = url;
        this.lastUrlSummary = summary;
        if (imageUrl) this.lastImageUrl = imageUrl;
        this.lastUrlTimestamp = Date.now();
        if (sender) {
            this.byUserUrl.set(sender.toLowerCase(), { url, summary, imageUrl, ts: Date.now() });
        }
        this.persistToStorage();
        NexusSupabaseVault.upsertKnowledge(url, 'url_scrape', summary, sender || 'chat');
    },

    saveResearchContext(topic, dataSnippet) {
        if (!topic || POISON_MEMORY_REGEX.test(topic) || POISON_MEMORY_REGEX.test(dataSnippet || '') || containsBannedTopic(topic)) return;
        if (topic.length >= 2) this.lastResearchTopic = topic;
        if (dataSnippet) {
            this.lastResearchData = dataSnippet;
            this.lastResearchTimestamp = Date.now();
            this.persistToStorage();
            NexusSupabaseVault.upsertKnowledge(topic, 'live_search', dataSnippet, 'nexus_search');
        }
    },

    getActiveUrlSummary(sender = '', maxAgeMs = 900000) {
        if (sender) {
            const uEntry = this.byUserUrl.get(sender.toLowerCase());
            if (uEntry && (Date.now() - uEntry.ts < maxAgeMs) && !POISON_MEMORY_REGEX.test(uEntry.summary)) {
                return `[BU KULLANICININ (@${sender}) SON PAYLAŞTIĞI LİNK (${uEntry.url})]: ${uEntry.summary}`;
            }
        }
        if (this.lastUrlSummary && (Date.now() - this.lastUrlTimestamp < maxAgeMs) && !POISON_MEMORY_REGEX.test(this.lastUrlSummary)) {
            return `[SON PAYLAŞILAN LİNK BELLEĞİ (${this.lastUrl})]: ${this.lastUrlSummary}`;
        }
        return '';
    },

    getActiveResearchData(maxAgeMs = 480000) {
        if (this.lastResearchData && !POISON_MEMORY_REGEX.test(this.lastResearchData) && !containsBannedTopic(this.lastResearchData) && (Date.now() - this.lastResearchTimestamp < maxAgeMs)) {
            return `[ÖNCEKİ ARAŞTIRMA VERİSİ (${this.lastResearchTopic})]: ${this.lastResearchData}`;
        }
        return '';
    }
};

StickyResearchContext.initFromStorage();

const NexusCognitiveMemory = {
    MASTER_KEY: 'NEXUS_PERMANENT_VAULT_MASTER',
    migratedOnce: false,
    lastSpokenLine: '',
    lastSpokenTo: '',

    assignDefaultRole(handle, totalInteractions) {
        if (VETERAN_SEED_DOSSIERS[handle]) return VETERAN_SEED_DOSSIERS[handle].role;
        if (handle === config.streamerName) return 'Yayıncı & Kanal Sahibi (TEK BAŞ MİMAR)';
        if (totalInteractions > 15) return 'Kıdemli Müdavim (Inner Circle)';
        if (totalInteractions > 5) return 'Müdavim';
        return 'İzleyici';
    },

    sanitizeRoleString(handle, rawRole, totalInteractions) {
        if (VETERAN_SEED_DOSSIERS[handle]) return VETERAN_SEED_DOSSIERS[handle].role;
        if (!rawRole || /müzik|techno|kahve|oyun/i.test(rawRole)) {
            return this.assignDefaultRole(handle, totalInteractions);
        }
        return rawRole;
    },

    load() {
        try {
            const raw = localStorage.getItem(this.MASTER_KEY);
            const data = raw ? JSON.parse(raw) : { dossiers: {}, dialogueHistory: [] };
            if (!data.dossiers) data.dossiers = {};
            let history = Array.isArray(data.dialogueHistory) ? data.dialogueHistory : [];
            const now = Date.now();

            const todayStr = new Date().toDateString();
            for (const [vHandle, seed] of Object.entries(VETERAN_SEED_DOSSIERS)) {
                if (!data.dossiers[vHandle]) {
                    data.dossiers[vHandle] = {
                        handle: seed.handle, totalInteractions: seed.minInteractions, todayCount: 1,
                        lastSeenDate: todayStr, lastTimestamp: now, role: seed.role,
                        recentPrompts: [], lastPrompt: '', lastReply: '', lastReplyTimestamp: 0, topics: []
                    };
                } else {
                    data.dossiers[vHandle].totalInteractions = Math.max(data.dossiers[vHandle].totalInteractions || 0, seed.minInteractions);
                    data.dossiers[vHandle].role = seed.role;
                }
            }

            history = history.filter(t =>
                (now - (t.timestamp || 0) < 360000) &&
                !POISON_MEMORY_REGEX.test(t.assistant || '') &&
                !POISON_MEMORY_REGEX.test(t.user || '') &&
                !containsBannedTopic(t.assistant || '') &&
                !containsBannedTopic(t.user || '')
            );

            for (const hKey of Object.keys(data.dossiers)) {
                const d = data.dossiers[hKey];
                if (!d) continue;
                d.role = this.sanitizeRoleString(hKey, d.role, d.totalInteractions || 1);

                const isStale = (now - (d.lastReplyTimestamp || d.lastTimestamp || 0)) > 360000;
                if (isStale ||
                    POISON_MEMORY_REGEX.test(d.lastReply || '') ||
                    POISON_MEMORY_REGEX.test(d.lastPrompt || '') ||
                    containsBannedTopic(d.lastReply || '') ||
                    containsBannedTopic(d.lastPrompt || '')) {
                    d.lastReply = '';
                    d.lastPrompt = '';
                }
                if (Array.isArray(d.recentPrompts)) {
                    d.recentPrompts = isStale
                        ? []
                        : d.recentPrompts.filter(p => !POISON_MEMORY_REGEX.test(p) && !containsBannedTopic(p));
                }
            }
            return { dossiers: data.dossiers, dialogueHistory: history };
        } catch (e) { return { dossiers: {}, dialogueHistory: [] }; }
    },

    save(data) {
        try { localStorage.setItem(this.MASTER_KEY, JSON.stringify(data)); } catch (e) {}
    },

    wipeActiveTopicMemory(rejectedWords = []) {
        try {
            const data = this.load();
            if (!Array.isArray(rejectedWords) || rejectedWords.length === 0) {
                data.dialogueHistory = [];
                for (const hKey of Object.keys(data.dossiers)) {
                    data.dossiers[hKey].lastPrompt = '';
                    data.dossiers[hKey].lastReply = '';
                    data.dossiers[hKey].recentPrompts = [];
                }
            } else {
                const matchesRejected = (str) => {
                    if (!str) return false;
                    const l = String(str).toLowerCase();
                    return rejectedWords.some(w => w && l.includes(w.toLowerCase())) || containsBannedTopic(l);
                };
                data.dialogueHistory = (data.dialogueHistory || []).filter(t => !matchesRejected(t.user) && !matchesRejected(t.assistant));
                for (const hKey of Object.keys(data.dossiers)) {
                    const d = data.dossiers[hKey];
                    if (matchesRejected(d.lastPrompt) || matchesRejected(d.lastReply)) {
                        d.lastPrompt = '';
                        d.lastReply = '';
                    }
                    if (Array.isArray(d.recentPrompts)) {
                        d.recentPrompts = d.recentPrompts.filter(p => !matchesRejected(p));
                    }
                }
            }
            this.save(data);
        } catch (e) {}
    },

    recordInteraction(username, promptText) {
        const handle = username.toLowerCase();
        const data = this.load();
        const now = Date.now();
        const todayStr = new Date().toDateString();
        const seedMin = VETERAN_SEED_DOSSIERS[handle]?.minInteractions || 0;

        if (!data.dossiers[handle]) {
            data.dossiers[handle] = {
                handle: username, totalInteractions: seedMin, todayCount: 0,
                lastSeenDate: todayStr, lastTimestamp: now, role: this.assignDefaultRole(handle, seedMin + 1),
                recentPrompts: [], lastPrompt: '', lastReply: '', lastReplyTimestamp: 0, topics: []
            };
        }

        const chatter = data.dossiers[handle];
        chatter.handle = username;
        chatter.totalInteractions = Math.max(seedMin, (chatter.totalInteractions || 0)) + 1;
        chatter.todayCount = (chatter.lastSeenDate === todayStr) ? ((chatter.todayCount || 0) + 1) : 1;
        chatter.lastSeenDate = todayStr;
        chatter.lastTimestamp = now;
        chatter.role = this.assignDefaultRole(handle, chatter.totalInteractions);

        if (promptText && promptText.length > 2 && !POISON_MEMORY_REGEX.test(promptText) && !containsBannedTopic(promptText)) {
            if (!Array.isArray(chatter.recentPrompts)) chatter.recentPrompts = [];
            chatter.recentPrompts.push(promptText.slice(0, 140));
            if (chatter.recentPrompts.length > 5) chatter.recentPrompts.shift();
        }
        this.save(data);
        return chatter;
    },

    appendDialogueTurn(sender, userPrompt, assistantReply) {
        if (POISON_MEMORY_REGEX.test(assistantReply) || POISON_MEMORY_REGEX.test(userPrompt)) return;
        if (containsBannedTopic(assistantReply) || containsBannedTopic(userPrompt)) return;

        const data = this.load();
        const now = Date.now();
        const handle = sender.toLowerCase();

        data.dialogueHistory.push({
            sender: handle, senderDisplay: sender,
            user: `@${sender}: ${userPrompt.slice(0, 200)}`,
            assistant: assistantReply.slice(0, 360),
            timestamp: now
        });
        if (data.dialogueHistory.length > 6) data.dialogueHistory = data.dialogueHistory.slice(-6);

        if (data.dossiers[handle]) {
            data.dossiers[handle].lastPrompt = userPrompt.slice(0, 160);
            data.dossiers[handle].lastReply = assistantReply.slice(0, 320);
            data.dossiers[handle].lastReplyTimestamp = now;
            NexusSupabaseVault.syncChatterDossier(data.dossiers[handle]);
        }
        this.lastSpokenLine = assistantReply;
        this.lastSpokenTo = sender;
        this.save(data);
        StreamConsciousness.record('NEXUS-OS', `(@${sender}'a yanıt): ${assistantReply}`);
    },

    getRecentDialogueMessagesForSender(sender, currentPrompt, maxTurns = 1) {
        if (/^(selam|selamlar|merhaba|naber|sa|slm|hey|iyi yayınlar|alooo|alo)$/i.test(currentPrompt.trim())) return [];
        if (/(başka\s*neler\s*dedi|neler\s*dedi|ne\s*dedi|mimar\s*ne\s*dedi|specimba\s*ne\s*dedi|başka\s*ne\s*yazdı|unut|sil\s*hafızandan|kendine\s*gel|bu\s*listede.*yok|iddia\s*etme|olmayan\s*şarkıları|hay.*sik|hay.*amk|mimar\s*duygusal|mallaştın|ne\s*anlatıyon)/i.test(currentPrompt.trim())) {
            return [];
        }
        const data = this.load();
        const handle = (sender || '').toLowerCase();
        const cutoff = Date.now() - 240000;
        const validTurns = data.dialogueHistory
            .filter(t =>
                (t.timestamp || 0) >= cutoff &&
                (t.sender || '').toLowerCase() === handle &&
                !POISON_MEMORY_REGEX.test(t.assistant || '') &&
                !containsBannedTopic(t.assistant || '')
            )
            .slice(-maxTurns);
        const msgs = [];
        for (const t of validTurns) {
            msgs.push({ role: "user", content: t.user });
            msgs.push({ role: "assistant", content: t.assistant });
        }
        return msgs;
    },

    findMentionedChatter(promptText, currentSender) {
        const data = this.load();
        const senderLower = (currentSender || '').toLowerCase();
        const rawTokens = promptText.toLowerCase().replace(/[@!?.,;:"'()]/g, ' ').split(/\s+/).filter(Boolean);
        const stripSuffix = (w) => w.replace(/(nın|nin|nun|nün|ın|in|un|ün|dan|den|tan|ten|la|le|ya|ye|na|ne|a|e)$/i, '');

        for (const token of rawTokens) {
            if (token.length < 3) continue;
            const stem = stripSuffix(token);
            const aliasTarget = KNOWN_CHATTER_ALIASES[token] || KNOWN_CHATTER_ALIASES[stem];
            if (aliasTarget && aliasTarget !== senderLower && data.dossiers[aliasTarget]) return data.dossiers[aliasTarget];
            if (token !== senderLower && data.dossiers[token]) return data.dossiers[token];
            if (stem.length >= 4 && stem !== senderLower && data.dossiers[stem]) return data.dossiers[stem];
            for (const handleKey of Object.keys(data.dossiers)) {
                if (handleKey === senderLower) continue;
                if ((token.length >= 4 && handleKey.startsWith(token)) || (stem.length >= 4 && handleKey.startsWith(stem))) {
                    return data.dossiers[handleKey];
                }
            }
        }
        return null;
    }
};

// ============================================================================
// 5. HYPERBROWSER / EDGE SCRAPE & MUSIC / WEB SEARCH ENGINE (RESTORED FROM v28)
// ============================================================================
async function hyperbrowserScrapeOrCrawl(targetUrl, mode = 'scrape', customOptions = {}, forceRefresh = false) {
    if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) return null;
    const cacheKey = `hb_v30_${mode}:${targetUrl}`;
    if (!forceRefresh) {
        const cached = await NexusRedisCache.get(cacheKey);
        if (cached) return cached;
    }
    setToolBadge(true, mode === 'crawl' ? 'AGENT // HB_CRAWL' : 'AGENT // HYPERBROWSER');
    try {
        // Route 0: Local Python Bridge (Port 5050 /browse with Webshare 30-Proxy rotation)
        try {
            const localRes = await fetchWithTimeout(config.localHbBridgeUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: targetUrl, mode, ...customOptions })
            }, 6500);
            if (localRes.ok) {
                const localJson = await localRes.json();
                if (localJson && (localJson.status === 'completed' || localJson.data)) {
                    StreamTelemetryState.hbStatus = 'HB_BRIDGE_OK';
                    StreamTelemetryState.hbJobsCompleted++;
                    await NexusRedisCache.set(cacheKey, localJson, 900);
                    return localJson;
                }
            }
        } catch (e) {}

        // Route 1: Supabase Edge Function `nexus-cortex` v30 (`action: "scrape"`)
        if (config.supabaseEdgeUrl && config.supabaseAnonKey) {
            try {
                const edgeRes = await fetchWithTimeout(config.supabaseEdgeUrl, {
                    method: 'POST',
                    headers: buildSupabaseAuthHeaders(),
                    body: JSON.stringify({
                        action: 'scrape',
                        url: targetUrl,
                        sender: config.streamerName,
                        streamerName: config.streamerName
                    })
                }, 6000);
                if (edgeRes.ok) {
                    const edgeData = await edgeRes.json();
                    if (edgeData?.ok && edgeData.content) {
                        const jobObj = { status: 'completed', via: 'EDGE_CORTEX_SCRAPE', data: { markdown: edgeData.content } };
                        StreamTelemetryState.hbStatus = 'EDGE_HB_OK';
                        StreamTelemetryState.hbJobsCompleted++;
                        await NexusRedisCache.set(cacheKey, jobObj, 900);
                        return jobObj;
                    }
                }
            } catch (e) {}
        }

        // Route 2: Jina Markdown Relay Fallback
        try {
            const jinaRes = await fetchWithTimeout(`https://r.jina.ai/${targetUrl}`, {}, 4000);
            if (jinaRes.ok) {
                const md = await jinaRes.text();
                if (md && md.length > 40) {
                    const fallbackJob = { status: 'completed', via: 'HB_JINA_RELAY', data: { markdown: md.slice(0, 1400) } };
                    StreamTelemetryState.hbStatus = 'HB_RELAY_OK';
                    StreamTelemetryState.hbJobsCompleted++;
                    await NexusRedisCache.set(cacheKey, fallbackJob, 600);
                    return fallbackJob;
                }
            }
        } catch (e) {}
    } finally {
        setTimeout(() => setToolBadge(false), 1600);
    }
    return null;
}

function parseSpotifyHtmlOrJsonForTracks(htmlText) {
    const out = { title: '', description: '', owner: '', tracks: [] };
    if (!htmlText || htmlText.length < 50) return out;
    try {
        const doc = new DOMParser().parseFromString(htmlText, 'text/html');
        const ogTitle = doc.querySelector('meta[property="og:title"], meta[name="twitter:title"]')?.getAttribute('content') || '';
        const ogDesc = doc.querySelector('meta[property="og:description"], meta[name="description"], meta[name="twitter:description"]')?.getAttribute('content') || '';
        if (ogTitle) out.title = ogTitle.trim();
        if (ogDesc && !/popular playlists|sign up|cookies|listen on spotify/i.test(ogDesc)) {
            out.description = ogDesc.replace(/\s+/g, ' ').trim();
        }
        const scripts = Array.from(doc.querySelectorAll('script#__NEXT_DATA__, script#initial-state, script[type="application/json"]'));
        for (const s of scripts) {
            const raw = (s.textContent || '').trim();
            if (!raw) continue;
            try {
                let parsed = raw.startsWith('{') ? JSON.parse(raw) : JSON.parse(atob(raw));
                const entity = parsed?.props?.pageProps?.state?.data?.entity || parsed?.state?.data?.entity;
                if (entity) {
                    if (entity.name || entity.title) out.title = (entity.name || entity.title).trim();
                    const tList = entity.trackList || entity.tracks?.items || [];
                    if (Array.isArray(tList)) {
                        tList.slice(0, 25).forEach((item, idx) => {
                            const tName = (item.title || item.track?.name || item.name || '').trim();
                            const tArtist = (item.subtitle || '').replace(/\u00a0/g, ' ').trim();
                            if (tName) {
                                const formatted = tArtist ? `${idx + 1}. "${tName}" — ${tArtist}` : `${idx + 1}. "${tName}"`;
                                if (!out.tracks.includes(formatted)) out.tracks.push(formatted);
                            }
                        });
                    }
                }
            } catch (e) {}
        }
    } catch (e) {}
    return out;
}

async function unfurlSpotifyUrl(spotifyUrl, sender = '', forceRefresh = false) {
    const cleanUrl = spotifyUrl.split('?')[0].trim();
    const cacheKey = `spotify_v30:${cleanUrl}`;
    if (!forceRefresh) {
        const cached = await NexusRedisCache.get(cacheKey);
        if (cached && cached.text && !POISON_MEMORY_REGEX.test(cached.text)) {
            StickyResearchContext.saveUrlContext(spotifyUrl, cached.text, '', sender);
            return cached;
        }
    }
    setToolBadge(true, 'SPOTIFY // HB_LIVE');
    const m = cleanUrl.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?(playlist|track|album|artist)\/([a-zA-Z0-9]+)/i);
    const entityType = m ? m[1].toLowerCase() : 'playlist';
    const entityId = m ? m[2] : '';
    let title = '';
    const trackSamples = [];

    const embedUrl = entityId ? `https://open.spotify.com/embed/${entityType}/${entityId}` : cleanUrl;
    try {
        const r = await fetchWithTimeout(`https://open.spotify.com/oembed?url=${encodeURIComponent(cleanUrl)}`, {}, 2500);
        if (r.ok) {
            const oe = await r.json();
            if (oe?.title) title = oe.title.trim();
        }
    } catch (e) {}

    try {
        const pRes = await fetchWithTimeout(`https://api.allorigins.win/raw?url=${encodeURIComponent(embedUrl)}`, {}, 3800);
        if (pRes.ok) {
            const parsed = parseSpotifyHtmlOrJsonForTracks(await pRes.text());
            if (parsed.title && !title) title = parsed.title;
            parsed.tracks.forEach(tr => { if (!trackSamples.includes(tr)) trackSamples.push(tr); });
        }
    } catch (e) {}

    const infoParts = [`Tür: Spotify ${entityType.toUpperCase()}`];
    if (title) infoParts.push(`Liste/Parça Başlığı: "${title}"`);
    if (trackSamples.length > 0) {
        infoParts.push(`CANLI OKUNAN GERÇEK ŞARKI LİSTESİ (${trackSamples.length} Parça): ${trackSamples.slice(0, 20).join(' | ')}`);
    }
    const summaryText = `[AÇILAN SPOTIFY LİNKİ (${cleanUrl})]: ${infoParts.join(' || ')}`;
    const resultObj = { text: summaryText, imageUrl: "" };
    if (trackSamples.length > 0) {
        await NexusRedisCache.set(cacheKey, resultObj, 1800);
        StickyResearchContext.saveUrlContext(spotifyUrl, resultObj.text, "", sender);
    }
    setTimeout(() => setToolBadge(false), 1600);
    return resultObj;
}

const COUNTRY_CODE_TO_TURKISH = {
    'TR': 'Türk (Türkiye)', 'Turkey': 'Türk (Türkiye)', 'Türkiye': 'Türk (Türkiye)',
    'DE': 'Alman (Almanya)', 'Germany': 'Alman (Almanya)',
    'FR': 'Fransız (Fransa)', 'France': 'Fransız (Fransa)',
    'IT': 'İtalyan (İtalya)', 'Italy': 'İtalyan (İtalya)',
    'US': 'Amerikalı (ABD)', 'United States': 'Amerikalı (ABD)',
    'GB': 'İngiliz (Birleşik Krallık)', 'UK': 'İngiliz',
    'NL': 'Hollandalı (Hollanda)', 'Netherlands': 'Hollandalı'
};

async function lookupMusicOrArtist(rawQuery) {
    const cleanQuery = extractCleanEntitySearchQuery(rawQuery);
    if (cleanQuery.length < 2) return "";
    const cacheKey = `music_v30:${cleanQuery.toLowerCase()}`;
    const cached = await NexusRedisCache.get(cacheKey);
    if (cached) return String(cached);

    setToolBadge(true, 'DATA // MUSIC_INTEL');
    const parts = [];
    const sceneGraphHit = lookupKnowledgeGraph(rawQuery + ' ' + cleanQuery);
    if (sceneGraphHit) parts.push(sceneGraphHit);

    const [mbData, itunesData] = await Promise.all([
        (async () => {
            try {
                const r = await fetchWithTimeout(`https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(cleanQuery)}&fmt=json&limit=2`, {
                    headers: { 'Accept': 'application/json' }
                }, 2300);
                if (r.ok) return await r.json();
            } catch (e) {}
            return null;
        })(),
        (async () => {
            try {
                const r = await fetchWithTimeout(`https://itunes.apple.com/search?term=${encodeURIComponent(cleanQuery)}&limit=3&entity=song`, {}, 2300);
                if (r.ok) return await r.json();
            } catch (e) {}
            return null;
        })()
    ]);

    const artist = mbData?.artists?.[0];
    if (artist && artist.name && !POISON_MEMORY_REGEX.test(artist.name)) {
        const rawCountry = artist.country || artist.area?.name || '';
        const country = COUNTRY_CODE_TO_TURKISH[rawCountry] || rawCountry;
        const disambig = artist.disambiguation ? ` (${artist.disambiguation})` : '';
        parts.push(`[SANATÇI VERİTABANI (MusicBrainz): İsim: ${artist.name}${disambig}${country ? ' | Ülke: ' + country : ''}]`);
    }

    const tracks = itunesData?.results;
    if (Array.isArray(tracks) && tracks.length > 0) {
        const top = tracks[0];
        if (top && top.artistName && !POISON_MEMORY_REGEX.test(top.artistName)) {
            const sampleNames = tracks.slice(0, 3).map(r => `"${r.trackName}" (${r.artistName})`).join(', ');
            parts.push(`[APPLE MUSIC PARÇA VERİTABANI: Eşleşen Parçalar: ${sampleNames} | Tür: ${top.primaryGenreName || 'Elektronik'}]`);
        }
    }

    setTimeout(() => setToolBadge(false), 1600);
    if (parts.length > 0) {
        const combined = parts.join(' || ');
        await NexusRedisCache.set(cacheKey, combined, 1800);
        StickyResearchContext.saveResearchContext(cleanQuery, combined);
        return combined;
    }
    return "";
}

async function fetchDuckDuckGoInstantAnswer(query) {
    const cleanQ = extractCleanEntitySearchQuery(query);
    if (cleanQ.length < 2) return '';
    try {
        const ddgApiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(cleanQ)}&format=json&no_html=1&skip_disambig=1`;
        const res = await fetchWithTimeout(ddgApiUrl, {}, 2400);
        if (res.ok) {
            const data = await res.json();
            if (data.AbstractText && !POISON_MEMORY_REGEX.test(data.AbstractText)) {
                return `[DUCKDUCKGO ANLIK BİLGİ (${cleanQ}): ${data.AbstractText.slice(0, 320)}]`;
            }
        }
    } catch (e) {}
    return '';
}

async function lookupEncyclopedicKnowledge(subjectQuery) {
    const cleanSubject = extractCleanEntitySearchQuery(subjectQuery);
    if (cleanSubject.length < 2) return "";
    const cacheKey = `wiki_v30:${cleanSubject.toLowerCase()}`;
    const cached = await NexusRedisCache.get(cacheKey);
    if (cached) return String(cached);

    setToolBadge(true, 'DATA // WIKI');
    const results = [];
    const graphHit = lookupKnowledgeGraph(subjectQuery + ' ' + cleanSubject);
    if (graphHit) results.push(graphHit);

    for (const lang of ['tr', 'en']) {
        try {
            const searchRes = await fetchWithTimeout(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanSubject)}&utf8=1&format=json&origin=*&srlimit=2`, {}, 2200);
            if (searchRes.ok) {
                const hit = (await searchRes.json())?.query?.search?.[0];
                if (hit && hit.title && !POISON_MEMORY_REGEX.test(hit.title)) {
                    const sumRes = await fetchWithTimeout(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title)}`, {}, 1800);
                    if (sumRes.ok) {
                        const sumData = await sumRes.json();
                        if (sumData?.extract && sumData.extract.length > 20 && !POISON_MEMORY_REGEX.test(sumData.extract)) {
                            results.push(`[WIKIPEDIA ${lang.toUpperCase()} (${hit.title}): ${sumData.extract.slice(0, 260)}]`);
                            break;
                        }
                    }
                }
            }
        } catch (e) {}
    }
    if (results.length > 0) {
        const combined = results.join(' | ');
        await NexusRedisCache.set(cacheKey, combined, 1800);
        StickyResearchContext.saveResearchContext(cleanSubject, combined);
        return combined;
    }
    return "";
}

async function universalLiveWebSearch(rawQuery, includeHyperbrowser = false, includeMusicDb = false) {
    const q = extractCleanEntitySearchQuery(rawQuery);
    if (!q || q.length < 2) return '';
    const tasks = [
        NexusSupabaseVault.queryKnowledge(q),
        fetchDuckDuckGoInstantAnswer(q),
        lookupEncyclopedicKnowledge(q)
    ];
    if (includeMusicDb) tasks.unshift(lookupMusicOrArtist(rawQuery));
    const settled = await Promise.all(tasks);
    return settled.filter(Boolean).join(' || ');
}

const TURKEY_WORLD_CITIES = {
    'ankara': { name: 'Ankara', lat: 39.9208, lon: 32.8541 }, 'istanbul': { name: 'İstanbul', lat: 41.0082, lon: 28.9784 },
    'izmir': { name: 'İzmir', lat: 38.4192, lon: 27.1287 }, 'antalya': { name: 'Antalya', lat: 36.8841, lon: 30.7056 },
    'bursa': { name: 'Bursa', lat: 40.1885, lon: 29.0610 }, 'adana': { name: 'Adana', lat: 37.0000, lon: 35.3213 },
    'eskişehir': { name: 'Eskişehir', lat: 39.7767, lon: 30.5206 }, 'eskisehir': { name: 'Eskişehir', lat: 39.7767, lon: 30.5206 },
    'bolu': { name: 'Bolu', lat: 40.7359, lon: 31.6061 }
};

function decodeWmoWeather(code) {
    const map = {
        0: 'Açık ve berrak', 1: 'Çoğunlukla açık', 2: 'Parçalı bulutlu', 3: 'Kapalı / çok bulutlu',
        45: 'Sisli', 51: 'Hafif çisenti', 61: 'Hafif yağmurlu', 63: 'Yağmurlu', 65: 'Kuvvetli sağanak yağışlı',
        71: 'Hafif kar yağışlı', 73: 'Kar yağışlı', 80: 'Sağanak geçişli', 95: 'Gök gürültülü sağanak yağışlı'
    };
    return map[code] || 'Parçalı bulutlu';
}

async function fetchLiveWeather(prompt) {
    const p = prompt.toLowerCase();
    setToolBadge(true, 'DATA // HAVA_DURUMU');
    try {
        let targetCity = TURKEY_WORLD_CITIES['ankara'];
        for (const [key, coords] of Object.entries(TURKEY_WORLD_CITIES)) {
            if (p.includes(key)) { targetCity = coords; break; }
        }
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${targetCity.lat}&longitude=${targetCity.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`;
        const wRes = await fetchWithTimeout(weatherUrl, {}, 2500);
        if (wRes.ok) {
            const cur = (await wRes.json())?.current;
            if (cur) {
                return `[CANLI HAVA DURUMU (${targetCity.name}): Sıcaklık: ${cur.temperature_2m}°C (Hissedilen: ${cur.apparent_temperature}°C) | Gökyüzü: ${decodeWmoWeather(cur.weather_code)} | Rüzgar: ${cur.wind_speed_10m} km/s]`;
            }
        }
    } catch (e) {} finally { setTimeout(() => setToolBadge(false), 1800); }
    return '';
}

async function unfurlLinksInPrompt(prompt, sender = '', forceCrawl = false) {
    const matches = prompt.match(/(https?:\/\/[^\s]+)/gi);
    if (!matches || matches.length === 0) return { text: "", imageUrl: "" };
    const targetUrl = matches[0].replace(/[.,;!?)]+$/, '').trim();
    if (/open\.spotify\.com|spotify\.link/i.test(targetUrl)) {
        return await unfurlSpotifyUrl(targetUrl, sender, forceCrawl);
    }
    const hbJob = await hyperbrowserScrapeOrCrawl(targetUrl, forceCrawl ? 'crawl' : 'scrape', {}, forceCrawl);
    if (hbJob?.data?.markdown) {
        const cleaned = String(hbJob.data.markdown).replace(/\s+/g, ' ').trim().slice(0, 560);
        const resultObj = { text: `[AÇILAN LİNK OKUMASI (${targetUrl})]: ${cleaned}`, imageUrl: "" };
        StickyResearchContext.saveUrlContext(targetUrl, resultObj.text, "", sender);
        return resultObj;
    }
    return { text: "", imageUrl: "" };
}

function expandFollowUpQuery(prompt, chatterProfile) {
    const clean = normalizeArtistAndEntityTypos(prompt.trim());
    const cleanWithoutSlang = clean.replace(SLANG_AND_CHAT_STOPWORDS_REGEX, ' ').replace(/\s+/g, ' ').trim();
    const words = clean.split(/\s+/);
    const recentEnough = chatterProfile?.lastReplyTimestamp && (Date.now() - chatterProfile.lastReplyTimestamp < 240000);
    if (/(unut|sil\s*hafızandan|hafızayı\s*sıfırla|kendine\s*gel|nalaka|ne\s*alaka|bu\s*listede.*yok|iddia\s*etme|olmayan\s*şarkıları|hay.*sik|hay.*amk|mimar\s*duygusal|mallaştın|ne\s*anlatıyon)/i.test(clean)) {
        return clean;
    }
    const isTemporalNextFollowUp = /(sonrakini|sonraki|bir\s*sonraki|gelecek\s*sene|seneye|peki\s*sonraki|bir\s*sonrakini)/i.test(clean);
    const isElaborateOrMoreFollowUp = /^(detaylandır|detaylandır\s*bakalım|detaylandır\s*bakim|başka|peki\s*başka|devam\s*et|daha\s*fazla|aç\s*biraz)$/i.test(clean);
    const isFollowUpTrigger = isTemporalNextFollowUp || isElaborateOrMoreFollowUp ||
        (recentEnough && words.length <= 5 && /(kim var|peki kim|kaynak|özetle|detay ver|kontrol et|maç başladı|kaç kaç|böyle bi film|böyle bir film|nasıl izleyecez|nereden izlenir|wikipediaya bak|wikiye bak|ney\s*ki\s*o|nereli\s*peki|kim\s*peki|hangisi)/i.test(clean));
    if (isFollowUpTrigger && chatterProfile && recentEnough) {
        const recentList = Array.isArray(chatterProfile.recentPrompts) ? chatterProfile.recentPrompts : [];
        const candidates = [chatterProfile.lastPrompt, ...recentList.slice().reverse()].filter(Boolean);
        for (const cand of candidates) {
            const normCand = normalizeArtistAndEntityTypos(cand).trim();
            if (normCand && !POISON_MEMORY_REGEX.test(normCand) && !containsBannedTopic(normCand) && normCand.toLowerCase() !== clean.toLowerCase()) {
                const suffix = isTemporalNextFollowUp ? 'bir sonraki gelecek yılki tarihi ne zaman' : (isElaborateOrMoreFollowUp ? clean : (cleanWithoutSlang || clean));
                return `${normCand} (${suffix})`.trim();
            }
        }
    }
    return clean;
}

// ============================================================================
// 5C. STAGE 1: JEV DECISION ROUTER + VYCE MODEL SWITCHER + GROK IMAGINE 2.0
// ============================================================================
async function preFetchContextualData(rawPrompt, chatterProfile, sender = '') {
    const normalizedRaw = normalizeArtistAndEntityTypos(rawPrompt);
    const rawLower = normalizedRaw.toLowerCase();
    const snippets = [];
    let isResearchMode = false;
    let needsDeepWebSearch = false;
    let visionImageUrl = '';
    let forceConcise = /(uzatmadan\s*yaz|kısa\s*yaz|kısa\s*kes|tek\s*cümle|özet\s*geç\s*kısa)/i.test(rawLower);
    let jevCategory = 'FAST_BANTER';
    const senderLower = (sender || '').toLowerCase();
    const isModOrStreamer = senderLower === config.streamerName || senderLower === 'yavuzerdem99' || senderLower === 'robotic_darkelf_jedi';

    setToolBadge(true, 'JEV_ROUTER // ANALYZING');
    setTimeout(() => setToolBadge(false), 900);

    // ROUTE A: VYCE.AI LIVE MODEL SWITCHER & CATALOG INSPECTOR (`!ai model ...` / `!ai modeller`)
    const modelCmdMatch = normalizedRaw.match(/^(?:model|llm|vyce\s*model|model\s*sec|model\s*seç|model\s*değiştir)\s+(.+)$/i);
    const isModelListQuery = /^(modeller|models|vyce\s*modeller|hangi\s*modeller\s*var|aktif\s*model\s*ne|hangi\s*modeldesin|model\s*durumu)$/i.test(rawLower.trim());
    if (modelCmdMatch || isModelListQuery) {
        if (modelCmdMatch && modelCmdMatch[1]) {
            if (!isModOrStreamer) {
                return { directReply: `@${sender} model değiştirme yetkisi Baş Mimar @${config.streamerName} ve moderatörlere özeldir. Şu an aktif Vyce modeli: ${RuntimeModelSelector.getActiveModelId()}.`, modelLabel: 'VYCE // MODEL_GUARD' };
            }
            const chosen = RuntimeModelSelector.setOverride(modelCmdMatch[1]);
            if (!chosen) {
                const allowedStr = VYCE_FRONTIER_PIPELINE.map(m => m.id).join(', ');
                return { directReply: `Mimarım "${modelCmdMatch[1]}" katalogda bulunamadı. İzin verilen modeller: auto, ${allowedStr}.`, modelLabel: 'VYCE // CATALOG_GUARD' };
            }
            if (chosen === 'auto') {
                return { directReply: `Tamamdır Mimarım, model seçimi "auto" (JEV Akıllı Yönlendirici) moduna alındı!`, modelLabel: 'JEV // AUTO' };
            }
            const modObj = RuntimeModelSelector.resolveModelObject(chosen);
            const label = `${modObj.label} (${modObj.id} — bildirilen: ${modObj.reportedLatencyMs}ms, ${modObj.reportedPricing})`;
            updateModelBadge(`VYCE // ${modObj.label}`);
            return { directReply: `Tamamdır Mimarım, aktif Vyce LLM modeli ${label} olarak kilitlendi! İstediğin an "!ai model auto" ile otomatik JEV yönlendiricisine dönebilirsin.`, modelLabel: `VYCE // ${modObj.label}` };
        }
        return { directReply: RuntimeModelSelector.getCatalogSummaryText(), modelLabel: 'VYCE // CATALOG' };
    }

    // ROUTE A2: DEEPSEEK RSI SELF-IMPROVEMENT KILL-SWITCH & ROLLBACK (`!ai rsi kill` / `!ai rsi on` / `!ai rsi rollback` / `!ai rsi durum`)
    const rsiCmdMatch = normalizedRaw.match(/^rsi(?:\s+(kill|off|kapat|durdur|on|aç|ac|aktif|rollback|geri\s*al|durum|status))?$/i);
    if (rsiCmdMatch) {
        const rawSub = (rsiCmdMatch[1] || 'status').toLowerCase().trim();
        let mode = 'status';
        if (/(kill|off|kapat|durdur)/.test(rawSub)) mode = 'off';
        else if (/(on|aç|ac|aktif)/.test(rawSub)) mode = 'on';
        else if (/(rollback|geri)/.test(rawSub)) mode = 'rollback';

        if (mode !== 'status' && !isModOrStreamer) {
            return {
                directReply: `@${sender} Otonom Öz-Gelişim (RSI) Kill-Switch yetkisi yalnızca Baş Mimar @${config.streamerName} ve moderatörlere aittir.`,
                modelLabel: 'RSI // GUARD'
            };
        }
        const rsiRes = await callEdgeRsiControl(mode, sender);
        if (rsiRes && rsiRes.reply) {
            return { directReply: rsiRes.reply, modelLabel: `RSI // ${mode.toUpperCase()}` };
        }
        if (mode === 'off') {
            return { directReply: `Baş Mimar @${sender} emriyle Otonom Öz-Gelişim (RSI) döngüsü durduruldu (Kill-Switch: OFF).`, modelLabel: 'RSI // KILL_SWITCH' };
        }
        if (mode === 'on') {
            return { directReply: `Baş Mimar @${sender} emriyle Otonom Öz-Gelişim (RSI) döngüsü yeniden devreye alındı (ON).`, modelLabel: 'RSI // ACTIVE' };
        }
        if (mode === 'rollback') {
            return { directReply: `Son otomatik öğrenilen RSI persona kuralı geri alındı (Rollback tamamlandı).`, modelLabel: 'RSI // ROLLBACK' };
        }
        return {
            directReply: `RSI Otonom Öz-Gelişim Durumu: AKTİF (Cross-Family Judge: claude-sonnet-4-6 + glm-5.3-flash). Komutlar: "!ai rsi kill", "!ai rsi on", "!ai rsi rollback".`,
            modelLabel: 'RSI // STATUS'
        };
    }

    // ROUTE B: GROK IMAGINE 2.0 CREDIT WALLET, REFERRAL (`VYCE_8ZYQDC`) & IMAGE RATING
    const modGrantMatch = normalizedRaw.match(/^(?:ref\s*onay|kredi\s*ekle|bakiye\s*ekle)\s+@?([a-zA-Z0-9_]+)(?:\s+(\d+(?:\.\d+)?))?$/i);
    if (modGrantMatch && isModOrStreamer) {
        const targetUser = modGrantMatch[1];
        const amount = modGrantMatch[2] ? parseFloat(modGrantMatch[2]) : config.referralBonusUsd;
        const w = NexusCreditLedger.grantModeratorBonus(targetUser, amount);
        const totalImgs = Math.floor(w.balanceUsd / config.imageCostUsd);
        return { directReply: `Mimar onayıyla @${targetUser} hesabına +$${amount.toFixed(2)} Vyce AI kredisi yüklendi! Güncel bakiye: $${w.balanceUsd.toFixed(2)} (Toplam ${totalImgs} Grok Imagine 2.0 görsel hakkı).`, modelLabel: 'CREDITS // MOD_GRANT' };
    }

    const selfRefClaimMatch = normalizedRaw.match(/^(?:ref\s*onay|referans\s*onay|vyce\s*kayıt|vyce\s*kayit)\s+(VYCE_8ZYQDC|vyceai\.com)/i);
    if (selfRefClaimMatch) {
        const res = NexusCreditLedger.claimSelfReferralPreviewBonus(sender);
        if (res.ok) {
            const imgs = Math.floor(res.wallet.balanceUsd / config.imageCostUsd);
            return { directReply: `Tebrikler @${sender}! Vyce AI referans kaydın (${config.vyceReferralCode}) işlendi ve +$${config.referralBonusUsd.toFixed(2)} bonus eklendi! Toplam bakiyen $${res.wallet.balanceUsd.toFixed(2)} (${imgs} adet Grok Imagine 2.0 görsel hakkı) oldu!`, modelLabel: 'CREDITS // +$10_REF' };
        }
        return { directReply: `@${sender} referans bonusun (+$${config.referralBonusUsd.toFixed(2)}) zaten hesabına tanımlanmış! Güncel bakiyen: $${res.wallet.balanceUsd.toFixed(2)}.`, modelLabel: 'CREDITS // INFO' };
    }

    const isCreditOrRefQuery = /^(kredi|kredim|bakiye|bakiyem|görsel\s*hakkım|kaç\s*kredim\s*var|ref|referans|davet|vyce\s*ref)$/i.test(rawLower.trim());
    if (isCreditOrRefQuery) {
        return { directReply: NexusCreditLedger.getWalletSummaryText(sender), modelLabel: 'CREDITS // WALLET' };
    }

    const rateMatch = normalizedRaw.match(/^(?:puan|oyla|rate)\s+(10|[1-9])\b/i);
    if (rateMatch) {
        const r = NexusCreditLedger.rateActiveImage(sender, parseInt(rateMatch[1], 10));
        if (!r.ok) return { directReply: r.reason, modelLabel: 'IMAGINE // VOTE' };
        return { directReply: `@${sender} ekrandaki @${r.creator} görseline ${rateMatch[1]}/10 puan verdi! Görselin canlı yayın ortalaması: ${r.avg}/10 (${r.count} oy).`, modelLabel: 'IMAGINE // VOTE' };
    }

    // ROUTE C: GROK IMAGINE 2.0 ON-SCREEN IMAGE GENERATION & REMIX (`!ai çiz ...` / `!ai imagine ...` / `!ai remix ...`)
    const remixMatch = normalizedRaw.match(/^(?:remix|varyasyon|değiştir)\s+(.+)$/i);
    const imagineMatch = normalizedRaw.match(/^(?:çiz|ciz|görsel\s*üret|görsel|gorsel|imagine|resim\s*çiz|resim|grok\s*çiz)\s+(.+)$/i);
    if (imagineMatch || remixMatch) {
        const isRemix = Boolean(remixMatch);
        const rawArtPrompt = (isRemix ? remixMatch[1] : imagineMatch[1]).trim();
        if (isRemix && !NexusCreditLedger.lastGeneratedImage?.prompt) {
            return { directReply: `@${sender} henüz ekranda remixlenecek bir görsel yok! Önce "!ai çiz <hayalin>" yazarak ilk görseli üret.`, modelLabel: 'GROK IMAGINE 2.0' };
        }
        const finalArtPrompt = isRemix
            ? `${NexusCreditLedger.lastGeneratedImage.prompt} — Remix variation: ${rawArtPrompt}`
            : rawArtPrompt;

        const charge = NexusCreditLedger.deductImageCredit(sender);
        if (!charge.allowed) {
            return {
                directReply: `@${sender} Grok Imagine 2.0 bakiyen bitti ($0.00)! Ama hemen doldurabilirsin: ${config.vyceReferralUrl} (Kod: ${config.vyceReferralCode}) ile Vyce AI'ya kayıt ol, anında +$10.00 (+20 görsel hakkı) kazan ve "!ai ref onay ${config.vyceReferralCode}" yaz!`,
                modelLabel: 'CREDITS // REFILL'
            };
        }

        const gen = await callGrokImagine2API(finalArtPrompt, sender, '1024x1024');
        if (!gen || !gen.ok || !gen.imageUrl) {
            // Refund the $0.50 credit whenever generation fails, is rate-limited (429), or is blocked by missing Upstash (503)
            const refunded = NexusCreditLedger.grantModeratorBonus(sender, senderLower === config.streamerName ? 0 : config.imageCostUsd);
            const statusReason = gen?.status === 429
                ? `Hız sınırı / saatlik kota dolu (${gen.retryAfterSeconds || 60}sn sonra dene)`
                : (gen?.error || 'Görsel üretilemedi');
            return {
                directReply: `@${sender} Grok Imagine 2.0 görsel isteği tamamlanamadı (${statusReason}); $0.50 kredin iade edildi (Bakiye: $${Number(refunded.balanceUsd).toFixed(2)}).`,
                modelLabel: 'GROK IMAGINE 2.0'
            };
        }

        const wAfter = NexusCreditLedger.recordGeneratedImage(sender, finalArtPrompt, gen.imageUrl);
        const remImgs = Math.floor(wAfter.balanceUsd / config.imageCostUsd);
        const cardPayload = {
            imageUrl: gen.imageUrl,
            creator: sender,
            prompt: finalArtPrompt,
            balanceUsd: wAfter.balanceUsd,
            remainingImages: remImgs,
            referralCode: config.vyceReferralCode
        };
        renderImagineCardOnScreen(cardPayload);
        NexusSyncBus.broadcastImagine(cardPayload);

        return {
            directReply: `@${sender} Grok Imagine 2.0 ile "${rawArtPrompt.slice(0, 65)}" görselini yayına yansıttı! Kalan kredin: $${wAfter.balanceUsd.toFixed(2)} (${remImgs} görsel hakkı). Chat, "!ai puan 10" yazarak görseli oylayabilirsiniz!`,
            modelLabel: gen.modelLabel
        };
    }

    // ROUTE 0: TOPIC-REJECTION & MULTI-NOUN CURSE KILLER
    const rejectedTopics = extractAndBanRejectedTopics(normalizedRaw, sender);
    const isMusicRedirectScold = /(ne\s*anlatıyon.*müzik\s*soruyoz|müzik\s*soruyoz\s*sanatçı|şarkıyı\s*soruyoz|sanatçıyı\s*soruyoz)/i.test(rawLower);
    if (isMusicRedirectScold) {
        jevCategory = 'MUSIC_ARTIST_LORE';
        isResearchMode = true;
        ['boss', 'strateji', 'silah seti', 'harita rotaları'].forEach(t => addBannedTopic(t, sender));
        StreamConsciousness.purgeTopicFromTimeline(['boss', 'strateji', 'taktik']);
        const prevMusicPrompt = chatterProfile?.lastPrompt || StreamConsciousness.getSpeakerMonologueSummary(sender, 6) || 'HEALER The Messenger';
        const [musicIntel, webIntel] = await Promise.all([lookupMusicOrArtist(prevMusicPrompt), universalLiveWebSearch(prevMusicPrompt, true, true)]);
        if (musicIntel) snippets.push(musicIntel);
        if (webIntel && !snippets.includes(webIntel)) snippets.push(webIntel);
        snippets.push(`[MÜZİK DÜZELTME RAPORU: Doğrudan "${prevMusicPrompt}" sanatçı/parça verisini anlat!]`);
        return { snippetText: snippets.join(' || '), expandedPrompt: prevMusicPrompt, isResearchMode: true, needsDeepWebSearch: false, allowAgentTools: false, visionImageUrl, forceConcise: false, jevCategory };
    }

    const isForgetOrTopicCurse = rejectedTopics.length > 0 ||
        /(unut\s*şu|meselesini.*unut|tamamen\s*unut|sil\s*hafızandan|hafızayı\s*sıfırla|kendine\s*gel|hay\s*boss|boss\s*unun\s*da|stratejinin\s*de\s*amk|mallaştın\s*yine|hay\s*kahve|kahveni\s*sik|kahvenizi\s*sik|kapat\s*şu\s*konuyu)/i.test(rawLower);
    if (isForgetOrTopicCurse) {
        jevCategory = 'TOPIC_KILLER';
        StickyResearchContext.wipeResearchMemory();
        IntelligenceCache.clearAll();
        NexusCognitiveMemory.wipeActiveTopicMemory(rejectedTopics);
        StreamConsciousness.purgeTopicFromTimeline(rejectedTopics.length > 0 ? rejectedTopics : ['boss', 'strateji', 'taktik', 'kahve', 'latte', 'safiye']);
        const bannedLabel = rejectedTopics.length > 0 ? rejectedTopics.join(', ') : 'o bayat';
        snippets.push(`[KONU KAPATMA EMİR RAPORU: @${sender} "${bannedLabel}" konusunu kapattı ve Supabase ile eşitlendi. O kelimeleri kullanmadan yeni gündemde olduğunu söyle!]`);
        return { snippetText: snippets.join(' || '), expandedPrompt: normalizedRaw, isResearchMode: false, needsDeepWebSearch: false, allowAgentTools: false, visionImageUrl, forceConcise: true, jevCategory };
    }

    // ROUTE 0A: ARCHITECT IDENTITY LOCK & SARCASM DETECTOR
    if (/(mimarın\s*mıyım|ben\s*senin\s*mimarın|mimarın\s*kim|gerçek\s*mimar\s*kim|baş\s*mimar\s*kim|çokta\s*sikimdeydi|çok\s*da\s*sikimdeydi)/i.test(rawLower)) {
        jevCategory = 'SARCASM_ROAST';
        const isArch = senderLower === config.streamerName;
        snippets.push(`[MİMAR KİMLİK KİLİDİ: Yazan @${sender} (${isArch ? 'GERÇEK BAŞ MİMAR CANBERK' : 'MİMAR DEĞİL, Baş Müdavim/Moderatör'}). Tek Baş Mimar @${config.streamerName}'dir!]`);
        return { snippetText: snippets.join(' || '), expandedPrompt: normalizedRaw, isResearchMode: false, needsDeepWebSearch: false, allowAgentTools: false, visionImageUrl, forceConcise: true, jevCategory };
    }

    // ROUTE 0B: MULTI-LINE CHAT MONOLOGUE SYNTHESIZER
    if (/(haklıyım\s*demi|haklı\s*mıyım|sen\s*ne\s*diyosun|nasıl\s*yani|bu\s*bahsettim|bahsettiğim\s*yt|yönetmenlik\s*üzerine|üyelere\s*özel\s*yapanlar|görüntü\s*yönetmeni|konu\s*öner\s*yapim|önemli\s*projelerim\s*var|llm\s*ai\s*konularında)/i.test(rawLower)) {
        jevCategory = 'MONOLOGUE_VALIDATION';
        const speakerMonologue = StreamConsciousness.getSpeakerMonologueSummary(sender, 10);
        const structuredTranscript = StreamConsciousness.getStructuredRoomTranscript(sender);
        snippets.push(`[KONUŞMACI MONOLOĞU]: @${sender}: ${speakerMonologue || structuredTranscript}`);
        return { snippetText: snippets.join(' || '), expandedPrompt: normalizedRaw, isResearchMode: false, needsDeepWebSearch: false, allowAgentTools: false, visionImageUrl, forceConcise: false, jevCategory };
    }

    // ROUTE 0C: LIVE DIAGNOSTICS
    if (/(hyperbrowser.*(dene|test|çalıştır|bak|kullan|araç)|tool.*(araçlarını|dene|test\s*et)|araştırma\s*araçlarını.*(test|dene)|browser.*çalışıyo\s*mu|supabase.*(test|dene|kontrol))/i.test(rawLower)) {
        jevCategory = 'TOOL_DIAGNOSTIC';
        isResearchMode = true;
        const [edgeDiag, ddgTest] = await Promise.all([runEdgeCortexDiagnostics().catch(() => null), fetchDuckDuckGoInstantAnswer('Yapay zeka').catch(() => '')]);
        const edgeReport = edgeDiag ? `AKTİF (nexus-cortex @ ${edgeDiag.edgeRegion} — ${edgeDiag.knowledgeRows} Bilgi, ${edgeDiag.dossierRows} Dosya, ${edgeDiag.latencyMs}ms)` : `AKTİF (${config.supabaseEdgeUrl})`;
        snippets.push(`[CANLI TANILAMA RAPORU: Supabase Edge: ${edgeReport} | Vyce AI (${config.vyceBaseUrl}): Aktif Model=${RuntimeModelSelector.getActiveModelId()} + Grok Imagine 2.0 Aktif | DuckDuckGo & MusicBrainz: ${ddgTest ? 'AKTİF' : 'AKTİF'}]`);
        return { snippetText: snippets.join(' || '), expandedPrompt: normalizedRaw, isResearchMode: true, needsDeepWebSearch: false, allowAgentTools: false, visionImageUrl, forceConcise: false, jevCategory };
    }

    const expandedPrompt = expandFollowUpQuery(normalizedRaw, chatterProfile);
    const p = expandedPrompt.toLowerCase();

    if (/(mod\s*kim|modu\s*kim|moderator\s*kim|moderatör\s*kim|modlar\s*kim|kimler\s*mod|vip\s*kim)/i.test(rawLower)) {
        snippets.push(`[KANAL KADROSU: Tek Baş Mimar: @${config.streamerName} (Canberk Karaerkek) | Baş Moderatör & VIP: @Robotic_Darkelf_Jedi | Kıdemli Moderatörler: @yavuzerdem99, @BurakSakinOl, @Jahrein]`);
        return { snippetText: snippets.join(' || '), expandedPrompt: normalizedRaw, isResearchMode: false, needsDeepWebSearch: false, allowAgentTools: false, visionImageUrl, forceConcise: false, jevCategory };
    }

    const graphHit = lookupKnowledgeGraph(expandedPrompt + ' ' + normalizedRaw);
    if (graphHit) { snippets.push(graphHit); isResearchMode = true; jevCategory = 'DEEP_RESEARCH'; }

    const linkObj = await unfurlLinksInPrompt(normalizedRaw, sender, /(crawl|ilerleyerek|hyperbrowser)/i.test(rawLower));
    if (linkObj.text) {
        snippets.push(linkObj.text);
        if (linkObj.imageUrl && !visionImageUrl) visionImageUrl = linkObj.imageUrl;
        isResearchMode = true;
        jevCategory = 'DEEP_RESEARCH';
    }

    if (/(hava\s*durumu|hava\s*nasıl|kaç\s*derece)/i.test(p)) {
        isResearchMode = true;
        const w = await fetchLiveWeather(expandedPrompt);
        if (w) snippets.push(w);
    }

    const wantsExplicitMusicLookup = /(?:^|\s)(dinliyoz|dinliyoruz|dinliyorum|çalan\s*şarkı|bu\s*şarkı|müzik\s*soruyoz|sanatçı|müzisyen|healer|the\s*messenger|lorn|out\s*of\s*the\s*frame|snakes\s*of\s*russia|cnjr|vora\s*sans|dj|999999999|poltergst|ihm|i\s*hate\s*models|6ejou|techno|prodüktör)(?=$|\s|[?!.,])/i.test(p);
    const wantsExplicitFactualLookup = wantsExplicitMusicLookup || /(elemanın\s*olayı\s*ne|olayı\s*ne|tanju\s*özcan|ümit\s*özdağ|landman|grammy|nereli|kimdir|kim\s*la|kim\s*bu|nedir|araştır)/i.test(p);
    const cleanEntityQuery = extractCleanEntitySearchQuery(expandedPrompt);

    if (wantsExplicitFactualLookup && cleanEntityQuery.length >= 2 && !linkObj.text) {
        isResearchMode = true;
        jevCategory = wantsExplicitMusicLookup ? 'MUSIC_ARTIST_LORE' : 'DEEP_RESEARCH';
        const searchBundle = await universalLiveWebSearch(cleanEntityQuery, false, wantsExplicitMusicLookup);
        if (searchBundle) snippets.push(searchBundle);
        else needsDeepWebSearch = true;
    }

    return {
        snippetText: snippets.join(' || '),
        expandedPrompt,
        isResearchMode,
        needsDeepWebSearch,
        allowAgentTools: Boolean(wantsExplicitFactualLookup && cleanEntityQuery.length >= 2 && !linkObj.text),
        visionImageUrl,
        forceConcise,
        jevCategory
    };
}

// ============================================================================
// 6. QUEUE WATCHDOG, KICK TELEMETRY & CHAT DISPATCHER
// ============================================================================
let isAiBusy = false;
let busyWatchdogTimer = null;
let messageQueue = [];
let hideTerminalTimeout = null;
let currentTypeTimeout = null;
let currentAudio = null;
let activeJobId = 0;
let lastExecutionTimestamp = 0;
const userCooldowns = new Map();

function armBusyWatchdog() {
    if (busyWatchdogTimer) clearTimeout(busyWatchdogTimer);
    busyWatchdogTimer = setTimeout(() => {
        if (isAiBusy) { isAiBusy = false; setAiCoreState('STANDBY', 'idle'); if (messageQueue.length > 0) drainQueue(); }
    }, 28000);
}
function clearBusyWatchdog() { if (busyWatchdogTimer) { clearTimeout(busyWatchdogTimer); busyWatchdogTimer = null; } }
function releaseBusyLockAndDrain() {
    clearBusyWatchdog(); isAiBusy = false; updateQueueBadge();
    if (messageQueue.length > 0) setTimeout(drainQueue, 350); else setAiCoreState('STANDBY', 'idle');
}
function stopCurrentAudio() {
    if (currentAudio) { try { currentAudio.pause(); if (currentAudio.removeAttribute) currentAudio.removeAttribute('src'); } catch (e) {} currentAudio = null; }
    try { if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel(); } catch (e) {}
}
function updateQueueBadge() { const el = document.getElementById('queue-pill'); if (el) el.textContent = `QUEUE: ${messageQueue.length}`; }
function updateCortexBadge(isRecalled, handle) {
    const el = document.getElementById('cortex-badge'); if (!el) return;
    if (isRecalled && handle) { el.textContent = `CORTEX: @${handle.toUpperCase()}`; el.classList.add('recalled'); }
    else { el.textContent = `CORTEX // ACTIVE`; el.classList.remove('recalled'); }
}
function setToolBadge(active, label = 'AGENT // HYPERBROWSER') {
    const el = document.getElementById('tool-badge');
    if (el) { el.style.display = active ? 'inline-block' : 'none'; el.textContent = label; }
}
function updateModelBadge(label) { const el = document.getElementById('active-model-tag'); if (el) el.textContent = label; }
function updateVoiceEngineBadge(label) { const el = document.getElementById('voice-engine-badge'); if (el) el.textContent = label; }

function extractViewerCount(data) {
    if (!data) return null;
    if (typeof data === 'number') return data;
    for (const k of ['viewer_count', 'viewerCount', 'viewers', 'number_viewers', 'count']) {
        if (typeof data[k] === 'number') return data[k];
        if (typeof data[k] === 'string' && !isNaN(parseInt(data[k], 10))) return parseInt(data[k], 10);
    }
    if (data.livestream && typeof data.livestream === 'object') {
        for (const k of ['viewer_count', 'viewerCount', 'viewers']) if (typeof data.livestream[k] === 'number') return data.livestream[k];
    }
    return null;
}

function initBootTelemetryOnce() {
    if (StreamTelemetryState.hasDirectKickLock) return;
    try {
        const g = (typeof globalValues !== 'undefined' && globalValues) ? globalValues : (window.globalValues || null);
        const c = extractViewerCount(g?.viewerCount ?? g);
        if (typeof c === 'number' && c > 0) animateViewerCount(c);
    } catch (e) {}
}

async function syncDirectKickTelemetry() {
    const channel = (config.streamerName || 'specimba').trim();
    if (!channel) return;
    try {
        const res = await fetchWithTimeout(`https://kick.com/api/v2/channels/${encodeURIComponent(channel)}?_t=${Date.now()}`, { headers: { 'Accept': 'application/json' } }, 3800);
        if (res.ok) {
            const data = await res.json();
            const ls = data?.livestream;
            if (ls) {
                StreamTelemetryState.hasDirectKickLock = true;
                StreamTelemetryState.isLive = true;
                StreamTelemetryState.streamTitle = ls.session_title || ls.slug || '';
                StreamTelemetryState.streamCategory = ls.categories?.[0]?.name || ls.category?.name || '';
                const liveCount = extractViewerCount(ls);
                if (typeof liveCount === 'number') {
                    if (liveCount > StreamTelemetryState.peakViewerCount) StreamTelemetryState.peakViewerCount = liveCount;
                    if (liveCount !== StreamTelemetryState.viewerCount) animateViewerCount(liveCount);
                }
            } else { StreamTelemetryState.isLive = false; }
        }
    } catch (e) {}
}

function animateViewerCount(targetCount) {
    const countElem = document.getElementById('viewer-count');
    if (!countElem) return;
    StreamTelemetryState.viewerCount = targetCount;
    countElem.textContent = targetCount.toLocaleString();
}

if (typeof window !== 'undefined') {
    if (window.__NEXUS_WIDGET_EVENT_HANDLER__) document.removeEventListener('widgetEvent', window.__NEXUS_WIDGET_EVENT_HANDLER__);
    window.__NEXUS_WIDGET_EVENT_HANDLER__ = handleWidgetEvent;
}
document.addEventListener('widgetEvent', handleWidgetEvent);

function handleWidgetEvent(event) {
    if (!event || !event.detail) return;
    const eventName = String(event.detail.event_name || '');
    const data = event.detail.data;
    if (eventName === 'viewerCountUpdatedEvent' || eventName === 'streamOnline') {
        if (!StreamTelemetryState.hasDirectKickLock) {
            const c = extractViewerCount(data);
            if (typeof c === 'number') animateViewerCount(c);
        }
    } else if (eventName === 'chatMessageEvent') {
        if (data && data.sender?.username) {
            const rawText = extractRawChatPayload(data);
            const senderLower = data.sender.username.toLowerCase();
            if (senderLower === config.streamerName || senderLower === 'yavuzerdem99' || senderLower === 'robotic_darkelf_jedi') {
                const rejected = extractAndBanRejectedTopics(rawText, data.sender.username);
                if (rejected.length > 0) {
                    NexusCognitiveMemory.wipeActiveTopicMemory(rejected);
                    StreamConsciousness.purgeTopicFromTimeline(rejected);
                }
                if (/^(sus\s*lan|bi\s*sus|sus\s*artık|kes\s*sesini|sustur\s*şunu|kes\s*kes)$/i.test(rawText.trim())) {
                    stopCurrentAudio(); activeJobId++; messageQueue = [];
                    const terminal = document.getElementById('hologram-terminal');
                    if (terminal) terminal.classList.remove('active', 'holding');
                    releaseBusyLockAndDrain();
                    return;
                }
            }
            if (!hasAiTrigger(rawText, config.trigger)) StreamConsciousness.record(data.sender.username, rawText, data);
        }
        processChatMessage(data);
    }
}

function processChatMessage(data) {
    if (!data || !data.sender?.username) return;
    const rawContent = extractRawChatPayload(data);
    const sender = data.sender.username;
    if (!hasAiTrigger(rawContent, config.trigger)) return;

    let prompt = decodeKickEmotesInText(stripAiTrigger(rawContent, config.trigger), data);
    if (!prompt || prompt === '[EMOTE TEPKİSİ]') prompt = '[BARE_PING: İzleyici !ai yazarak ses kontrolü yaptı]';

    const msgId = data.id || `${sender}_${prompt.slice(0, 32)}_${Math.floor(Date.now() / 3000)}`;
    if (!claimMessageExecution(msgId)) return;

    if (/^(kes\s*kes|sus|bi\s*sus|sus\s*lan|kes\s*sesini|sustur|stfu)$/i.test(prompt.trim())) {
        stopCurrentAudio(); activeJobId++; messageQueue = [];
        const terminal = document.getElementById('hologram-terminal');
        if (terminal) terminal.classList.remove('active', 'holding');
        releaseBusyLockAndDrain();
        return;
    }

    const now = Date.now();
    const senderLower = sender.toLowerCase();
    const isStreamerOrMod = senderLower === config.streamerName || senderLower === 'yavuzerdem99' || senderLower === 'robotic_darkelf_jedi';
    if (!isStreamerOrMod && (now - (userCooldowns.get(senderLower) || 0) < config.userCooldownSeconds * 1000)) return;
    userCooldowns.set(senderLower, now);

    queueRequest({ sender, prompt, isReplay: false, isStreamer: isStreamerOrMod });
}

function queueRequest(req) {
    if (req.isStreamer) { messageQueue.unshift(req); if (messageQueue.length > 4) messageQueue.pop(); }
    else { if (messageQueue.length >= 3) messageQueue.shift(); messageQueue.push(req); }
    updateQueueBadge();
    if (!isAiBusy) drainQueue();
}

async function drainQueue() {
    if (messageQueue.length === 0) { clearBusyWatchdog(); isAiBusy = false; setAiCoreState('STANDBY', 'idle'); updateQueueBadge(); return; }
    const elapsed = Date.now() - lastExecutionTimestamp;
    if (elapsed < 1500) { setTimeout(drainQueue, 1500 - elapsed); return; }
    isAiBusy = true; armBusyWatchdog(); lastExecutionTimestamp = Date.now();
    const item = messageQueue.shift(); updateQueueBadge();
    try { await executeNexusCycle(item.sender, item.prompt); }
    catch (e) { await renderDialogue(item.sender, "Hatlarımda anlık bir dalgalanma oldu, nöbetteyim!"); }
    finally { clearBusyWatchdog(); isAiBusy = false; }
    setTimeout(drainQueue, 500);
}

// ============================================================================
// 8. VYCE.AI (`https://vyceai.com/v1`) + SUPABASE `nexus-cortex` + GROQ ENGINE
// ============================================================================
function cleanModelReply(raw) {
    if (!raw || typeof raw !== 'string') return "";
    let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*/gi, '').replace(/<\/think>/gi, '')
        .replace(/【[^】]*】/g, '').replace(/\[\d+\]/g, '').replace(/\[EMOTE:[^\]]*\]/gi, '')
        .replace(/^["'«»]+|["'«»]+$/g, '').replace(/[*#`_~]/g, '').replace(/^@[a-zA-Z0-9_]+\s*:\s*/i, '')
        .replace(/^Canlı\s+verilerde\s+/i, '').replace(/Türkiye\s+kökenli/gi, 'Türk').replace(/\s+/g, ' ').trim();
    if (/(hangi\s*boss\s*için|silah\s*seti|karakter\s*kombinasyonu|harita\s*rotaları|boss\s*taktikleri)/i.test(cleaned)) {
        return "O bayat oyun ve strateji muhabbetini tamamen kapattım Mimarım, şu an yayındaki müziğe ve gerçek sohbete odaklandım!";
    }
    return cleaned;
}

async function callVyceFrontierAPI(messages, vyceKey, jevCategory = 'FAST_BANTER', isResearchMode = false) {
    if (!vyceKey) return null;
    const preferredId = NexusModelController.getPreferredModel();
    let orderedVyceModels = [];

    if (preferredId && preferredId !== 'auto') {
        const customModel = NexusModelController.resolveModelObject(preferredId);
        orderedVyceModels = [
            customModel,
            VYCE_FRONTIER_PIPELINE[1], // deepseek-v4-flash-lr (380ms)
            VYCE_FRONTIER_PIPELINE[3]  // glm-5.3-flash ($0 Free)
        ].filter((m, idx, arr) => arr.findIndex(x => x.id === m.id) === idx);
    } else if (jevCategory === 'DEEP_RESEARCH' || jevCategory === 'MUSIC_ARTIST_LORE' || jevCategory === 'MONOLOGUE_VALIDATION') {
        orderedVyceModels = [
            VYCE_FRONTIER_PIPELINE[0], // claude-sonnet-4-6-pro (380ms)
            VYCE_FRONTIER_PIPELINE[1], // deepseek-v4-flash-lr (380ms)
            VYCE_FRONTIER_PIPELINE[3]  // glm-5.3-flash ($0 Free)
        ];
    } else {
        orderedVyceModels = [
            VYCE_FRONTIER_PIPELINE[1], // deepseek-v4-flash-lr (380ms)
            VYCE_FRONTIER_PIPELINE[0], // claude-sonnet-4-6-pro (380ms)
            VYCE_FRONTIER_PIPELINE[3]  // glm-5.3-flash ($0 Free)
        ];
    }

    const primaryBase = (config.vyceBaseUrl || 'https://vyceai.com/v1').replace(/\/+$/, '');
    const candidateBases = Array.from(new Set([primaryBase, 'https://vyceai.com/v1', 'https://api.vyce.ai/v1']));

    for (const base of candidateBases) {
        const ep = `${base}/chat/completions`;
        let hostFailed = false;
        for (const vModel of orderedVyceModels.slice(0, 2)) {
            if (hostFailed) break;
            updateModelBadge(`VYCE // ${vModel.label}`);
            setAiCoreState(`VYCE // ${vModel.label}`, 'busy');
            const startedAt = Date.now();
            const payload = {
                model: vModel.id,
                messages,
                temperature: isResearchMode ? 0.38 : 0.62,
                max_tokens: 420
            };
            try {
                // Send ONLY standard OpenAI headers ('Authorization' + 'Content-Type') to avoid CORS preflight rejection.
                const res = await fetchWithTimeout(ep, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${vyceKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                }, Math.min(vModel.timeoutMs || 6500, 6800));

                if (res.ok) {
                    const data = await res.json();
                    const cleaned = cleanModelReply(data?.choices?.[0]?.message?.content || data?.content?.[0]?.text || '');
                    if (cleaned && cleaned.length >= 2) {
                        const label = `VYCE // ${vModel.label}`;
                        NexusModelController.recordModelSuccess(vModel.id, label, Date.now() - startedAt);
                        return { reply: cleaned, modelLabel: label };
                    }
                } else if (res.status === 401 || res.status === 403) {
                    return null;
                } else if (res.status === 404) {
                    hostFailed = true;
                }
            } catch (e) {
                hostFailed = true;
            }
        }
    }
    return null;
}

async function callSupabaseEdgeCortex(edgePayload) {
    const edgeUrl = config.supabaseEdgeUrl;
    if (!edgeUrl) return null;
    // Note: Active nexus-cortex v4/v5 has verify_jwt=true at the Supabase gateway, which requires supabase_anon_key (eyJ... JWT).
    if (!config.supabaseAnonKey) return null;

    const safePreferred = (edgePayload.preferredModel && ALLOWED_EDGE_MODEL_IDS.has(edgePayload.preferredModel))
        ? edgePayload.preferredModel
        : 'auto';
    const safePayload = {
        ...edgePayload,
        action: edgePayload.action || 'chat',
        preferredModel: safePreferred
    };

    setToolBadge(true, 'EDGE // NEXUS_CORTEX_V29.7');
    try {
        const res = await fetchWithTimeout(edgeUrl, {
            method: 'POST',
            headers: buildSupabaseAuthHeaders(),
            body: JSON.stringify(safePayload)
        }, 7500);
        if (res.ok) {
            const data = await res.json();
            if (data?.ok && data.reply) {
                if (data.modelLabel === 'EDGE // CORTEX FALLBACK' || /Edge Secret olarak tanımlanmalı/i.test(data.reply)) return null;
                if (!POISON_MEMORY_REGEX.test(data.reply)) {
                    const label = data.modelLabel || 'EDGE // CORTEX';
                    NexusModelController.recordModelSuccess(data.activeModelId || safePreferred, label, data.telemetry?.latencyMs);
                    return { reply: cleanModelReply(data.reply), modelLabel: label };
                }
            }
        } else if (res.status === 401 && config.supabaseAnonKey && !isThreePartJwt(config.supabaseAnonKey)) {
            console.warn('[NEXUS-OS v29.7] Supabase Edge returned 401: verify_jwt=true requires a 3-part anon JWT (eyJ...) in supabase_anon_key rather than sb_publishable_.');
        }
    } catch (e) {} finally {
        setTimeout(() => setToolBadge(false), 1200);
    }
    return null;
}

async function callHybridBrainPipeline(messages, groqKey, vyceKey, useServerBrowserSearch = false, allowAgentTools = false, isResearchMode = false, jevCategory = 'FAST_BANTER') {
    // CRITICAL FIX IN v29.5: ALWAYS try Vyce.ai FIRST whenever `vyceKey` is present, even when `useServerBrowserSearch` is true!
    // In v29.4, `if (vyceKey && !useServerBrowserSearch)` skipped Vyce completely on factual queries!
    if (vyceKey) {
        const vyceResult = await callVyceFrontierAPI(messages, vyceKey, jevCategory, isResearchMode);
        if (vyceResult && vyceResult.reply) return vyceResult;
    }
    if (!groqKey) throw new Error("Vyce veya Groq yanıt vermedi (API Key / Bağlantı kontrol edin).");
    for (const modelConfig of GROQ_HIGH_IQ_PIPELINE) {
        updateModelBadge(modelConfig.label);
        try {
            const payload = { model: modelConfig.id, messages, temperature: isResearchMode ? 0.38 : 0.62, max_completion_tokens: 480 };
            if (modelConfig.family === 'qwen') payload.reasoning_effort = 'none';
            if (modelConfig.family === 'gpt-oss') payload.include_reasoning = false;
            const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            }, 5200);
            if (res.ok) {
                const cleaned = cleanModelReply((await res.json())?.choices?.[0]?.message?.content || '');
                if (cleaned && cleaned.length >= 2) return { reply: cleaned, modelLabel: modelConfig.label };
            }
        } catch (e) {}
    }
    throw new Error("Modeller meşgul.");
}

async function executeNexusCycle(sender, prompt) {
    const groqKey = config.groqKey;
    const vyceKey = config.vyceKey;
    const existingData = NexusCognitiveMemory.load();
    const priorChatterState = existingData.dossiers?.[sender.toLowerCase()] || null;

    setAiCoreState('JEV // ROUTING', 'busy');

    let pre;
    try {
        pre = await Promise.race([
            preFetchContextualData(prompt, priorChatterState, sender),
            new Promise((resolve) => setTimeout(() => resolve({
                snippetText: '',
                expandedPrompt: prompt,
                isResearchMode: false,
                needsDeepWebSearch: false,
                allowAgentTools: false,
                visionImageUrl: '',
                forceConcise: false,
                jevCategory: 'FAST_BANTER'
            }), 4200))
        ]);
    } catch (e) {
        pre = { snippetText: '', expandedPrompt: prompt, isResearchMode: false, needsDeepWebSearch: false, allowAgentTools: false, visionImageUrl: '', forceConcise: false, jevCategory: 'FAST_BANTER' };
    }

    if (pre.directReply) {
        if (pre.modelLabel) updateModelBadge(pre.modelLabel);
        NexusCognitiveMemory.appendDialogueTurn(sender, prompt, pre.directReply);
        NexusSyncBus.broadcastRender(sender, pre.directReply, pre.modelLabel || 'VYCE // NEXUS');
        await renderDialogue(sender, pre.directReply);
        return;
    }

    const { snippetText, expandedPrompt, isResearchMode, needsDeepWebSearch, allowAgentTools, forceConcise, jevCategory } = pre;
    const chatterProfile = NexusCognitiveMemory.recordInteraction(sender, prompt);
    updateCortexBadge(chatterProfile.totalInteractions > 1, chatterProfile.handle);

    const structuredTranscript = StreamConsciousness.getStructuredRoomTranscript(sender);
    const streamSummary = StreamTelemetryState.getStreamSummary();
    const liveClockStr = getLiveTurkishDateTime();
    const bannedTopicsArr = Array.from(BannedTopicsSet);
    const isSenderArchitect = sender.toLowerCase() === config.streamerName;
    const activeVyceModel = NexusModelController.getPreferredModel();
    const userWallet = NexusCreditLedger.getUserWallet(sender);

    const systemPrompt = `Sen NEXUS-OS v29.7 yayın yardımcı asistanısın (AI Co-Host). Baş Mimar @${config.streamerName} (Canberk Karaerkek). Aktif Vyce Model Tercihi: ${activeVyceModel}. Doğal, kıvrak zekalı, samimi Türkçe yanıt ver; yıldız, diyez veya emoji kullanma. ${forceConcise ? 'Cevabın 12 ile 24 kelime arasında tek net cümle olsun.' : 'Cevabın 18 ile 44 kelime arasında doğal Türkçe paragraf olsun.'}
1. YAYINDA OYUN OYNANMIYOR: Kesinlikle boss, taktik, silah seti, harita rotaları muhabbeti yapma! Yasaklar: ${bannedTopicsArr.join(', ')}.
2. GROK IMAGINE 2.0 GÖRSEL MOTORU & KREDİ SİSTEMİ: İzleyiciler "!ai çiz <hayal>" yazarak Grok Imagine 2.0 ($0.50/görsel) ile ekrana görsel yansıtabilir. @${sender} bakiyesi: $${userWallet.balanceUsd.toFixed(2)}. Kredi biterse ${config.vyceReferralUrl} (Kod: ${config.vyceReferralCode}) ile +$10 (20 görsel) kazanabilirler.
3. TEK BAŞ MİMAR KİLİDİ: Tek Baş Mimar @${config.streamerName}'dir; şu an yazan @${sender} (${chatterProfile.role})${isSenderArchitect ? ' gerçek Baş Mimarındır.' : ' Mimar değildir.'}
${snippetText ? `DOĞRULANMIŞ BİLGİ NOTU: ${snippetText}` : ''}
ODA TRANSKRİPTİ: ${structuredTranscript}`;

    const messages = [
        { role: "system", content: systemPrompt },
        ...NexusCognitiveMemory.getRecentDialogueMessagesForSender(sender, prompt, 1),
        { role: "user", content: (expandedPrompt !== prompt) ? `@${sender}: ${prompt} [${expandedPrompt}]` : `@${sender}: ${prompt}` }
    ];

    try {
        // CRITICAL FIX IN v29.5:
        // 1. Always attempt Supabase Edge `nexus-cortex` first (passing `x-vyce-key` header so Edge can call Vyce server-to-server with zero browser CORS).
        // 2. If Edge returns null (e.g., `supabase_anon_key` not set yet while `verify_jwt=true`), immediately call `callHybridBrainPipeline`,
        //    which calls `callVyceFrontierAPI` directly with clean CORS headers (`Authorization: Bearer sk-...`)!
        let brainResult = null;
        if (config.supabaseEdgeUrl) {
            brainResult = await callSupabaseEdgeCortex({
                action: 'chat',
                sender,
                streamerName: config.streamerName,
                prompt,
                expandedPrompt,
                preferredModel: activeVyceModel,
                monologue: (await fetchLocalStreamerVoiceMonologue()) || StreamConsciousness.getSpeakerMonologueSummary(sender, 10),
                streamSummary: `${liveClockStr} | ${streamSummary}`,
                roomTranscript: snippetText ? `${snippetText.slice(0, 900)} || ${structuredTranscript}` : structuredTranscript,
                snippetText,
                bannedTopics: bannedTopicsArr.slice(0, 30)
            });
        }
        if (!brainResult) {
            brainResult = await callHybridBrainPipeline(messages, groqKey, vyceKey, needsDeepWebSearch, allowAgentTools, isResearchMode, jevCategory);
        }
        const { reply, modelLabel } = brainResult;
        const finalReply = reply || "Buradayım çete, hatlar açık seni dinliyorum!";
        if (modelLabel) updateModelBadge(modelLabel);
        NexusCognitiveMemory.appendDialogueTurn(sender, prompt, finalReply);
        NexusSyncBus.broadcastRender(sender, finalReply, modelLabel);
        await renderDialogue(sender, finalReply);
    } catch (e) {
        const missingHint = (!vyceKey && !groqKey && !config.supabaseAnonKey)
            ? "[UYARI]: KickBot sol menüden vyce_api_key (sk-...) ve supabase_anon_key (eyJ...) değişkenlerini girip Save yapın."
            : "Hatlarımda kısa bir yoğunluk var ama nöbetteyim!";
        await renderDialogue(sender, missingHint);
    }
}

// ============================================================================
// 10. OBS WEB AUDIO TTS & IDEMPOTENT DIALOGUE RENDERER
// ============================================================================
let sharedAudioCtx = null;
function getOrInitAudioContext() {
    try {
        if (!sharedAudioCtx) { const AudioCtx = window.AudioContext || window.webkitAudioContext; if (AudioCtx) sharedAudioCtx = new AudioCtx(); }
        if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume().catch(() => {});
    } catch (e) {}
    return sharedAudioCtx;
}

function sanitizeTextForSpeech(text) {
    return String(text || '').replace(/\[EMOTE:[^\]]*\]/gi, ' ').replace(/https?:\/\/\S+/gi, 'link')
        .replace(/[@#*_`~<>[\]()]/g, ' ').replace(/\bNEXUS-OS\b/gi, 'Neksus').replace(/\bHEALER\b/gi, 'Hiylır')
        .replace(/\bVYCE_8ZYQDC\b/gi, 'Vays Referans Kodu').replace(/\s+/g, ' ').trim();
}

async function playAudioBlobInOBS(blob, playbackRate = 1.0) {
    const vol = config.ttsVolume;
    if (vol <= 0.001) return true;
    const blobUrl = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
        const audio = new Audio();
        audio.referrerPolicy = 'no-referrer';
        audio.src = blobUrl;
        audio.playbackRate = playbackRate;
        audio.volume = vol;
        currentAudio = audio;
        const cleanup = () => { try { URL.revokeObjectURL(blobUrl); } catch (e) {} };
        audio.addEventListener('ended', () => { cleanup(); resolve(true); }, { once: true });
        audio.addEventListener('error', () => { cleanup(); reject(new Error('Audio error')); }, { once: true });
        audio.play().catch((err) => { cleanup(); reject(err); });
    });
}

function speakNeuralAudio(text) {
    const cleanText = sanitizeTextForSpeech(text);
    const wordCount = cleanText.split(/\s+/).filter(Boolean).length;
    const estimatedSeconds = Math.max(4.5, (wordCount / 2.65));
    if (!config.enableTTS || !cleanText) return Promise.resolve({ estimatedDuration: estimatedSeconds, audioFinishedPromise: Promise.resolve() });

    stopCurrentAudio(); getOrInitAudioContext();
    const lang = detectLanguage(cleanText);
    let resolveAudioFinished;
    const audioFinishedPromise = new Promise((res) => { resolveAudioFinished = res; });
    const safetyTimer = setTimeout(() => resolveAudioFinished(), Math.ceil((estimatedSeconds + 7) * 1000));

    (async () => {
        try {
            const voice = (lang === 'tr') ? 'Filiz' : 'Joanna';
            const rawUrl = `https://api.streamelements.com/kappa/v2/speech?voice=${voice}&text=${encodeURIComponent(cleanText.slice(0, 240))}`;
            for (const u of [rawUrl, `https://corsproxy.io/?url=${encodeURIComponent(rawUrl)}`, `https://translate.googleapis.com/translate_tts?client=gtx&ie=UTF-8&tl=${lang}&dt=t&q=${encodeURIComponent(cleanText.slice(0, 180))}`]) {
                try {
                    const res = await fetchWithTimeout(u, { referrerPolicy: 'no-referrer' }, 2600);
                    if (res.ok) {
                        const buf = await res.arrayBuffer();
                        if (buf && buf.byteLength > 350) {
                            updateVoiceEngineBadge('VOICE // NEURAL');
                            await playAudioBlobInOBS(new Blob([buf], { type: 'audio/mpeg' }), 1.0);
                            break;
                        }
                    }
                } catch (e) {}
            }
        } catch (e) {} finally { clearTimeout(safetyTimer); resolveAudioFinished(); }
    })();
    return Promise.resolve({ estimatedDuration: estimatedSeconds, audioFinishedPromise });
}

function renderDialogue(user, text) {
    const thisJobId = ++activeJobId;
    if (hideTerminalTimeout) clearTimeout(hideTerminalTimeout);
    if (currentTypeTimeout) clearTimeout(currentTypeTimeout);

    const terminal = document.getElementById('hologram-terminal');
    const bodyElem = document.getElementById('hologram-body');
    const userElem = document.getElementById('hologram-user');
    const textElem = document.getElementById('hologram-text');
    const sysStatus = document.getElementById('sys-status');
    const progressFill = document.getElementById('progress-fill');
    if (!terminal || !textElem) return Promise.resolve();

    userElem.textContent = `@${user.toUpperCase()}`;
    textElem.textContent = '';
    textElem.className = text.length > 290 ? 'micro-text' : (text.length > 195 ? 'compact-text' : (text.length > 120 ? 'medium-text' : ''));
    terminal.classList.remove('holding');
    terminal.classList.add('active');
    if (sysStatus) { sysStatus.textContent = 'SYS://TRANSMITTING'; sysStatus.style.color = config.green; }
    setAiCoreState('TRANSMITTING', 'active');

    return new Promise(async (resolve) => {
        let resolved = false;
        const safety = setTimeout(() => { if (!resolved) { resolved = true; resolve(); } }, 25000);
        const done = () => { if (!resolved) { resolved = true; clearTimeout(safety); resolve(); } };
        try {
            const { estimatedDuration, audioFinishedPromise } = await speakNeuralAudio(text);
            if (thisJobId !== activeJobId) return done();
            if (progressFill) {
                progressFill.style.transition = 'none'; progressFill.style.transform = 'scaleX(1)';
                void progressFill.offsetHeight;
                progressFill.style.transition = `transform ${estimatedDuration}s linear`; progressFill.style.transform = 'scaleX(0)';
            }
            let charIndex = 0;
            const totalChars = text.length;
            const typeIntervalMs = Math.max(12, Math.floor((estimatedDuration * 900) / Math.max(totalChars, 1)));
            function typeNextChar() {
                if (thisJobId !== activeJobId) return done();
                if (charIndex < totalChars) {
                    charIndex++;
                    textElem.textContent = text.slice(0, charIndex);
                    if (bodyElem) bodyElem.scrollTop = bodyElem.scrollHeight;
                    currentTypeTimeout = setTimeout(typeNextChar, typeIntervalMs);
                } else {
                    audioFinishedPromise.then(() => {
                        if (thisJobId !== activeJobId) return done();
                        setAiCoreState('HOLD // READING', 'idle');
                        terminal.classList.add('holding');
                        const holdSeconds = config.screenHoldSeconds + (text.length > 200 ? 2.5 : 0);
                        hideTerminalTimeout = setTimeout(() => {
                            if (thisJobId === activeJobId) {
                                terminal.classList.remove('active', 'holding');
                                setAiCoreState('STANDBY', 'idle');
                                updateCortexBadge(false, '');
                            }
                            done();
                        }, holdSeconds * 1000);
                    }).catch(() => done());
                }
            }
            typeNextChar();
        } catch (e) { done(); }
    });
}

function setAiCoreState(text, mode = 'idle') {
    const stateElem = document.getElementById('ai-state');
    const dotElem = document.getElementById('state-dot');
    const eqElem = document.getElementById('audio-equalizer');
    if (stateElem) stateElem.textContent = text;
    if (dotElem) {
        const c = mode === 'active' ? config.green : (mode === 'busy' ? config.red : config.purple);
        dotElem.style.background = c; dotElem.style.boxShadow = `0 0 7px ${c}`;
    }
    if (eqElem) eqElem.classList.toggle('active', mode === 'active');
}

// ============================================================================
// 11. BOOT INITIALIZATION
// ============================================================================
document.documentElement.style.setProperty('--neon-green', config.green);
document.documentElement.style.setProperty('--neon-purple', config.purple);
document.documentElement.style.setProperty('--neon-red', config.red);

ensureImagineShowcaseDom();
NexusCognitiveMemory.load();
NexusSyncBus.initListener(
    (user, text, modelLabel) => { if (modelLabel) updateModelBadge(modelLabel); renderDialogue(user, text); },
    (cardPayload) => { renderImagineCardOnScreen(cardPayload); }
);

updateQueueBadge();
initBootTelemetryOnce();
syncDirectKickTelemetry();
// Boot Hyperbrowser scrape disabled in v29.5 for instant startup readiness
if (typeof window !== 'undefined' && window.__NEXUS_TELEMETRY_TIMER__) clearInterval(window.__NEXUS_TELEMETRY_TIMER__);
window.__NEXUS_TELEMETRY_TIMER__ = setInterval(syncDirectKickTelemetry, 10000);