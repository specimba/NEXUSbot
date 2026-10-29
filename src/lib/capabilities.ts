import { db } from "@/lib/db";

/**
 * NEXUS OS v37 — Capability snapshot (PR0, plan §4c / §7).
 *
 * The measured D1 failure: the bot DENIED real abilities ("link açamam,
 * tıklayacak parmağım yok" — while the urlAnswer() reader lane exists) and
 * never knew a now-playing feed could exist. The persona self-model was one
 * hardcoded clause; this module makes it DATA: one cached snapshot of what
 * the panel can ACTUALLY do right now, consumed by the grounding YETENEK
 * card, the panel Brain tab, and future agent loops (/api/brain/capabilities
 * becomes a thin route over this lib).
 *
 * PERF (D7): ONE vault query (credential service/label pairs only — no
 * ciphers), cached 60s on globalThis (Turbopack multi-instance lesson).
 * Never called per-message with a fresh read: the grounding compiler reads
 * the cache and refreshes fire-and-forget.
 */

export type CapabilitySnapshot = {
  spotify: { configured: boolean; connected: boolean; nowPlayingFresh: boolean };
  exa: { armed: boolean };
  kick: { appConfigured: boolean; connected: boolean };
  vyce: { configured: boolean };
  groq: { configured: boolean };
  webResearch: { exa: boolean; zaiFallback: boolean };
  linkReader: boolean; // urlAnswer() 3-reader lane — always true
  memoryLadder: boolean; // persistent InteractionLog ladder — always true
  imagine: boolean; // grok-imagine-2 draw lane — always true
  loreCount: number;
  updatedAt: number;
};

type CapsCache = { snap: CapabilitySnapshot | null; at: number };

const g = globalThis as typeof globalThis & { __nexusCapsCache?: CapsCache };
const cache: CapsCache = g.__nexusCapsCache ?? (g.__nexusCapsCache = { snap: null, at: 0 });

/** Computed WITHOUT the vault when the cache is warm — used by sync callers. */
export function peekCapabilitySnapshot(): CapabilitySnapshot | null {
  return cache.snap;
}

const CAPS_TTL_MS = 60_000;

/** Fresh read (one vault query + lore count), then cached 60s. */
export async function getCapabilitySnapshot(): Promise<CapabilitySnapshot> {
  if (cache.snap && Date.now() - cache.at < CAPS_TTL_MS) return cache.snap;

  const pairs = new Set<string>();
  try {
    const rows = await db.credential.findMany({ select: { service: true, label: true } });
    for (const r of rows) pairs.add(`${r.service}/${r.label}`);
  } catch {
    /* vault unavailable (fresh boot) — all capabilities honestly false */
  }

  let loreCount = 0;
  try {
    const { countLore } = await import("@/lib/brain/lore");
    loreCount = await countLore();
  } catch {
    loreCount = 0;
  }

  const snap: CapabilitySnapshot = {
    spotify: {
      configured: pairs.has("spotify/app"),
      connected: pairs.has("spotify/oauth"),
      // nowPlayingFresh is patched in from the spotify pool below
      nowPlayingFresh: false,
    },
    exa: { armed: pairs.has("exa/api") },
    kick: { appConfigured: pairs.has("kick/app"), connected: pairs.has("kick/oauth") },
    vyce: { configured: pairs.has("vyce/api") },
    groq: { configured: pairs.has("groq/api-key") },
    webResearch: { exa: pairs.has("exa/api"), zaiFallback: true },
    linkReader: true,
    memoryLadder: true,
    imagine: true,
    loreCount,
    updatedAt: Date.now(),
  };

  try {
    const { peekNowPlaying, snapshotIsFresh } = await import("@/lib/connectors/spotify");
    snap.spotify.nowPlayingFresh = snapshotIsFresh(peekNowPlaying());
  } catch {
    /* connector unavailable — stays false */
  }

  cache.snap = snap;
  cache.at = Date.now();
  return snap;
}
