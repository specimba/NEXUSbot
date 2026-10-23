/**
 * NEXUS OS — deploy + verify the nexus-relay Edge Function (task 17-a).
 *
 * Idempotent, run from project root:  bun run scripts/deploy-nexus-relay.ts
 *
 * a. PAT via getMgmtPat() (vault service "supabase" / label "mgmt"; decrypted
 *    in-process, NEVER printed).
 * b. Relay secret provisioning: vault service "supabase" / label "relay-secret"
 *    ⇄ EF secret NEXUS_PANEL_RELAY_SECRET on harness project vwottesqbdgcsmvvvzok.
 *    Missing → generate randomBytes(32).toString("hex") (64 chars), upsert EF
 *    secret, store plaintext in the vault with encryptSecret (same upsert
 *    pattern as storeVyceKey). Present → upsert the SAME value to the EF secret
 *    (self-heal; never rotate). MEASURED 17-a: the prescribed shared helper
 *    mgmtUpsertSecrets({key,value}) answers 400 (API evolved to {name,value});
 *    this script sends {name,value} first and keeps the {key,value} shape as
 *    fallback (both shapes recorded in the run output).
 * c. Deploy via Mgmt API POST /v1/projects/{ref}/functions/deploy — multipart
 *    (metadata + files[] parts) first, JSON variant as fallback; MEASURED shape
 *    is printed. verify_jwt: false (auth is the relay-secret header).
 * d. Verification (P7-safe output: statuses, booleans, byte counts, model
 *    COUNTS + model ids only — never the PAT, relay secret, or upstream keys):
 *      GET  /health                      → 200 + upstream booleans
 *      GET  /vyce/v1/models wrong bearer → 401 UNAUTHORIZED from the relay
 *      GET  /vyce/v1/models real bearer  → MEASURE (200 count+3 ids / 401 pass-through / other)
 *      GET  /groq/openai/v1/models       → MEASURE (Groq 403 WAF is sandbox-only; EF runs on Supabase)
 *      POST /vyce/v1/chat/completions    → only if Vyce models returned 200; status + finish_reason only
 * e. Exit non-zero if deploy or the health check fails.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { db } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getMgmtPat, mgmtUpsertSecrets } from "@/lib/connectors/supabase";
import { sanitizeSecretText } from "@/lib/connectors/vyce";

const PROJECT_REF = "vwottesqbdgcsmvvvzok";
const MGMT_BASE = "https://api.supabase.com";
const RELAY_SLUG = "nexus-relay";
const EF_RELAY_SECRET_KEY = "NEXUS_PANEL_RELAY_SECRET";
const VAULT_SERVICE = "supabase";
const VAULT_LABEL = "relay-secret";
const FUNCTIONS_BASE = `https://${PROJECT_REF}.supabase.co/functions/v1/${RELAY_SLUG}`;

const SOURCE_PATH = join(import.meta.dir, "..", "supabase", "functions", RELAY_SLUG, "index.ts");

// ---------------------------------------------------------------------------
// P7-safe output helpers: statuses, booleans, counts, model ids — no values.
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.log(msg);
}

function safeErrorFields(body: unknown): string {
  if (body === null || typeof body !== "object") return "(non-JSON body)";
  const o = body as Record<string, unknown>;
  const err = (o.error ?? o) as Record<string, unknown>;
  const code = typeof err.code === "string" ? err.code : typeof err.error_code === "string" ? err.error_code : null;
  const message = typeof err.message === "string" ? err.message : null;
  if (code === null && message === null) return "(no code/message fields)";
  return `${code ?? "-"} ${message ? `"${message}"` : ""}`.trim();
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown; byteLength: number }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body, byteLength: text.length };
}

// ---------------------------------------------------------------------------
// b. Relay secret provisioning (vault ⇄ EF secret, same plaintext both sides)
// ---------------------------------------------------------------------------

/** storeVyceKey-pattern upsert (service "supabase", label "relay-secret"). */
async function storeRelaySecret(value: string): Promise<void> {
  const { keyId, cipher } = encryptSecret(value);
  await db.credential.upsert({
    where: { service_label: { service: VAULT_SERVICE, label: VAULT_LABEL } },
    create: { service: VAULT_SERVICE, label: VAULT_LABEL, keyId, cipher },
    update: { keyId, cipher },
  });
}

async function resolveRelaySecret(): Promise<{ value: string; vaultState: "created" | "existed" | "reStored-sanitized" }> {
  const row = await db.credential.findUnique({
    where: { service_label: { service: VAULT_SERVICE, label: VAULT_LABEL } },
  });
  if (row) {
    const raw = decryptSecret(row.cipher);
    const value = sanitizeSecretText(raw); // paste hygiene (16-a pattern)
    if (value !== raw) {
      await storeRelaySecret(value); // self-heal hygiene, same plaintext semantics
      return { value, vaultState: "reStored-sanitized" };
    }
    return { value, vaultState: "existed" };
  }
  const value = randomBytes(32).toString("hex"); // 64 hex chars
  await storeRelaySecret(value);
  return { value, vaultState: "created" };
}

type SecretUpsertOutcome = { status: number; shape: string };

async function upsertSecretsNameShape(pat: string, key: string, value: string): Promise<number> {
  // MEASURED 17-a: Mgmt POST /v1/projects/{ref}/secrets expects [{name, value}]
  // (matches the GET rows {name, updated_at, value}); {key, value} → 400.
  const res = await fetchJson(`${MGMT_BASE}/v1/projects/${PROJECT_REF}/secrets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
    body: JSON.stringify([{ name: key, value }]),
    signal: AbortSignal.timeout(8_000),
  });
  return res.status;
}

async function upsertEfRelaySecret(pat: string, value: string): Promise<SecretUpsertOutcome> {
  const attempts: Array<{ shape: string; run: () => Promise<number> }> = [
    { shape: "POST /secrets [{name,value}]", run: () => upsertSecretsNameShape(pat, EF_RELAY_SECRET_KEY, value) },
    { shape: "POST /secrets [{key,value}] (mgmtUpsertSecrets)", run: async () => {
      let status = 0;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const res = await mgmtUpsertSecrets(pat, PROJECT_REF, [{ key: EF_RELAY_SECRET_KEY, value }]);
        status = res.status;
        if (status !== 0) break; // transport failure (status 0) → retry; HTTP answers are final
        if (attempt < 3) await new Promise((r) => setTimeout(r, 2_000));
      }
      return status;
    } },
  ];
  let lastMeasured: SecretUpsertOutcome = { status: 0, shape: "none" };
  for (const attempt of attempts) {
    let status = 0;
    for (let attemptNo = 1; attemptNo <= 3; attemptNo++) {
      status = await attempt.run();
      if (status !== 0) break; // transport failure (status 0) → retry; HTTP answers are final
      if (attemptNo < 3) await new Promise((r) => setTimeout(r, 2_000));
    }
    lastMeasured = { status, shape: attempt.shape };
    if (status >= 200 && status < 300) return lastMeasured;
    log(`  EF secret upsert via ${attempt.shape} → HTTP ${status}`);
  }
  return lastMeasured;
}

// ---------------------------------------------------------------------------
// c. Deploy via Mgmt API (multipart first; JSON variant as measured fallback)
// ---------------------------------------------------------------------------

type DeployResult = { status: number; body: unknown; byteLength: number };

function deployMetadata(): Record<string, unknown> {
  return { slug: RELAY_SLUG, verify_jwt: false, entrypoint_path: "index.ts" };
}

/** Deterministic hand-rolled multipart body (no FormData serializer in the way). */
function multipartBody(partName: string, source: string): { bytes: Uint8Array; boundary: string } {
  const boundary = `----nexus-relay-${Date.now().toString(16)}`;
  const enc = new TextEncoder();
  const metaPart = enc.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="metadata"\r\n` +
      `Content-Type: application/json\r\n` +
      `\r\n` +
      `${JSON.stringify(deployMetadata())}\r\n`,
  );
  const fileHeader = enc.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${partName}"; filename="index.ts"\r\n` +
      `Content-Type: application/octet-stream\r\n` +
      `\r\n`,
  );
  const fileContent = enc.encode(source);
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const bytes = new Uint8Array(metaPart.length + fileHeader.length + fileContent.length + tail.length);
  bytes.set(metaPart, 0);
  bytes.set(fileHeader, metaPart.length);
  bytes.set(fileContent, metaPart.length + fileHeader.length);
  bytes.set(tail, metaPart.length + fileHeader.length + fileContent.length);
  return { bytes, boundary };
}

function deployUrl(): string {
  return `${MGMT_BASE}/v1/projects/${PROJECT_REF}/functions/deploy?slug=${RELAY_SLUG}`;
}

async function deployHandrolled(pat: string, source: string, partName: string): Promise<DeployResult> {
  const { bytes, boundary } = multipartBody(partName, source);
  return fetchJson(deployUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: bytes,
    signal: AbortSignal.timeout(30_000),
  });
}

async function deployFormData(pat: string, source: string, filesPartName: string): Promise<DeployResult> {
  const form = new FormData();
  form.append("metadata", JSON.stringify(deployMetadata()));
  form.append(filesPartName, new File([source], "index.ts", { type: "text/typescript" }));
  return fetchJson(deployUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
}

async function deployJson(pat: string, source: string): Promise<DeployResult> {
  return fetchJson(`${MGMT_BASE}/v1/projects/${PROJECT_REF}/functions/deploy`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
    body: JSON.stringify({ metadata: deployMetadata(), files: [{ name: "index.ts", content: source }] }),
    signal: AbortSignal.timeout(30_000),
  });
}

async function deployFunction(pat: string, source: string): Promise<{ result: DeployResult; shape: string } | null> {
  const attempts: Array<{ shape: string; run: () => Promise<DeployResult> }> = [
    { shape: "hand-rolled multipart name=file filename=index.ts (docs: body param is `file`)", run: () => deployHandrolled(pat, source, "file") },
    { shape: "hand-rolled multipart name=file[] filename=index.ts", run: () => deployHandrolled(pat, source, "file[]") },
    { shape: "hand-rolled multipart name=files filename=index.ts", run: () => deployHandrolled(pat, source, "files") },
    { shape: "Bun FormData metadata + file[]", run: () => deployFormData(pat, source, "file[]") },
    { shape: "JSON {metadata, files:[{name,content}]}", run: () => deployJson(pat, source) },
  ];
  for (const attempt of attempts) {
    const result = await attempt.run();
    const ok = result.status === 200 || result.status === 201;
    log(`deploy attempt [${attempt.shape}] → HTTP ${result.status} (body ${result.byteLength} bytes)`);
    if (ok) return { result, shape: attempt.shape };
    log(`  deploy attempt failed: ${safeErrorFields(result.body)}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// d. Verification probes (P7-safe)
// ---------------------------------------------------------------------------

async function probeRelay(
  path: string,
  init?: { method?: "GET" | "POST"; bearer?: string; body?: string; timeoutMs?: number },
): Promise<{ status: number; body: unknown; byteLength: number }> {
  const headers: Record<string, string> = {};
  if (init?.bearer !== undefined) headers.Authorization = `Bearer ${init.bearer}`;
  if (init?.body !== undefined) headers["Content-Type"] = "application/json";
  return fetchJson(`${FUNCTIONS_BASE}${path}`, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body,
    signal: AbortSignal.timeout(init?.timeoutMs ?? 20_000),
  });
}

async function waitForHealth(): Promise<{ ok: boolean; body: unknown; status: number }> {
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      const res = await probeRelay("/health", { timeoutMs: 15_000 });
      if (res.status === 200 && (res.body as { ok?: unknown } | null)?.ok === true) {
        return { ok: true, body: res.body, status: res.status };
      }
      log(`health attempt ${attempt}: HTTP ${res.status} (body ${res.byteLength} bytes)`);
    } catch (err) {
      const name = err instanceof Error ? err.name : "unknown";
      log(`health attempt ${attempt}: transport ${name}`);
    }
    await new Promise((r) => setTimeout(r, 2_500));
  }
  return { ok: false, body: null, status: 0 };
}

/** Print P7-safe model probe: 200 → count + 3 ids; 401/other → status + code. */
function printModelsProbe(label: string, res: { status: number; body: unknown; byteLength: number }): { models200: boolean } {
  log(`${label} → HTTP ${res.status}`);
  if (res.status === 200 && res.body !== null && typeof res.body === "object") {
    const o = res.body as { data?: unknown };
    const list = Array.isArray(o.data) ? o.data : null;
    if (list) {
      const ids = list
        .map((m) => (m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string" ? (m as { id: string }).id : null))
        .filter((id): id is string => id !== null);
      log(`  models count: ${ids.length}`);
      log(`  example ids: ${ids.slice(0, 3).join(", ") || "(none)"}`);
      return { models200: true };
    }
    log(`  200 with unrecognized /models payload shape (body ${res.byteLength} bytes)`);
    return { models200: false };
  }
  if (res.body !== null) log(`  body: ${safeErrorFields(res.body)}`);
  else log(`  non-JSON body (${res.byteLength} bytes)`);
  return { models200: false };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  log(`[1/4] vault: loading Mgmt PAT (service "${VAULT_SERVICE}" / label "mgmt")`);
  const pat = await getMgmtPat();
  if (!pat) {
    log("FATAL: Mgmt PAT not stored in the vault — save it on the Supabase card first.");
    return 1;
  }
  log(`  PAT present (length ${pat.length}, decrypted in-process only)`);

  log(`[2/4] relay secret provisioning (vault service "${VAULT_SERVICE}" / label "${VAULT_LABEL}")`);
  const { value: relaySecret, vaultState } = await resolveRelaySecret();
  log(`  vault state: ${vaultState} (value: 64-char hex, never printed)`);
  const ef = await upsertEfRelaySecret(pat, relaySecret);
  if (ef.status < 200 || ef.status >= 300) {
    log(`  EF secret upsert NEXUS_PANEL_RELAY_SECRET → HTTP ${ef.status} (last shape tried: ${ef.shape})`);
    log("FATAL: EF relay-secret upsert failed — relay auth cannot work.");
    return 1;
  }
  log(`  EF secret upsert NEXUS_PANEL_RELAY_SECRET → HTTP ${ef.status} via ${ef.shape}`);

  log("[3/4] deploying edge function");
  const source = await Bun.file(SOURCE_PATH).text();
  log(`  source: ${SOURCE_PATH} (${source.length} bytes, ${source.split("\n").length} lines)`);
  const deployed = await deployFunction(pat, source);
  if (!deployed) {
    log("FATAL: all deploy variants failed.");
    return 1;
  }
  const summary = (deployed.result.body ?? {}) as Record<string, unknown>;
  log(
    `  deployed via ${deployed.shape}; slug=${typeof summary.slug === "string" ? summary.slug : "?"} status=${
      typeof summary.status === "string" ? summary.status : "?"
    } verify_jwt=${String(summary.verify_jwt)}`,
  );

  log("[4/4] verification probes (P7-safe output)");
  const health = await waitForHealth();
  log(`  GET /health → HTTP ${health.status} ${health.ok ? JSON.stringify(health.body) : "(unreachable after retries)"}`);
  if (!health.ok) {
    log("FATAL: health check failed.");
    return 1;
  }

  const wrong = await probeRelay("/vyce/v1/models", { bearer: "nexus-relay-wrong-bearer-probe" });
  log(`  GET /vyce/v1/models (wrong bearer) → HTTP ${wrong.status} ${wrong.body !== null ? safeErrorFields(wrong.body) : `(non-JSON, ${wrong.byteLength} bytes)`}`);

  const vyce = await probeRelay("/vyce/v1/models", { bearer: relaySecret, timeoutMs: 30_000 });
  const vyceRes = printModelsProbe("  GET /vyce/v1/models (relay secret)", vyce);

  const groq = await probeRelay("/groq/openai/v1/models", { bearer: relaySecret, timeoutMs: 30_000 });
  const groqRes = printModelsProbe("  GET /groq/openai/v1/models (relay secret)", groq);

  if (vyceRes.models200) {
    const chat = await probeRelay("/vyce/v1/chat/completions", {
      method: "POST",
      bearer: relaySecret,
      body: JSON.stringify({ model: "deepseek-v4-flash-lr", messages: [{ role: "user", content: "ping" }], max_tokens: 8 }),
      timeoutMs: 45_000,
    });
    let finish = "(no choices)";
    if (chat.body !== null && typeof chat.body === "object") {
      const choices = (chat.body as { choices?: unknown }).choices;
      if (Array.isArray(choices) && choices.length > 0) {
        const fr = (choices[0] as { finish_reason?: unknown }).finish_reason;
        finish = typeof fr === "string" ? fr : "(no finish_reason)";
      }
    }
    log(`  POST /vyce/v1/chat/completions (tiny ping) → HTTP ${chat.status} finish_reason=${finish} (content NOT printed)`);
  } else {
    log("  POST /vyce/v1/chat/completions SKIPPED (Vyce models probe did not return 200)");
  }

  log(`DONE: deploy=ACTIVE health=OK vyceModels=${vyce.status} groqModels=${groq.status}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    const name = err instanceof Error ? err.name : "unknown";
    const message = err instanceof Error ? err.message.split("\n")[0] : "uncaught";
    // P7: message may be an integrity error — print name + first line only, no values.
    console.error(`FATAL (${name}): ${message}`);
    process.exit(1);
  });
