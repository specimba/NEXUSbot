/**
 * TEMP probe (Task 30-e) — the Kick connection e2e. Deleted after verification.
 * Usage: bun scripts/tmp-probe-30e.ts
 *
 * P7 discipline: PANEL_PASSWORD is read from process.env in-process only and
 * is NEVER printed or echoed.
 */
import crypto from "node:crypto";
import { verifyKickWebhook, mintKickAuth, spendKickAuth, KICK_SCOPES } from "@/lib/connectors/kick";

const BASE = "http://127.0.0.1:3000";
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fails += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------
// 1) Webhook RSA gate — local keypair matrix (the panel cannot sign with
//    Kick's private key, so the keyOverride proves the gate end-to-end).
// ---------------------------------------------------------------------------
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
const rawBody = JSON.stringify({
  broadcaster: { channel_slug: "specimba" },
  sender: { username: "e2e_probe_30e" },
  content: "!ai kanka saat kaç",
});
const msgId = "01J" + crypto.randomBytes(10).toString("hex").toUpperCase();
const now = new Date().toISOString();
const sign = (id: string, ts: string, body: string) =>
  crypto.sign("sha256", Buffer.from(`${id}.${ts}.${body}`), privateKey).toString("base64");

const v1 = await verifyKickWebhook({ rawBody, messageId: msgId, timestamp: now, signatureB64: sign(msgId, now, rawBody), keyOverride: pem });
check("webhook: valid RSA signature passes", v1.valid === true);

const v2 = await verifyKickWebhook({ rawBody: rawBody + " ", messageId: "01JX" + "a".repeat(10), timestamp: now, signatureB64: sign(msgId, now, rawBody), keyOverride: pem });
check("webhook: tampered body → BAD_SIGNATURE", v1.valid === true && v2.valid === false && v2.reason === "BAD_SIGNATURE");

const v3 = await verifyKickWebhook({ rawBody, messageId: msgId, timestamp: now, signatureB64: sign(msgId, now, rawBody), keyOverride: pem });
check("webhook: same message id retried → DUPLICATE (200 for Kick)", v3.valid === false && v3.reason === "DUPLICATE");

const freshId = "01JY" + crypto.randomBytes(10).toString("hex").toUpperCase();
const stale = new Date(Date.now() - 20 * 60_000).toISOString();
const v4 = await verifyKickWebhook({ rawBody, messageId: freshId, timestamp: stale, signatureB64: sign(freshId, stale, rawBody), keyOverride: pem });
check("webhook: 20-min-old timestamp → STALE", v4.valid === false && v4.reason === "STALE");

const v5 = await verifyKickWebhook({ rawBody, messageId: null, timestamp: now, signatureB64: "x", keyOverride: pem });
check("webhook: missing headers → MISSING_HEADERS", v5.valid === false && v5.reason === "MISSING_HEADERS");

// ---------------------------------------------------------------------------
// 2) PKCE mint/spend — the authorize round-trip's security core
// ---------------------------------------------------------------------------
const app = { clientId: "probe-client-id-0123456789", clientSecret: "probe-secret-0123456789abcdef" };
const { authorizeUrl } = mintKickAuth(app, "https://panel.example/api/kick/callback");
const url = new URL(authorizeUrl);
check("pkce: authorize URL host is id.kick.com", url.origin === "https://id.kick.com" && url.pathname === "/oauth/authorize");
check("pkce: response_type=code + method=S256 present", url.searchParams.get("response_type") === "code" && url.searchParams.get("code_challenge_method") === "S256");
check("pkce: scopes requested", url.searchParams.get("scope") === KICK_SCOPES.join(" "));
const challenge = url.searchParams.get("code_challenge") ?? "";
const state = url.searchParams.get("state") ?? "";
const spent = spendKickAuth(state);
check("pkce: spend returns verifier matching the challenge", !!spent && crypto.createHash("sha256").update(spent.verifier).digest("base64url") === challenge);
const spent2 = spendKickAuth(state);
check("pkce: second spend of same state → null (single-use)", spent2 === null);

console.log(fails === 0 ? "\nLIB PROBES PASS (HTTP leg runs via curl — bun fetch cannot reach loopback in this sandbox)" : `\n${fails} PROBE(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
