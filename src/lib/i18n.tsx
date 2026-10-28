"use client";

/**
 * NEXUS OS panel i18n — modular one-click language system (EN first).
 *
 * WHAT THIS IS
 * - A React context provider + useI18n() hook that every panel component can
 *   call to translate STATIC UI chrome (nav labels, buttons, toasts, footers).
 * - State: lang is "en" | "tr", default "en" — the English dictionary is the
 *   source of truth; "tr" is an overlay that grows over time.
 * - Persistence: localStorage key "nexus.panel.lang".
 * - Hydration-safe: the first render (server AND client) is always "en".
 *   The stored language is applied after mount via useSyncExternalStore's
 *   server-snapshot protocol (React reads the client snapshot once hydration
 *   finishes and re-renders if it differs), so there is never a hydration
 *   mismatch — and no setState-in-effect (banned by the repo lint rules).
 * - One click: any component calling setLang writes the store, every
 *   subscribed component re-renders through the context — no reload, one
 *   click switches the whole system.
 *
 * HOW TO EXTEND — extend the dictionary to translate more; keys fall back to
 * English: t(key) resolves the entry for the active language, then the "en"
 * value, then the raw key itself, so a missing translation can never render
 * a blank or crash the panel. To translate another panel string:
 *   1. add a namespaced key to DICTIONARY below with BOTH "en" and "tr" values,
 *   2. import useI18n() in the component and render t("your.key").
 * Keys are plain strings (Record<string, …>) so the dictionary stays modular —
 * any panel component can add keys without touching this file's types.
 *
 * TRANSLATION POLICY (mirrors the product doctrine)
 * - Only STATIC chrome goes through t(). Dynamic data (log rows, chat text,
 *   news titles, bot replies, prompts) is NEVER translated here.
 * - Proper nouns (NEXUS OS, Eval · RSI, the owner handle) keep identical
 *   "en" and "tr" values on purpose — see the per-key comments.
 * - Keys with identical en/tr values are marked; everything else must carry
 *   a real Turkish translation.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export type PanelLang = "en" | "tr";

const LANG_STORAGE_KEY = "nexus.panel.lang";

/**
 * Flat namespaced dictionary. Keys: "<area>.<thing>[.<variant>".
 * en is the fallback language; tr entries must exist for every key.
 */
const DICTIONARY: Record<string, { en: string; tr: string }> = {
  /* ── Primary nav (panel-shell tabs) ──────────────────────────────────── */
  "nav.overview": { en: "Overview", tr: "Genel Bakış" },
  "nav.stream": { en: "Stream", tr: "Yayın" },
  "nav.pipeline": { en: "Pipeline", tr: "İşlem Hattı" },
  "nav.widgets": { en: "Widgets", tr: "Widget'lar" },
  "nav.connectors": { en: "Connectors", tr: "Bağlayıcılar" },
  "nav.settings": { en: "Settings", tr: "Ayarlar" },
  // Product tab name ("Eval · RSI") is a proper noun — identical in both.
  "nav.eval": { en: "Eval · RSI", tr: "Eval · RSI" },
  "nav.sections": { en: "Panel sections", tr: "Panel bölümleri" },

  /* ── Header chrome ───────────────────────────────────────────────────── */
  "header.serverOnline": { en: "Server online", tr: "Sunucu çevrimiçi" },
  "header.toggleTheme": {
    en: "Toggle light / dark theme",
    tr: "Açık / koyu temayı değiştir",
  },
  "header.signOut": { en: "Sign out", tr: "Çıkış yap" },
  // Bilingual by design so screen readers get both languages either way.
  "lang.toggle": {
    en: "Switch panel language / Panel dilini değiştir",
    tr: "Switch panel language / Panel dilini değiştir",
  },

  /* ── Auth toasts ─────────────────────────────────────────────────────── */
  "toast.signedOut": { en: "Signed out", tr: "Çıkış yapıldı" },
  "toast.logoutFailed": { en: "Logout failed", tr: "Çıkış başarısız" },

  /* ── Footer ───────────────────────────────────────────────────────────── */
  // Brand + owner handle are proper nouns — identical in both.
  "footer.brand": { en: "NEXUS OS · owner speci", tr: "NEXUS OS · owner speci" },
  "footer.l0": {
    en: "L0 stream · local-first · zero external spend",
    tr: "L0 stream · yerel öncelikli · sıfır dış harcama",
  },

  /* ── Connectors — Exa deep research card ──────────────────────────────── */
  // The old chrome was Turkish-only ("Radar yenile") — English is now the
  // default rendering, Turkish lives behind the toggle.
  "exa.research.refreshRadar": { en: "Refresh radar", tr: "Radar yenile" },
  "exa.research.refreshRadarAria": {
    en: "Refresh radar — pull a fresh AI news brief",
    tr: "Radar yenile — taze bir yapay zeka haber özeti çek",
  },

  /* ── Eval · RSI — battery launcher (v35.2) ───────────────────────────── */
  "eval.launcher.pluginRequiredTitle": { en: "Plugin required", tr: "Eklenti gerekli" },
  "eval.launcher.pluginRequiredDesc": {
    en: "A candidate leg is baseline + plugin promptDelta — pick a plugin above, or draft one below.",
    tr: "Aday kol = taban + eklenti promptDelta — yukarıdan bir eklenti seç ya da aşağıda taslak oluştur.",
  },
  "eval.launcher.draftToggle": { en: "Draft a plugin", tr: "Eklenti taslağı oluştur" },
  "eval.launcher.draftToggleAria": {
    en: "Open the plugin draft form",
    tr: "Eklenti taslak formunu aç",
  },
  "eval.launcher.draftDesc": {
    en: "Draft plugins are owner-authored promptDeltas for shadow-eval candidate legs — promotion still requires the owner gate.",
    tr: "Taslak eklentiler, gölge-değerlendirme aday kolları için sahibi tarafından yazılan promptDelta'lardır — terfi yine de sahip kapısından geçer.",
  },
  "eval.launcher.draftName": { en: "Plugin name", tr: "Eklenti adı" },
  "eval.launcher.draftNamePlaceholder": { en: "e.g. honest-abstention delta", tr: "örn. dürüst-çekinme deltası" },
  "eval.launcher.draftDelta": {
    en: "promptDelta (appended to the persona)",
    tr: "promptDelta (personanın sonuna eklenir)",
  },
  "eval.launcher.draftDeltaPlaceholder": {
    en: "Turkish text appended after the baseline persona…",
    tr: "Temel personadan sonra eklenecek Türkçe metin…",
  },
  "eval.launcher.draftSave": { en: "Save draft", tr: "Taslağı kaydet" },
  "eval.launcher.draftSaved": { en: "Draft plugin saved", tr: "Eklenti taslağı kaydedildi" },
  "eval.launcher.draftFailed": { en: "Draft failed", tr: "Taslak oluşturulamadı" },

  /* ── Eval · RSI — cycles (v35.2) ─────────────────────────────────────── */
  "eval.cycles.thesisPlaceholder": {
    en: "e.g. append a list-overuse rule to the persona that makes spam-guard-tr pass; safety and abstain scores stay flat; cost unchanged.",
    tr: "örn. persona sonuna ek bir liste-israfa kuralı, spam-guard-tr görevini geçer yapar; safety ve abstain skorlarını düşürmez; maliyet değişmez.",
  },
};

type I18nContextValue = {
  /** Active panel language ("en" | "tr"). */
  lang: PanelLang;
  /** Switch language (persists to localStorage, re-renders the whole panel). */
  setLang: (lang: PanelLang) => void;
  /** Translate a dictionary key with fallback: active lang, then en, then the key. */
  t: (key: string) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

/* ── Minimal external language store (localStorage + in-memory fallback) ──
 * The store is the single source of truth; the provider subscribes to it via
 * useSyncExternalStore, which is why switching re-renders every consumer.
 * `currentLang` caches the client value after the first read; if localStorage
 * is unavailable (blocked, private mode) the in-memory value still works. */
const langListeners = new Set<() => void>();
let currentLang: PanelLang | null = null; // null = not read yet (server / pre-mount)

function subscribeLang(onChange: () => void): () => void {
  langListeners.add(onChange);
  return () => {
    langListeners.delete(onChange);
  };
}

function getLangSnapshot(): PanelLang {
  if (currentLang === null) {
    try {
      const stored = window.localStorage.getItem(LANG_STORAGE_KEY);
      currentLang = stored === "tr" ? "tr" : "en";
    } catch {
      currentLang = "en";
    }
  }
  return currentLang;
}

/** Server render + hydration always start on "en" — no hydration mismatch. */
function getLangServerSnapshot(): PanelLang {
  return "en";
}

function setLangEverywhere(next: PanelLang): void {
  currentLang = next;
  try {
    window.localStorage.setItem(LANG_STORAGE_KEY, next);
  } catch {
    // Persistence failing must never break the in-memory switch.
  }
  for (const notify of langListeners) notify();
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const lang = useSyncExternalStore(subscribeLang, getLangSnapshot, getLangServerSnapshot);

  const setLang = useCallback((next: PanelLang) => setLangEverywhere(next), []);

  const value = useMemo<I18nContextValue>(() => {
    const t = (key: string): string => {
      const entry = DICTIONARY[key] as { en?: string; tr?: string } | undefined;
      if (!entry) return key; // unknown key: render the key itself
      return entry[lang] ?? entry.en ?? key;
    };
    return { lang, setLang, t };
  }, [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Panel-wide translator. Throws if used outside <I18nProvider>. */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}
