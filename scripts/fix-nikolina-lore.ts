/**
 * Owner directive 2026-10-30: DJ Nikolina is a REAL DJ — the bot's "hayalet DJ"
 * claim was a lie born from poisoned lore (now cleared; brain.lore was empty).
 * This writes the CORRECT owner-authored ground-truth entry.
 */
import { upsertLore } from "../src/lib/brain/lore";

async function main() {
  const res = await upsertLore({
    aliases: ["dj nikolina", "nikolina", "nikolınah", "nikolinanın", "nikolina dj"],
    text:
      "DJ Nikolina GERÇEK bir DJ'dir — hayalet/uydurma değildir. 26 Aralık 2026'da İstanbul 74 Hall'de sahne vereceğini duyurdu (duyuru 30 Ekim 2026). Önceden söylenen 'hiç var olmadı' iddiası yanlıştı ve bir daha tekrarlanmayacak. Sorulursa: gerçek DJ, 26 Aralık, İstanbul 74 Hall.",
    blockResearch: true,
  });
  console.log(res.ok ? "LORE OK: " + JSON.stringify(res.entry) : "LORE FAIL: " + res.error);
}
main().then(() => process.exit(0));
