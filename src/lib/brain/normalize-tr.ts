/**
 * NEXUS OS v37 — Turkish-aware text normalization (grounding lane).
 *
 * WHY THIS EXISTS (plan §5, docs/capability-upgrade-plan.md): JS
 * `toLowerCase()` folds "İ" (U+0130, dotted capital I) to itself+i-dot in
 * some engines — the classic Turkish case-folding pitfall — and lore
 * aliases written diacritic-less ("dj nikolına") must match prompts written
 * with proper Turkish ("DJ Nikolina"), and vice versa. Lore matching,
 * research relevance tokens and now-playing route gates all normalize BOTH
 * sides through this single function instead of hand-rolling per feature.
 *
 * Deterministic, allocation-light, no locale APIs (node's toLocaleLowerCase
 * depends on full ICU which the runtime does not guarantee).
 */

const TR_UPPER_TO_LOWER: Record<string, string> = {
  Ç: "c",
  Ğ: "g",
  İ: "i",
  Ö: "o",
  Ş: "s",
  Ü: "u",
  Â: "a",
  Î: "i",
  Û: "u",
  É: "e",
  Ë: "e",
};

/** Fold a single code point to the NEXUS lore/token alphabet (ASCII a-z, 0-9). */
function foldChar(ch: string): string {
  const up = ch.toUpperCase();
  if (TR_UPPER_TO_LOWER[up] !== undefined) return TR_UPPER_TO_LOWER[up];
  const low = ch.toLowerCase();
  if (low >= "a" && low <= "z") return low;
  if (low >= "0" && low <= "9") return low;
  // ı/I family folds to i; ASCII I/i already handled above.
  if (low === "ı" || low === "i") return "i";
  if (low === "ç") return "c";
  if (low === "ğ") return "g";
  if (low === "ö") return "o";
  if (low === "ş") return "s";
  if (low === "ü") return "u";
  if (low === "â" || low === "à" || low === "á" || low === "ã" || low === "å") return "a";
  if (low === "é" || low === "è" || low === "ê" || low === "ë") return "e";
  if (low === "î" || low === "ì" || low === "í") return "i";
  if (low === "ô" || low === "õ") return "o";
  if (low === "û" || low === "ù" || low === "ú") return "u";
  return "";
}

/**
 * Full normalization: case-fold (Turkish-correct) + diacritic-strip +
 * punctuation/whitespace-strip → lowercase ASCII alnum stream.
 * "DJ Nikolina'nın" → "djnikolinanin"   ("şuan çalan şarkı" → "suancalansarki")
 */
export function normalizeTr(input: string): string {
  const src = String(input ?? "");
  let out = "";
  for (const ch of src) out += foldChar(ch);
  return out;
}

/**
 * Token view of the same normalization — split FIRST, then fold: folding
 * the whole string first would merge words ("Cami Toro" → "camitoro") and
 * the relevance gate would never find them in answers. Splits on anything
 * that is not a Unicode letter/number, folds each token via normalizeTr.
 */
export function normalizeTrTokens(input: string, minLen = 1): string[] {
  return String(input ?? "")
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => normalizeTr(t))
    .filter((t) => t.length >= minLen);
}
