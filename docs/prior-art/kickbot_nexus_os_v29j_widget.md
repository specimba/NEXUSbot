# KickBot Cyber-AI Viewer HUD Widget (v29.7 — Supabase Agent `v5` Security Hardened: Zero Browser `nexus_shared_secret` / Zero `x-vyce-key` + `VYCE_MODEL` Edge Secret Support + Redacted Provider Telemetry)

Engineered for `kick.com/specimba` (**Baş Mimar: Canberk Karaerkek**). Fully aligned with your **Supabase Agent's latest security & deployment review** for **version 5** (`https://vwottesqbdgcsmvvvzok.supabase.co/functions/v1/nexus-cortex`, `verify_jwt=true`).

## 1. Summary of Supabase Agent Security & Configuration Corrections in `v29.7` (`v5`)

| Supabase Agent Finding | Why It Matters | `v29.7` Fix (`Script.js` + `nexus-cortex` v5 `index.ts`) |
| :--- | :--- | :--- |
| **1. Do NOT Put `nexus_shared_secret` in KickBot Variables or Browser Code (`x-nexus-secret`)** | Any secret placed in KickBot `userVariables` or sent by the browser widget as `x-nexus-secret` is visible to anyone inspecting the widget, allowing anonymous callers to spoof `trustedWrite`, bypass public rate limits, and write to database tables. | • **Removed `nexus_shared_secret` & `x-nexus-secret` from `Script.js` and KickBot Variables**: The browser widget now sends **only** the public `supabase_anon_key` JWT (`Authorization: Bearer <anon_jwt>` + `apikey: <anon_jwt>`).<br>• **Removed `x-nexus-secret` from Browser `CORS` in `index.ts`**: `Access-Control-Allow-Headers` is now strictly `"authorization, x-client-info, apikey, content-type"`. `NEXUS_SHARED_SECRET` remains exclusively in **Edge Function Secrets** for server-to-server callers. |
| **2. Database Vault vs. Edge Function Secrets (`Deno.env`) + `VYCE_MODEL` & `NEXUS_IMAGINE_GLOBAL_MAX_PER_HOUR`** | Database Vault entries are **not** automatically exposed to `Deno.env` inside Edge Functions—only **Edge Function Secrets** are. Furthermore, `v4` ignored `VYCE_MODEL`, and `NEXUS_IMAGINE_GLOBAL_MAX_PER_HOUR` was not set in Edge Function Secrets (defaulting to `10`). | • **`VYCE_MODEL` Read via `Deno.env.get("VYCE_MODEL")`**: `resolveEffectivePreferredModel()` in `index.ts` now reads `Deno.env.get("VYCE_MODEL")` whenever the caller passes `"auto"`, validating it against `MODEL_IDS`.<br>• **Edge Function Secrets**: Set `VYCE_MODEL` and `NEXUS_IMAGINE_GLOBAL_MAX_PER_HOUR="20"` directly in **Edge Function Secrets** (`supabase secrets set`). |
| **3. Complete `index.ts` Source Needed Inline for Supabase Agent `v5` Deployment** | The Supabase Agent cannot access Canvas files directly and requested the full `index.ts` source pasted directly into chat (with no secret values). | • Provided the complete, self-contained `supabase/functions/nexus-cortex/index.ts` (`v29.7` / `v5`) source both in `supabase_nexus_cortex_edge_function.ts` and inline in chat for immediate copy-paste deployment. |

## 2. Step-by-Step Setup: Edge Function Secrets & KickBot Variables

### Step A: Ensure Optional Edge Secrets Are Set in Supabase Edge Function Secrets (Not Just Database Vault)

```bash
supabase secrets set \
  VYCE_MODEL="auto" \
  NEXUS_IMAGINE_GLOBAL_MAX_PER_HOUR="20"
```
*(Your existing Edge Function Secrets—`VYCE_API_KEY`, `VYCE_BASE_URL`, `GROQ_API_KEY`, `HYPERBROWSER_API_KEY`, `NEXUS_SHARED_SECRET`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`—are already present in Edge Function Secrets.)*

### Step B: KickBot User Variables (`+ Add Variable` in KickBot Left Sidebar — Zero Shared Secrets!)

| Title | Variable Name | Type | Default Value | Description |
| :--- | :--- | :--- | :--- | :--- |
| **Supabase Project URL** | `supabase_url` | Text | `https://vwottesqbdgcsmvvvzok.supabase.co` | Pre-wired to your live Supabase project |
| **Supabase Anon Key (JWT)** | `supabase_anon_key`| Text | `eyJ...` | **CRITICAL for `verify_jwt=true`**: Paste your public 3-part `eyJ...` **anon JWT** key from Supabase Dashboard $\rightarrow$ **Project Settings $\rightarrow$ API** (do **not** use `sb_publishable_...` when `verify_jwt=true`, and **never** put `NEXUS_SHARED_SECRET` here!) |
| **Vyce Preferred Model** | `vyce_model` | Text | `auto` | `auto` or any catalog ID (`claude-sonnet-4-6-pro`, `deepseek-v4-flash-lr`, `gpt-astra`, `glm-5.3-flash`, `deepseek-v4.1`, `deepseek-v4-flash`, `claude-sonnet-4-6`, `gpt-6-luna`, `gpt-5.6-terra`, `agnes-3.0-flash`, `deepseek-v4-pro`) |
| **Vyce Base URL** | `vyce_base_url` | Text | `https://vyceai.com/v1` | Primary Vyce OpenAI-compatible base URL (automatically falls back to `https://api.vyce.ai/v1`) |
| **TTS Volume (0-100)** | `tts_volume` | Number | `85` | Software master volume (`0` = mute, `85` = warm balanced, `100` = max) |
| **Streamer Name** | `streamer_name` | Text | `specimba` | Your Kick channel handle (sole `Baş Mimar`) |
| **Trigger Command** | `ai_trigger` | Text | `!ai` | Trigger keyword (works at start, middle, or end of message) |

## 3. Tab 1: `Index.html`

```html
<div class="cyber-hud-container" id="hud-container">
    <!-- Top Telemetry Row -->
    <div class="hud-top-bar">
        <!-- Module 1: Live Viewer Telemetry Counter -->
        <div class="hud-pill viewer-module">
            <div class="telemetry-bracket tl"></div>
            <div class="telemetry-bracket tr"></div>
            <div class="telemetry-bracket bl"></div>
            <div class="telemetry-bracket br"></div>

            <div class="status-indicator">
                <span class="live-pulse"></span>
                <div class="icon-wrapper" id="viewer-icon-box">
                    <svg viewBox="0 0 24 24" class="kick-svg-icon" fill="currentColor">
                        <path d="M3 2h5v6.5L13.5 2H20l-7.5 8.5L20 22h-6.5L8 15.5V22H3V2z"/>
                    </svg>
                </div>
            </div>

            <div class="telemetry-data">
                <div class="telemetry-header">
                    <span class="telemetry-label">V-FLUX // LIVE</span>
                    <span class="telemetry-latency" id="net-latency">SYNCED</span>
                </div>
                <div class="counter-row">
                    <span class="viewer-count" id="viewer-count">0</span>
                    <span class="trend-icon" id="trend-delta">▲</span>
                </div>
            </div>
        </div>

        <!-- Module 2: NEXUS-OS AI Core State & Active Vyce LLM Display -->
        <div class="hud-pill ai-core-module" id="ai-core-module">
            <div class="telemetry-bracket tl"></div>
            <div class="telemetry-bracket tr"></div>
            <div class="telemetry-bracket bl"></div>
            <div class="telemetry-bracket br"></div>

            <div class="audio-equalizer" id="audio-equalizer">
                <span class="eq-bar"></span>
                <span class="eq-bar"></span>
                <span class="eq-bar"></span>
                <span class="eq-bar"></span>
                <span class="eq-bar"></span>
            </div>

            <div class="ai-status-text">
                <div class="ai-header-row">
                    <span class="ai-tag">NEXUS-OS</span>
                    <span class="ai-model-tag" id="active-model-tag">VYCE // AUTO (SONNET 4.6 PRO)</span>
                </div>
                <div class="ai-state-indicator">
                    <span class="state-dot" id="state-dot"></span>
                    <span class="ai-state" id="ai-state">STANDBY</span>
                </div>
            </div>
        </div>
    </div>

    <!-- Module 3: Holographic Terminal Box -->
    <div class="hologram-terminal" id="hologram-terminal">
        <div class="terminal-corner corner-tl"></div>
        <div class="terminal-corner corner-tr"></div>
        <div class="terminal-corner corner-bl"></div>
        <div class="terminal-corner corner-br"></div>

        <div class="hologram-header">
            <div class="user-block">
                <span class="terminal-led"></span>
                <span class="hologram-user" id="hologram-user">@SPECIMBA</span>
            </div>
            <div class="badges-block">
                <span class="badge badge-tool" id="tool-badge" style="display: none;">VYCE // ROUTER</span>
                <span class="badge badge-cortex" id="cortex-badge">CORTEX // ACTIVE</span>
                <span class="badge badge-queue" id="queue-pill">QUEUE: 0</span>
                <span class="badge badge-status" id="sys-status">SYS://IDLE</span>
                <span class="badge badge-neural" id="voice-engine-badge">NEURAL-VOICE</span>
            </div>
        </div>

        <div class="hologram-body" id="hologram-body">
            <p id="hologram-text"></p>
        </div>

        <!-- Real-time Laser Progress Countdown Track -->
        <div class="laser-track">
            <div class="laser-fill" id="progress-fill"></div>
        </div>
    </div>

    <!-- Module 4: Grok Imagine 2.0 On-Screen Holographic Image Showcase -->
    <div class="hologram-imagine-card" id="hologram-imagine-card">
        <div class="terminal-corner corner-tl"></div>
        <div class="terminal-corner corner-tr"></div>
        <div class="terminal-corner corner-bl"></div>
        <div class="terminal-corner corner-br"></div>

        <div class="imagine-header">
            <span class="imagine-title" id="imagine-artist-tag">GROK IMAGINE 2.0 // @SPECIMBA</span>
            <div class="imagine-badges">
                <span class="badge badge-score" id="imagine-score-badge">★ PUANLA: !ai puan 10</span>
                <span class="badge badge-credit" id="imagine-credit-badge">KREDİ: $4.50 (9 HAK)</span>
            </div>
        </div>

        <div class="imagine-Viewport">
            <img id="imagine-preview-img" alt="Grok Imagine 2.0 Stream Artwork" referrerpolicy="no-referrer" />
        </div>

        <div class="imagine-footer">
            <span class="imagine-prompt-caption" id="imagine-prompt-caption"></span>
            <span class="imagine-ref-pill" id="imagine-ref-pill">+$10 (20 GÖRSEL) BONUS: VYCE_8ZYQDC</span>
        </div>
    </div>
</div>
```

## 4. Tab 2: `Styles.css` & Tab 3: `Script.js`

Paste the updated **`kickbot_nexus_os_v29_script.js`** directly into your KickBot **`Script.js`** tab and click **Save**.
