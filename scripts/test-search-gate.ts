/**
 * Sanity harness: run the exact chat messages from the owner's Hyperbrowser
 * dashboard through the v29.11 classify() + wantsWebSearch() + cleanSearchQuery()
 * logic. Expected: nonsense mentions → FAST_BANTER / skipped_intent (zero
 * credits); explicit research → DEEP_RESEARCH / allowed.
 */
const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);

function classify(text: string) {
  const t = text.toLowerCase();
  if (
    /(ne\s*anlatıyon.*müzik\s*soruyoz|müzik\s*soruyoz\s*sanatçı|şarkıyı\s*soruyoz|sanatçıyı\s*soruyoz)/i.test(t)
  )
    return "MUSIC_REDIRECT_SCOLD";
  if (
    /(unut\s*şu|meselesini.*unut|tamamen\s*unut|sil\s*hafızandan|hafızayı\s*sıfırla|kendine\s*gel|hay\s*boss|boss\s*unun\s*da|stratejinin\s*de\s*amk|mallaştın\s*yine|hay\s*kahve|kapat\s*şu\s*konuyu)/i.test(t)
  )
    return "TOPIC_KILLER";
  if (/(mimarın\s*mıyım|mimarın\s*kim|gerçek\s*mimar\s*kim|baş\s*mimar\s*kim)/i.test(t))
    return "SARCASM_ROAST";
  if (
    /(haklıyım\s*demi|haklı\s*mıyım|sen\s*ne\s*diyosun|nasıl\s*yani|yönetmenlik|üyelere\s*özel)/i.test(t)
  )
    return "MONOLOGUE_VALIDATION";
  if (
    /(hyperbrowser.*(dene|test|çalıştır)|supabase.*(test|dene|kontrol))/i.test(t)
  )
    return "TOOL_DIAGNOSTIC";
  if (/(mod\s*kim|moderatör\s*kim|modlar\s*kim|vip\s*kim)/i.test(t))
    return "MOD_ROSTER";
  if (/https?:\/\//i.test(t) || /playlist|spotify|çalma listesi/.test(t))
    return "URL_OR_PLAYLIST";
  if (
    /((bu|şu|hangi|kaçı)\s*(şarkı|parça|sanatçı|müzik|albüm)|şarkı(nın|nin|nu\s*mun)?\s*(adı|ismi|sözleri|sözü|kime|kimin)|sanatçının\s*(adı|ismi|kim)|kim\s*(söylüyor|söylüyo|söylemekte|diye\s*söylüyor)|kimin\s*(şarkısı|eseri|parçası|bestesi)|nereden\s*(çalıyor|çıktı|geldi)|hangi\s*(grup|dj)|(sanatçı|şarkıcı|dj|grup)\s*(kim|nedir|kimsin))/i.test(t)
  )
    return "MUSIC_ARTIST_QUERY";
  if (
    /(araştır|research|gündem|son\s*dakika|haber(ler)?|güncel|en\s*son|en\s*yeni|son\s*gelişmeler|gelişme(ler)?\s*(ne|var)|bugün.*ne\s*(var|oldu)|kimdir|nedir|kim\s*bu|ne\s*zaman|nereli|kaç\s*yaşında|kaç\s*para|fiyat|döviz|bitcoin|kripto|skor|maç\s*(sonucu|kaç)|latest|news)/i.test(t)
  )
    return "DEEP_RESEARCH";
  return "FAST_BANTER";
}

const RESEARCH_INTENT_RE =
  /(araştır|research|gündem|son\s*dakika|haber|güncel|en\s*son|en\s*yeni|son\s*gelişmeler|bugün.*ne\s*(var|oldu)|kimdir|nedir|kim\s*bu|ne\s*zaman|nereli|kaç\s*yaşında|kaç\s*para|fiyat|döviz|bitcoin|kripto|skor|maç\s*sonucu|latest|news)/i;
const MUSIC_QUESTION_RE =
  /((bu|şu|hangi|kaçı)\s*(şarkı|parça|sanatçı|müzik|albüm)|şarkı(nın)?\s*(adı|ismi|sözleri|sözü|kime|kimin)|sanatçının\s*(adı|ismi|kim)|kim\s*(söylüyor|söylüyo|söylemekte)|kimin\s*(şarkısı|eseri|parçası|bestesi)|nereden\s*(çalıyor|çıktı)|(sanatçı|şarkıcı|dj|grup)\s*(kim|nedir|kimsin))/i;

function wantsWebSearch(text: string): boolean {
  const t = clip(text, 400);
  if (t.trim().length < 4) return false;
  if (!/[a-zçğıöşü0-9]/i.test(t)) return false;
  return RESEARCH_INTENT_RE.test(t) || MUSIC_QUESTION_RE.test(t);
}

function cleanSearchQuery(text: string): string {
  return clip(
    String(text ?? "")
      .replace(/^!?\s*(ai|nexus)\s+/i, "")
      .replace(/^\s*(araştır|research|bak|search)\s*[:,-]?\s*/i, "")
      .replace(/\s+/g, " ")
      .trim(),
    240,
  );
}

const cases: Array<[string, string, boolean]> = [
  // [message, expected intent, expected wantsWebSearch]
  ["müzik dinlemek istemiyorum o kadını çizmeni istiyorum", "FAST_BANTER", false],
  ["müzik fena killoki çalıyo görebiliyon mu", "FAST_BANTER", false],
  ["bugün yapay zeka dünyasında en son ne var?", "DEEP_RESEARCH", true],
  ["araştır: yapay zeka haberleri bugün ne var", "DEEP_RESEARCH", true],
  ["çiz goth güzel bir slavic kız", "FAST_BANTER", false],
  ["bu şarkı kimin söylüyor çok güzel", "MUSIC_ARTIST_QUERY", true],
  ["sanatçı kim bu", "MUSIC_ARTIST_QUERY", true],
  ["ben mimar roboticin hesaptan baglandim silerim seni", "FAST_BANTER", false],
  ["healer çalıyor abi", "FAST_BANTER", false],
  ["techno fena gidiyor", "FAST_BANTER", false],
  ["openai yeni model çıkardı galiba", "FAST_BANTER", false],
  ["gündem ne", "DEEP_RESEARCH", true],
  ["son dakika haberleri", "DEEP_RESEARCH", true],
  ["kim bu tanju özcan", "DEEP_RESEARCH", true],
  ["berlinde hava nasıl", "FAST_BANTER", false],
  ["şarkının adı ne bu", "MUSIC_ARTIST_QUERY", true],
  ["ne anlatıyon ya müzik soruyoz sanatçı", "MUSIC_REDIRECT_SCOLD", false],
  ["döviz ne durumda", "DEEP_RESEARCH", true],
  ["aynen öyle abi hahah", "FAST_BANTER", false],
  ["", "FAST_BANTER", false],
];

let pass = 0, fail = 0;
for (const [msg, wantIntent, wantSearch] of cases) {
  const gotIntent = classify(msg);
  const gotSearch = wantsWebSearch(cleanSearchQuery(msg));
  const ok = gotIntent === wantIntent && gotSearch === wantSearch;
  if (ok) pass++;
  else { fail++; console.log(`FAIL: "${msg}" → intent=${gotIntent} (want ${wantIntent}) search=${gotSearch} (want ${wantSearch})`); }
}
console.log(`${pass}/${pass + fail} passed`);
console.log("clean('araştır: yapay zeka haberleri bugün ne var') =", JSON.stringify(cleanSearchQuery("araştır: yapay zeka haberleri bugün ne var")));
console.log("clean('!ai araştır gündem') =", JSON.stringify(cleanSearchQuery("!ai araştır gündem")));
