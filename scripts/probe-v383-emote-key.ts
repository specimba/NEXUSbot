// probe-v383-emote-key.ts — v38.3 emote-dupe key normalization (re-built after
// the 2026-10-30 sandbox recycle wiped the original probe alongside the fix).
//
// DEFECT CLASS (2026-10-30 live, owner-reported emote dupe): the SAME viewer
// message arrives on two lanes with DIFFERENT emote token forms — the webhook
// lane strips numeric [emote:<digits>:<name>] at the door (EMOTE_RE) while the
// OBS overlay lane renders name-only [emote:<name>] and passes it to
// /api/brain/cortex + /api/brain/log UNSTRIPPED. trim+lowercase+collapse keys
// the two forms apart → echo guard, single-flight and row-dedupe all missed →
// the second lane double-generated (or bounced off the 8s rate guard and
// posted "Hız limiti — birkaç saniye nefes al, sıra sende." as a second row).
//
// FIX under test: shared emoteFreeNorm() consumed by echoKey() (echo guard +
// single-flight + result trail) and interactionRowDuplicate() (row dedupe).
//
// PART A (deterministic, zero-cost): row-identity checks against BOTH the
//   PRISTINE pre-fix module (staged zip copy, when present — documents the
//   defect: FAILs expected) and the LIVE module (PASS required).
// PART B (live, cheap — GLM flash chat lane only, no Exa spend, zero Kick
//   footprint, panel cortex API only):
//   B1/P1  unique nonce prompt → real generation (not echo, not rate-guard)
//   B2/P2  same prompt, numeric emote form → cortex-echo, same reply, ~0 latency
//   B3/P3  same prompt, name-only emote form → cortex-echo, same reply
//   B4     true in-flight JOIN: leader fires, follower (emote form) follows
//          120ms later mid-generation → identical reply, no rate-guard leak
// Nonces make every run's prompts unique — a stale echo cache can never
// manufacture a false PASS.
const env = await Bun.file(".env").text();
const pass = env.match(/^PANEL_PASSWORD=(.*)$/m)?.[1]?.trim();
if (!pass) throw new Error("PANEL_PASSWORD missing");
const base = "http://localhost:3000";

let fails = 0;
let passCount = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  if (ok) passCount++;
  else fails++;
};

// ---------------------------------------------------------------------------
// PART A — deterministic row-identity checks (interactionRowDuplicate)
// ---------------------------------------------------------------------------
const nonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

async function partA(modLabel: string, mod: typeof import("../src/lib/brain/cortex.ts"), counted: boolean) {
  console.log(`\n--- PART A (${modLabel}) ---`);
  const { interactionRowDuplicate } = mod;
  const u = (tag: string) => `${modLabel}-a-${tag}-${nonce}`;
  // PREFIX runs are defect DOCUMENTATION: the pristine pre-fix module is
  // EXPECTED to fail the emote-identity checks — those lines never count
  // toward the gate; only POSTFIX does.
  const checkA = (label: string, ok: boolean, detail = "") => {
    if (counted) check(label, ok, detail);
    else console.log(`${ok ? "UNEXPECTED-PASS" : "DEFECT-CONFIRMED"} ${label}${detail ? " — " + detail : ""}`);
  };

  // A1: numeric emote form vs plain — ONE row identity.
  interactionRowDuplicate(u("1"), "selam [emote:25954:hey] nasılsın kanka", "iyi kanka sen nasılsın");
  checkA(
    `A1 ${modLabel}: numeric-emote form vs plain form → same row`,
    interactionRowDuplicate(u("1"), "selam nasılsın kanka", "iyi kanka sen nasılsın") === true,
  );

  // A2: reverse direction — plain recorded first, name-only emote probe second.
  interactionRowDuplicate(u("2"), "selam nasılsın kanka", "iyi kanka sen nasılsın");
  checkA(
    `A2 ${modLabel}: plain form vs name-only emote form → same row`,
    interactionRowDuplicate(u("2"), "selam [emote:hey] nasılsın kanka", "iyi kanka sen nasılsın") === true,
  );

  // A3: mixed numeric/name emotes with uneven spacing → same row.
  interactionRowDuplicate(u("3"), "[emote:7:w] selam   [emote:8:x] nasılsın [emote:9:y]", "iyi kanka");
  checkA(
    `A3 ${modLabel}: multi-emote + whitespace runs → same row`,
    interactionRowDuplicate(u("3"), "selam nasılsın", "iyi kanka") === true,
  );

  // A4: response-half normalization — replies differing only in emote tokens.
  interactionRowDuplicate(u("4"), "selam", "cevap [emote:1:xd] metni kanka");
  checkA(
    `A4 ${modLabel}: response halves differing only in emotes → same row`,
    interactionRowDuplicate(u("4"), "selam", "cevap metni kanka") === true,
  );

  // A5: NO over-strip — [link]/[spoiler] brackets are NOT emotes.
  interactionRowDuplicate(u("5"), "bu ne kanka", "bir link");
  checkA(
    `A5 ${modLabel}: [link]/[spoiler] NOT stripped (no over-normalization)`,
    interactionRowDuplicate(u("5"), "[link] bu ne kanka", "bir link") === false,
  );

  // A6: different messages stay different rows (guard against collapse-to-all).
  interactionRowDuplicate(u("6"), "selam nasılsın", "iyi");
  checkA(
    `A6 ${modLabel}: distinct prompts stay distinct`,
    interactionRowDuplicate(u("6"), "selam gidiyor musun", "iyi") === false,
  );
}

// PRISTINE pre-fix module — the staged zip copy of cortex.ts (exists only on
// this recovery box; skipped silently elsewhere). Expected: A1-A4 FAIL.
const pristinePath = "/home/z/restore-staging/drive/x-1030-1/src/lib/brain/cortex.ts";
if (await Bun.file(pristinePath).exists()) {
  try {
    const pristine = (await import(pristinePath)) as typeof import("../src/lib/brain/cortex.ts");
    await partA("PREFIX", pristine, false);
  } catch (e) {
    console.log(`(PREFIX module import failed — skipping defect documentation: ${e})`);
  }
} else {
  console.log("(PREFIX pristine module not staged — skipping defect documentation)");
}

// LIVE module — the fixed code. PASS required.
await partA("POSTFIX", await import("../src/lib/brain/cortex.ts"), true);

// ---------------------------------------------------------------------------
// PART B — live lanes (login + /api/brain/cortex)
// ---------------------------------------------------------------------------
const login = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: pass }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
console.log(`\nlogin: ${login.status}`);
if (login.status !== 200) throw new Error("login failed");

async function probe(label: string, body: Record<string, unknown>) {
  const t0 = Date.now();
  const r = await fetch(`${base}/api/brain/cortex`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  const j = (await r.json()) as Record<string, unknown>;
  console.log(`\n${label}: status=${r.status} route=${j.route} engine=${j.modelId} latency=${ms}ms`);
  console.log(`  reply: "${String(j.reply ?? "").slice(0, 140)}"`);
  return { j, ms };
}

const RATE_GUARD_RE = /hız limiti|birkaç saniye nefes al|sıra sende/i;

// B1/P1 — a real unique chat prompt: real generation, not echo, not rate-guard.
const p1Sender = `v383p1-${nonce}`;
const p1Prompt = `v383 test ${nonce} kanka bana kisa bir selam ver`;
const b1 = await probe("B1/P1 real answer", { sender: p1Sender, prompt: p1Prompt });
check(
  "B1 real generation: answered (not echo, not rate-guard)",
  String(b1.j.route) !== "cortex-echo" && String(b1.j.route) !== "cortex-rate" && !RATE_GUARD_RE.test(String(b1.j.reply ?? "")) && String(b1.j.reply ?? "").length > 10,
  `route=${b1.j.route} reply="${String(b1.j.reply ?? "").slice(0, 80)}"`,
);

// B2/P2 — same message re-arrives with a NUMERIC emote token (webhook-form key
// vs overlay-form payload): must resolve to the SAME answer via the echo
// guard — not a second generation, not the rate-guard row.
const b2 = await probe("B2/P2 numeric-emote replay", {
  sender: p1Sender,
  prompt: `v383 test ${nonce} [emote:25954:hey] kanka bana kisa bir selam ver`,
});
check(
  "B2 numeric-emote replay: SAME reply as P1",
  String(b2.j.reply ?? "") === String(b1.j.reply ?? ""),
  `route=${b2.j.route}`,
);
check(
  "B2 numeric-emote replay: served from echo cache (cortex-echo)",
  String(b2.j.route) === "cortex-echo",
  `route=${b2.j.route}`,
);
check(
  "B2 numeric-emote replay: no rate-guard leak",
  !RATE_GUARD_RE.test(String(b2.j.reply ?? "")),
  `reply="${String(b2.j.reply ?? "").slice(0, 80)}"`,
);
check(
  "B2 numeric-emote replay: ~zero latency (cache hit, no second spend)",
  b2.ms < 1500,
  `${b2.ms}ms vs P1 ${b1.ms}ms`,
);

// B3/P3 — same message with a NAME-ONLY emote token (the exact overlay form).
const b3 = await probe("B3/P3 name-only-emote replay", {
  sender: p1Sender,
  prompt: `v383 test ${nonce} [emote:hey] kanka bana kisa bir selam ver`,
});
check(
  "B3 name-only-emote replay: SAME reply as P1",
  String(b3.j.reply ?? "") === String(b1.j.reply ?? ""),
  `route=${b3.j.route}`,
);
check(
  "B3 name-only-emote replay: cortex-echo, no rate-guard",
  String(b3.j.route) === "cortex-echo" && !RATE_GUARD_RE.test(String(b3.j.reply ?? "")),
  `route=${b3.j.route}`,
);

// B4 — TRUE IN-FLIGHT JOIN: the leader's generation is still running when the
// overlay lane's emote-form copy arrives. Pre-fix the follower missed the
// single-flight (different key) and hit the rate guard; post-fix it joins the
// leader's promise — identical reply, one spend.
const b4Sender = `v383j-${nonce}`;
const b4Prompt = `v383 join ${nonce} kanka bana gunun ozetini iki cumlede anlat`;
const leaderP = probe("B4 leader (in-flight)", { sender: b4Sender, prompt: b4Prompt });
await new Promise((r) => setTimeout(r, 120)); // leader is mid-generation here
const followerP = probe("B4 follower (emote form, 120ms later)", {
  sender: b4Sender,
  prompt: `v383 join ${nonce} [emote:25954:hey] kanka bana gunun ozetini iki cumlede anlat`,
});
const [leader, follower] = await Promise.all([leaderP, followerP]);
check(
  "B4 leader: real generation (not echo, not rate-guard)",
  String(leader.j.route) !== "cortex-echo" && String(leader.j.route) !== "cortex-rate",
  `route=${leader.j.route}`,
);
check(
  "B4 follower: IDENTICAL reply to leader (joined or echoed — never a dupe)",
  String(follower.j.reply ?? "") === String(leader.j.reply ?? ""),
  `follower route=${follower.j.route} leader route=${leader.j.route}`,
);
check(
  "B4 follower: no rate-guard leak",
  !RATE_GUARD_RE.test(String(follower.j.reply ?? "")),
  `reply="${String(follower.j.reply ?? "").slice(0, 80)}"`,
);
check(
  "B4 follower: joined in-flight (same route as leader, not a second flight)",
  String(follower.j.route) === String(leader.j.route) || String(follower.j.route) === "cortex-echo",
  `follower=${follower.j.route}`,
);

// ---------------------------------------------------------------------------
console.log(`\n=== v38.3 emote-key probe: ${fails === 0 ? "ALL PASS" : "FAILURES"} (${passCount} pass / ${fails} fail) ===`);
process.exit(fails === 0 ? 0 : 1);
