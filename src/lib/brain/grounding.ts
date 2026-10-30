import { db } from "@/lib/db";
import { clampStr } from "@/lib/brain/auth";
import { normalizeTr, normalizeTrTokens } from "@/lib/brain/normalize-tr";
import { getCapabilitySnapshot, type CapabilitySnapshot } from "@/lib/capabilities";
import { listLore, matchLoreCached, LORE_KEY } from "@/lib/brain/lore";
import {
  peekNowPlaying,
  snapshotIsFresh,
  getNowPlayingBounded,
  getSpotifyHistory,
  type SpotifySnapshot,
  type SpotifyTrack,
} from "@/lib/connectors/spotify";

/**
 * NEXUS OS v37 — Grounding compiler (Phase G2, plan §4).
 *
 * THE measured deficits this module closes (docs/capability-upgrade-plan.md
 * §0): D1 (bot denied real abilities — the self-model was hardcoded), D2
 * (stream-blindness: "şu an çalan şarkı" had no data source), D3 (no
 * date/time context in general chat), D4 (channel lore lived nowhere).
 *
 * Card contract: `compileGrounding(prompt)` is SYNC and reads ONLY in-process
 * caches — zero hot-path I/O (D7 budget: p95 14.5s must not grow). Stale
 * caches refresh fire-and-forget via `ensureGroundingFresh()`. The panel
 * Brain tab's 15-20s poll of /api/brain/nowplaying doubles as the heartbeat
 * keeping the Spotify snapshot warm (plan critique #4: no background timer,
 * no new mini-service).
 *
 * Prompt integration (buildSystemPrompt callers): ONE labeled block appended
 * between the memory line and the room transcript — the locked persona
 * contract and the SON EYLEMLERİN / HATIRLATMA tail are untouched. Hard
 * budget ≤900 chars, priority ŞU AN → YAYIN MÜZİĞİ → YETENEK → LORE.
 *
 * Kill-switch: Setting `brain.grounding.enabled` = "off" makes
 * compileGrounding return "" instantly (master revert, no deploy).
 */

const GROUNDING_BUDGET = 900;
const FRESH_TTL_MS = 60_000;

type GroundingRuntime = {
  freshAt: number;
  enabled: boolean;
  researchGate: boolean;
  flagsAt: number;
};

const g = globalThis as typeof globalThis & { __nexusGrounding?: GroundingRuntime };
const rt: GroundingRuntime =
  g.__nexusGrounding ?? (g.__nexusGrounding = { freshAt: 0, enabled: true, researchGate: true, flagsAt: 0 });

const GROUNDING_KEY = "brain.grounding.enabled";
const RESEARCH_GATE_KEY = "brain.researchgate.enabled";

/** Fire-and-forget cache warmer — never awaited on the message hot path. */
export function ensureGroundingFresh(): void {
  if (Date.now() - rt.freshAt < FRESH_TTL_MS) return;
  rt.freshAt = Date.now();
  void (async () => {
    try {
      await getCapabilitySnapshot();
    } catch {
      /* vault unavailable — caps stay cached/absent */
    }
    try {
      await listLore();
    } catch {
      /* lore store unavailable */
    }
    try {
      peekNowPlaying(); // warms the spotify pool + snapshot TTL refresh
    } catch {
      /* connector unavailable */
    }
    try {
      const [groundRow, gateRow] = await Promise.all([
        db.setting.findUnique({ where: { key: GROUNDING_KEY } }),
        db.setting.findUnique({ where: { key: RESEARCH_GATE_KEY } }),
      ]);
      rt.enabled = (groundRow?.value ?? "on") !== "off";
      rt.researchGate = (gateRow?.value ?? "on") !== "off";
      rt.flagsAt = Date.now();
    } catch {
      /* settings unavailable — defaults hold */
    }
  })().catch(() => {});
}

/** Master kill-switch (cached; default ON). */
export function groundingEnabledCached(): boolean {
  ensureGroundingFresh();
  return rt.enabled;
}

/** Research relevance-gate kill-switch (cached; default ON). */
export function researchGateEnabledCached(): boolean {
  ensureGroundingFresh();
  return rt.researchGate;
}

// ---------------------------------------------------------------------------
// ŞU AN — temporal grounding (D3 first half; zero I/O)
// ---------------------------------------------------------------------------

const ISTANBUL_FMT = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** "29 Ekim 2026 Perşembe 21:47" — also used by the research date-stamp. */
export function nowStampTr(): string {
  return ISTANBUL_FMT.format(new Date()).replace(/\s*$/, "");
}

export function todayStampTr(): string {
  return new Intl.DateTimeFormat("tr-TR", {
    timeZone: "Europe/Istanbul",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());
}

function suAnLine(): string {
  return `ŞU AN: ${nowStampTr()} (Europe/Istanbul). "Bugün / dün / şu an" kelimeleri bu tarihe göre yorumlanır.`;
}

// ---------------------------------------------------------------------------
// YAYIN MÜZİĞİ — Spotify now-playing grounding (D2)
// ---------------------------------------------------------------------------

function fmtMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function trackFacts(t: SpotifyTrack): string {
  const artist = t.artists || "bilinmeyen sanatçı";
  const album = t.kind === "track" && t.album ? ` (${t.album}${t.year ? `, ${t.year}` : ""})` : "";
  return `${artist} — ${t.name}${album}`;
}

function yayinLine(snap: SpotifySnapshot): string {
  const t = snap.track;
  if (!t) {
    if (snap.state === "PAUSED" || snap.state === "IDLE") {
      return `YAYIN MÜZİĞİ: şu an Spotify'da çalan bir parça YOK (${snap.state === "PAUSED" ? "duraklatılmış" : "sessiz"}).`;
    }
    return "";
  }
  const progress = t.durationMs > 0 ? `, ilerleme ${fmtMs(t.progressMs)}/${fmtMs(t.durationMs)}` : "";
  const url = t.url && !t.isLocal ? `, Spotify: ${t.url}` : "";
  const state = snap.isPlaying ? "çalıyor" : "duraklatılmış";
  // v37.4 — mention≠playback rule (measured live 2026-10-30 04:18: viewer pasted
  // "Venüs — Ben Senden Vazgeçtim (Official Video)" and the model said "Venüs
  // dinliyoruz" while this card said Epica; owner had to correct on-stream).
  // A bare track-title message is a MENTION/RECOMMENDATION, never playback state.
  return `YAYIN MÜZİĞİ (panelinden, GERÇEK): şu an ${trackFacts(t)} ${state}${progress}${url}. Sesi duyamazsın ama bu kartı görürsün — müzik sorularına bu veriyle cevap ver, parça adı uydurma. Chat'te yazılan şarkı adı BAHİS'tir, çalan parça DEĞİLDİR: çalanı yalnız bu kart bilir; kartla çelişen adı "dinliyoruz" deme, öneri/bahis diye ayır.`;
}

// ---------------------------------------------------------------------------
// YETENEK — dynamic capability self-model (D1)
// ---------------------------------------------------------------------------

function capabilityLine(caps: CapabilitySnapshot): string {
  const bits: string[] = [
    "sesi/video duyamaz, kamera ile göremezsin",
    // The urlAnswer() reader lane is REAL — the persona must claim it:
    "!ai mesajına yapıştırılan web linkini OKUYUP içeriği özetleyebilirsin",
    caps.spotify.connected
      ? "şu an çalan parçayı panelindeki Spotify hattından görürsün (sesi yok, adı var)"
      : "Spotify bağlı değil — çalan parçanın adını bilemezsin (kurulumu kanal sahibine ait)",
    caps.exa.armed
      ? "güncel konularda kaynaklı web araştırması yapabilirsin"
      : "web araştırması z-ai arama hattıyla sınırlı",
    "son mesajları hatırlarsın (hafızan var)",
  ];
  return `YETENEK DURUMUN (gerçek): ${bits.join("; ")}. Bunları İNKÂR ETMEZSİN; yapamadıklarını da böyle dürüstçe söylersin.`;
}

// ---------------------------------------------------------------------------
// LORE — channel wisdom card (D4)
// ---------------------------------------------------------------------------

function loreLine(matches: Array<{ entry: { aliases: string[]; text: string; blockResearch?: boolean }; matchedAlias: string }>): string {
  const items = matches
    .map((m) => `"${m.matchedAlias}" → ${m.entry.text}`)
    .join(" | ");
  return `KANAL BİLGELİĞİ (bu kanala ait GERÇEKler, uydurma değil): ${items}.`;
}

// ---------------------------------------------------------------------------
// compileGrounding — the ONE block buildSystemPrompt callers append
// ---------------------------------------------------------------------------

export function compileGrounding(prompt: string): string {
  if (!groundingEnabledCached()) return "";
  ensureGroundingFresh();

  const sections: string[] = [];
  const suAn = suAnLine();
  sections.push(suAn);

  // v37.2 — LORE rides SECOND, right after ŞU AN. Measured 2026-10-30: with
  // the old order (ŞU AN → YAYIN → YETENEK → LORE) a warmed YETENEK card
  // (~650 chars) + ŞU AN pushed the block over the 900 budget and the
  // tail-trim silently dropped the LORE card — the one section that answers
  // THE QUESTION ASKED ("dj nikolina kimdir" → no card → "bilmiyorum").
  // The lore card is query-specific truth; the capability card is ambient
  // self-knowledge and remains the FIRST thing the budget may drop.
  const loreMatches = matchLoreCached(prompt);
  if (loreMatches.length) {
    sections.push(loreLine(loreMatches));
  }

  const snap = peekNowPlaying();
  if (snap && snapshotIsFresh(snap)) {
    const yayin = yayinLine(snap);
    if (yayin) sections.push(yayin);
  }

  const caps = getCapabilitySnapshotCached();
  if (caps) {
    const capLine = capabilityLine(caps);
    if (capLine) sections.push(capLine);
  }

  let block = sections.join("\n");
  // Hard budget — drop from the tail (YETENEK first — ambient, regenerable;
  // ŞU AN and any lore match are the last things to go).
  if (block.length > GROUNDING_BUDGET) {
    const trimmed = sections.slice(0, Math.max(2, sections.length - 1)).join("\n");
    block = trimmed.length <= GROUNDING_BUDGET ? trimmed : clampStr(block, GROUNDING_BUDGET);
  }
  return block;
}

/** Sync cache view of the capability snapshot (never a fresh DB read). */
function getCapabilitySnapshotCached(): CapabilitySnapshot | null {
  const mod = globalThis as typeof globalThis & { __nexusCapsCache?: { snap: CapabilitySnapshot | null } };
  return mod.__nexusCapsCache?.snap ?? null;
}

// ---------------------------------------------------------------------------
// NOWPLAYING deterministic lane (plan §4d) — zero model, real data only
// ---------------------------------------------------------------------------

/** "geçen/önceki/az önce çalan parça" — the history-ring variant. */
export const PREVTRACK_RE =
  /(?:ge[çc]en|[öo]nceki|az\s*[öo]nce|son\s*(?:çalan|çald[ıi]g?))[^\n]{0,15}(?:par[çc]a|[sş]ark[ıi]|track|m[üu]zik)/i;

function pickVariant(prompt: string, pool: string[]): string {
  const sum = Array.from(String(prompt)).reduce((a, c) => (a + c.charCodeAt(0)) % 9973, 7);
  return pool[sum % pool.length];
}

/**
 * The deterministic NOWPLAYING lane reply — bounded I/O (≤1.5s, the STATUS
 * lane already blocks ~4s), honest six-state machine, rotating VYCE
 * templates (same packet → same line, LOCK_* precedent), ≤45 words, no
 * emoji, template-lint-clean by construction.
 */
export async function answerNowPlaying(prompt: string, streamerName: string): Promise<string> {
  const who = clampStr(streamerName || "specimba", 60);

  if (PREVTRACK_RE.test(prompt)) {
    const history = await getSpotifyHistory(3);
    const snap = peekNowPlaying();
    const currentlyPlaying = snap?.track?.id;
    const prev = history.find((h) => h.id !== currentlyPlaying);
    if (!prev) {
      return `Plak arşivim henüz boş kanka — Spotify bağlanınca çalanları tutmaya başlarım, o zamana kadar hafızam kulak değil kayıt üstünde.`;
    }
    const prevFacts = `${prev.artists || "bilinmeyen"} — ${prev.name}${prev.album ? ` (${prev.album})` : ""}`;
    const nowPlaying = currentlyPlaying ? ` Şu an devam edilen: ${snap!.track!.name}.` : " Şu an kulvarda ses yok.";
    return pickVariant(prompt, [
      `Az önceki plak: ${prevFacts}.${nowPlaying}`,
      `Geçen parça kaydımda şu: ${prevFacts}.${nowPlaying}`,
      `Plak arşivimden söylüyorum: ${prevFacts}.${nowPlaying}`,
    ]);
  }

  const snap = await getNowPlayingBounded();
  const t = snap.track;
  const progress = t && t.durationMs > 0 ? ` ${fmtMs(t.progressMs)}/${fmtMs(t.durationMs)} civarı.` : "";

  switch (snap.state) {
    case "PLAYING":
      if (!t) return `Plak hattı çalıyor diyor ama parça adı boş geldi — bir saniye sonra tekrar sor, kaynağı tazeliyorum.`;
      return pickVariant(prompt, [
        `Kulak tıkalı ama panelim açık kanka: şu an ${trackFacts(t)} çalıyor.${progress}`,
        `Plak hattı bildiriyor: ${trackFacts(t)}.${progress} Sesi bana girmiyor, adı bana giriyor.`,
        `Şu an kulvarda ${trackFacts(t)} gidiyor.${progress} Spotify bağlantım söylüyor, kulaklarım değil.`,
      ]);
    case "PAUSED":
      if (!t) {
        return pickVariant(prompt, [
          `Kulvarda bir parça duraklatılmış ama adı panele düşmedi — birazdan tekrar sor, kaynağı tazelerim.`,
          `Duraklatılmış bir parça var, adı henüz elime ulaşmadı — bir saniye sonra tekrar at.`,
        ]);
      }
      return pickVariant(prompt, [
        `Kulvarda ${trackFacts(t)} duraklatılmış bekliyor — devam ederse yine söylerim.`,
        `Şu an durmuş: ${trackFacts(t)}. Pause'a basılmış, sessizlikte muhabbet var.`,
      ]);
    case "IDLE":
      return pickVariant(prompt, [
        `Şu an çalan bir şey görünmüyor kanka — ya Spotify sustu ya panelim kör kaldı; ${who} halleder.`,
        `Kulvar sessiz: Spotify'da çalan parça yok. Müzik gelirse plak hattım hemen görür.`,
      ]);
    case "NOT_CONFIGURED":
      return pickVariant(prompt, [
        `Ses zaten bana girmiyor kanka, Spotify bağlantım da yok — ${who} panelden bağlarsa çalanın adını görürüm, yorumu da patlatırım.`,
        `Plak hattım kapalı: Spotify bağlı değil. Bağlanınca şu an çalanı panelimden okurum, kulağım olmadan.`,
      ]);
    case "NEEDS_REAUTH":
      return pickVariant(prompt, [
        `Spotify bağlantım bayatladı kanka — ${who} panelden yeniden Connect derse plak hattı açılır.`,
        `Plak hattı kapanmış: Spotify izni eskiydi. ${who} bir tuşa basar, yine çalanı okurum.`,
      ]);
    case "DEGRADED":
    default:
      return pickVariant(prompt, [
        `Spotify hattı şu an aksıyor, son çalana ulaşamıyorum — birazdan tekrar sor; kulak değil panel meselesi.`,
        `Plak hattı sinyal alamıyor kanka. Bir kaç dakika sonra sor, kaynağı toparlarım.`,
      ]);
  }
}

// ---------------------------------------------------------------------------
// Research relevance gate tokens (plan §6, G4) — zero-model heuristic
// ---------------------------------------------------------------------------

const TR_EN_STOPWORDS = new Set([
  "nedir","kimdir","nerede","nasil","nasil","ne","kim","hangi","neden","nicin","icin","ile","daha","cok","gibi","kadar","sonra","once","yeni","eski","bana","sana","onun","benim","senin","su","bu","o","ve","veya","ama","fakat","the","what","who","how","when","where","why","is","are","was","were","did","does","this","that","with","from","about","please","hakkinda","icinde","ustunde",
]);

/**
 * Salient tokens of a research query (normalized, stopword-stripped, len≥4,
 * capped 8) — the relevance gate compares these against the engine answer.
 */
export function researchQueryTokens(query: string): string[] {
  const tokens = normalizeTrTokens(query, 4).filter((t) => !TR_EN_STOPWORDS.has(t));
  const uniq = [...new Set(tokens)];
  return uniq.slice(0, 8);
}

/**
 * Zero-model relevance gate for the Exa answer rung (plan §6):
 * PASS when ≥2 salient query tokens appear in the answer (≥1 for
 * single-token queries). A false pass = a bad answer; a false drop = one
 * extra z-ai web-fallback rung (which already exists) — conservative by
 * design, tuned from logged `research.relevance-drop` events, never vibes.
 */
export function exaAnswerIsRelevant(query: string, answer: string): boolean {
  const tokens = researchQueryTokens(query);
  if (!tokens.length) return true; // nothing salient to check — let it pass
  const haystack = normalizeTr(answer);
  const hits = tokens.filter((t) => haystack.includes(t)).length;
  const need = tokens.length === 1 ? 1 : 2;
  return hits >= need;
}

// Re-export for route consumers (lore key shared with /api/lore).
export { LORE_KEY };
