import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { cacheSealPassphrase } from "./seal-cache";

/**
 * NEXUS OS — sandbox seal (v29.18, Task 25).
 *
 * THE PROBLEM (lived twice: v29.12 and again 2026-10-26 15:08Z): a sandbox cold
 * boot restores the workspace from the GitHub snapshot — which BY DESIGN excludes
 * .env, db/ and the vault. The boot's ensure-env.sh then mints FRESH random
 * SESSION_SECRET / ENCRYPTION_KEY / PANEL_PASSWORD. Result: every session token
 * invalid (login loop), every vault envelope unreadable (all API keys need
 * re-entering), the panel password "changes", and the OBS link + widget config
 * die with the DB.
 *
 * THE FIX: an owner-passphrase-encrypted seal file that is GIT-TRACKED, so the
 * snapshot chain carries it through any reset. It contains:
 *   env         — SESSION_SECRET, ENCRYPTION_KEY, ENCRYPTION_KEYS_PREV, PANEL_PASSWORD
 *   credentials  — every vault row (cipher+keyId; readable again once the sealed
 *                  ENCRYPTION_KEY is restored)
 *   widgets      — full widget rows (definitions, variables incl. supabase_url/
 *                  anon key → the mirror config, and the OBS link fields)
 *   settings     — every Setting row (panel password hash, mirror status, routing…)
 *   ingestTokens — token hashes (OBS link tokens keep working after restore)
 *
 * Cryptography: AES-256-GCM, key = scrypt(passphrase, salt 16B, N=2^15, r=8, p=1,
 * 32B). A cleartext `meta` block (timestamps + row counts, NO secret material)
 * lets the panel show honest seal state without the passphrase. `check` =
 * HMAC(key, "nexus-seal-check") verifies the passphrase before any restore.
 *
 * Auto-reseal (2026-10-29 incident fix): restoreSeal caches the VERIFIED
 * passphrase in-process (src/lib/seal-cache.ts); the Prisma extension in
 * src/lib/db.ts then refreshes the seal automatically after any mutation of
 * Credential / IngestToken / Widget / Setting — so rows created AFTER an
 * unseal (the exact way the 19:15 OBS token died) are sealed within 45 s.
 *
 * Threat model, stated honestly: the seal file is PUBLIC (rides in the public
 * snapshot repo). Its strength is exactly the passphrase — the UI instructs a
 * long one. Everything inside is additionally useless without… nothing else:
 * this is single-factor, deliberately, because at restore time (fresh sandbox)
 * nothing else exists yet. Restore is session-gated AND rate-limited.
 *
 * What the seal deliberately does NOT carry: InteractionLog / SecurityLesson /
 * Event rows (the L0 mirror + backfill-from-mirror.ts own that history) and
 * UsageEvent telemetry. Config is small and critical; history is reconstructible.
 */

export const SEAL_PATH = ".seal/nexus-seal.v1.json";

const SEAL_VERSION = 1;
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

/** .env keys restored by an unseal — the durability-critical four only. */
const SEALED_ENV_KEYS = ["SESSION_SECRET", "ENCRYPTION_KEY", "ENCRYPTION_KEYS_PREV", "PANEL_PASSWORD"] as const;

export type SealMeta = {
  version: number;
  sealedAt: string;
  counts: {
    env: number;
    credentials: number;
    widgets: number;
    settings: number;
    ingestTokens: number;
  };
};

type SealFile = {
  meta: SealMeta;
  kdf: { salt: string; n: number; r: number; p: number };
  check: string;
  iv: string;
  tag: string;
  ct: string;
};

type SealPayload = {
  env: Record<string, string>;
  credentials: Array<{ id: string; service: string; label: string; keyId: string; cipher: string; createdAt: string; updatedAt: string }>;
  widgets: Array<{
    id: string; name: string; width: number; height: number; html: string; css: string; js: string;
    variables: string; enabled: boolean; seeded: boolean; createdAt: string; updatedAt: string;
    obsTokenId: string | null; obsLinkCipher: string | null; obsBaseUrl: string | null;
  }>;
  settings: Array<{ key: string; value: string; updatedAt: string }>;
  ingestTokens: Array<{ id: string; label: string; tokenHash: string; preview: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }>;
};

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize("NFKC"), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    // 128*N*r = exactly 32MB — Node's implicit default permits it, but Bun's
    // BoringSSL refuses right at the boundary (MEMORY_LIMIT_EXCEEDED, caught
    // live in the v29.18 E2E). An explicit 64MB ceiling makes the seal work
    // under BOTH runtimes without weakening the KDF.
    maxmem: 64 * 1024 * 1024,
  });
}

function sealFilePath(): string {
  return path.join(process.cwd(), SEAL_PATH);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function buildSealPayload(): Promise<SealPayload> {
  const env: Record<string, string> = {};
  for (const k of SEALED_ENV_KEYS) {
    const v = process.env[k];
    if (v) env[k] = v;
  }

  const [credentials, widgets, settings, ingestTokens] = await Promise.all([
    db.credential.findMany({ orderBy: { service: "asc" } }),
    db.widget.findMany({ orderBy: { name: "asc" } }),
    db.setting.findMany({ orderBy: { key: "asc" } }),
    db.ingestToken.findMany({ orderBy: { createdAt: "asc" } }),
  ]);

  return {
    env,
    credentials: credentials.map((c) => ({
      id: c.id, service: c.service, label: c.label, keyId: c.keyId, cipher: c.cipher,
      createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(),
    })),
    widgets: widgets.map((w) => ({
      id: w.id, name: w.name, width: w.width, height: w.height, html: w.html, css: w.css, js: w.js,
      variables: w.variables, enabled: w.enabled, seeded: w.seeded,
      createdAt: w.createdAt.toISOString(), updatedAt: w.updatedAt.toISOString(),
      obsTokenId: w.obsTokenId, obsLinkCipher: w.obsLinkCipher, obsBaseUrl: w.obsBaseUrl,
    })),
    settings: settings.map((s) => ({ key: s.key, value: s.value, updatedAt: s.updatedAt.toISOString() })),
    ingestTokens: ingestTokens.map((t) => ({
      id: t.id, label: t.label, tokenHash: t.tokenHash, preview: t.preview,
      createdAt: t.createdAt.toISOString(),
      lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
      revokedAt: t.revokedAt ? t.revokedAt.toISOString() : null,
    })),
  };
}

/**
 * Create the seal file atomically. Throws on: empty passphrase, empty payload
 * (a seal of nothing would overwrite a good seal with garbage at next restore),
 * or any DB/env collection error. Writes only after the full payload is built.
 */
export async function createSeal(passphrase: string): Promise<SealMeta> {
  if (typeof passphrase !== "string" || passphrase.length < 12 || passphrase.length > 512) {
    throw new Error("Passphrase must be 12–512 characters.");
  }
  const payload = await buildSealPayload();
  if (Object.keys(payload.env).length === 0 && payload.credentials.length === 0) {
    throw new Error("Refusing to seal: both .env secrets and the vault are empty — nothing durable to protect.");
  }

  const salt = randomBytes(16);
  const key = deriveKey(passphrase, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const check = createHmac("sha256", key).update("nexus-seal-check").digest("hex");

  const file: SealFile = {
    meta: {
      version: SEAL_VERSION,
      sealedAt: new Date().toISOString(),
      counts: {
        env: Object.keys(payload.env).length,
        credentials: payload.credentials.length,
        widgets: payload.widgets.length,
        settings: payload.settings.length,
        ingestTokens: payload.ingestTokens.length,
      },
    },
    kdf: { salt: salt.toString("base64url"), n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
    check,
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    ct: ct.toString("base64url"),
  };

  const target = sealFilePath();
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, JSON.stringify(file), { mode: 0o600 });
  await fs.promises.rename(tmp, target);

  return file.meta;
}

// ---------------------------------------------------------------------------
// Read meta (no passphrase needed)
// ---------------------------------------------------------------------------

export function readSealMeta(): { exists: boolean; meta: SealMeta | null; error: string | null } {
  try {
    const raw = fs.readFileSync(sealFilePath(), "utf8");
    const file = JSON.parse(raw) as SealFile;
    if (file?.meta?.version !== SEAL_VERSION || !file?.ct) {
      return { exists: true, meta: null, error: "seal file present but malformed" };
    }
    return { exists: true, meta: file.meta, error: null };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { exists: false, meta: null, error: null };
    return { exists: false, meta: null, error: `seal unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

function decryptPayload(file: SealFile, passphrase: string): SealPayload {
  const salt = Buffer.from(file.kdf.salt, "base64url");
  const key = deriveKey(passphrase, salt);
  const expected = Buffer.from(file.check, "hex");
  const got = Buffer.from(createHmac("sha256", key).update("nexus-seal-check").digest("hex"), "hex");
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    throw new Error("Passphrase does not match this seal.");
  }
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "base64url"));
  d.setAuthTag(Buffer.from(file.tag, "base64url"));
  const plain = Buffer.concat([d.update(Buffer.from(file.ct, "base64url")), d.final()]);
  return JSON.parse(plain.toString("utf8")) as SealPayload;
}

/** Rewrite the durability-critical .env keys (merge — other keys untouched). */
function writeEnvKeys(env: Record<string, string>): { written: string[] } {
  const envPath = path.join(process.cwd(), ".env");
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  } catch {
    lines = [];
  }
  const written: string[] = [];
  const remaining: string[] = [];
  for (const line of lines) {
    const key = line.split("=", 1)[0]?.trim();
    if (key && (SEALED_ENV_KEYS as readonly string[]).includes(key)) continue;
    remaining.push(line);
  }
  for (const k of SEALED_ENV_KEYS) {
    const v = env[k];
    if (!v) continue;
    remaining.push(`${k}=${v}`);
    written.push(k);
  }
  const merged = `${remaining.filter((l, i) => !(i === remaining.length - 1 && l.trim() === "")).join("\n")}\n`;
  const tmp = `${envPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, merged, { mode: 0o600 });
  fs.renameSync(tmp, envPath);
  return { written };
}

export type RestoreResult = {
  envWritten: string[];
  credentials: number;
  widgets: number;
  settings: number;
  ingestTokens: number;
  sealedAt: string;
};

/**
 * Restore the seal into the LIVE process + DB. Env changes are applied to
 * process.env immediately (the running panel picks them up without a restart:
 * auth.ts reads SESSION_SECRET per call, and reloadVaultKeys() re-derives the
 * AES key cache), then persisted to .env for future boots.
 */
export async function restoreSeal(passphrase: string): Promise<RestoreResult> {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new Error("Passphrase is required.");
  }
  const raw = fs.readFileSync(sealFilePath(), "utf8");
  const file = JSON.parse(raw) as SealFile;
  const payload = decryptPayload(file, passphrase);

  // 0) The passphrase just verified against this seal — cache it in-process
  //    so seal-cache.ts can auto-refresh the seal after any later mutation of
  //    the seal-carried models (the 19:15 post-seal OBS-token gap never
  //    recurs). Memory-only (dies with the process, never persisted, P7).
  cacheSealPassphrase(passphrase);

  // 1) Env: live process first, then .env file.
  for (const k of SEALED_ENV_KEYS) {
    if (payload.env[k]) process.env[k] = payload.env[k];
  }
  const { written } = writeEnvKeys(payload.env);

  // 2) Re-derive the vault key cache under the restored key.
  const { reloadVaultKeys } = await import("@/lib/crypto");
  reloadVaultKeys();

  // 3) DB rows — upsert merge (fresh-boot rows not in the seal survive).
  //    Order: settings → credentials → ingestTokens → widgets, so a widget's
  //    obsTokenId always points at an already-restored token row.
  for (const s of payload.settings) {
    await db.setting.upsert({
      where: { key: s.key },
      create: { key: s.key, value: s.value },
      update: { value: s.value },
    });
  }
  for (const c of payload.credentials) {
    await db.credential.upsert({
      where: { service_label: { service: c.service, label: c.label } },
      create: {
        id: c.id, service: c.service, label: c.label, keyId: c.keyId, cipher: c.cipher,
        createdAt: new Date(c.createdAt), updatedAt: new Date(c.updatedAt),
      },
      update: {
        keyId: c.keyId, cipher: c.cipher, updatedAt: new Date(c.updatedAt),
      },
    });
  }
  for (const t of payload.ingestTokens) {
    await db.ingestToken.upsert({
      where: { tokenHash: t.tokenHash },
      create: {
        id: t.id, label: t.label, tokenHash: t.tokenHash, preview: t.preview,
        createdAt: new Date(t.createdAt),
        lastUsedAt: t.lastUsedAt ? new Date(t.lastUsedAt) : null,
        revokedAt: t.revokedAt ? new Date(t.revokedAt) : null,
      },
      update: {
        label: t.label, preview: t.preview,
        lastUsedAt: t.lastUsedAt ? new Date(t.lastUsedAt) : null,
        revokedAt: t.revokedAt ? new Date(t.revokedAt) : null,
      },
    });
  }
  for (const w of payload.widgets) {
    await db.widget.upsert({
      where: { id: w.id },
      create: {
        id: w.id, name: w.name, width: w.width, height: w.height, html: w.html, css: w.css, js: w.js,
        variables: w.variables, enabled: w.enabled, seeded: w.seeded,
        createdAt: new Date(w.createdAt), updatedAt: new Date(w.updatedAt),
        obsTokenId: w.obsTokenId, obsLinkCipher: w.obsLinkCipher, obsBaseUrl: w.obsBaseUrl,
      },
      update: {
        name: w.name, width: w.width, height: w.height, html: w.html, css: w.css, js: w.js,
        variables: w.variables, enabled: w.enabled, seeded: w.seeded,
        obsTokenId: w.obsTokenId, obsLinkCipher: w.obsLinkCipher, obsBaseUrl: w.obsBaseUrl,
        updatedAt: new Date(w.updatedAt),
      },
    });
  }

  return {
    envWritten: written,
    credentials: payload.credentials.length,
    widgets: payload.widgets.length,
    settings: payload.settings.length,
    ingestTokens: payload.ingestTokens.length,
    sealedAt: file.meta.sealedAt,
  };
}
