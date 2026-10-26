import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * NEXUS OS secrets vault (T-201 design).
 *
 * Envelope format (versioned):
 *   v1.<keyId>.<iv-b64url>.<tag-b64url>.<ct-b64url>
 *
 * - AES-256-GCM, 12-byte random IV per encryption.
 * - keyId = sha256(keyMaterial) first 8 hex chars → supports rotation windows via
 *   ENCRYPTION_KEYS_PREV (comma-separated previous keys); decrypt finds the key by id.
 * - Any tampering (tag/auth failure, unknown keyId, malformed envelope) throws the
 *   typed VaultIntegrityError — never a silent wrong-value.
 *
 * P7: this module never logs plaintext or key material.
 */

export class VaultIntegrityError extends Error {
  constructor(message = "Vault integrity check failed") {
    super(message);
    this.name = "VaultIntegrityError";
  }
}

const PREFIX = "v1";

function parseKey(raw: string | undefined, source: string): Buffer | null {
  if (!raw || raw.length === 0) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "utf8");
  if (key.length !== 32) {
    throw new Error(`${source} must be 32 bytes (64 hex chars) — run scripts/ensure-env.sh`);
  }
  return key;
}

export function keyIdFor(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

const keyCache = new Map<string, Buffer>();
let keysLoaded = false;

/**
 * Re-derive the key cache from the CURRENT process.env (v29.18 seal restore).
 * restoreSeal() hot-swaps ENCRYPTION_KEY/ENCRYPTION_KEYS_PREV in process.env;
 * without this reset the memoized cache would keep decrypting under the old
 * boot key and every restored vault envelope would read as tampered.
 */
export function reloadVaultKeys(): void {
  keyCache.clear();
  keysLoaded = false;
}

function loadKeys(): Map<string, Buffer> {
  if (keysLoaded) return keyCache;
  const primary = parseKey(process.env.ENCRYPTION_KEY, "ENCRYPTION_KEY");
  if (!primary) {
    throw new Error("ENCRYPTION_KEY is not set — run scripts/ensure-env.sh");
  }
  keyCache.set(keyIdFor(primary), primary);

  const prevRaw = process.env.ENCRYPTION_KEYS_PREV ?? "";
  prevRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((raw, i) => {
      const k = parseKey(raw, `ENCRYPTION_KEYS_PREV[${i}]`);
      if (k) keyCache.set(keyIdFor(k), k);
    });

  keysLoaded = true;
  return keyCache;
}

export function encryptSecret(plaintext: string): { keyId: string; cipher: string } {
  const keys = loadKeys();
  // Primary key is the entry with keyId derived from ENCRYPTION_KEY — re-derive deterministically.
  const primaryId = keyIdFor(parseKey(process.env.ENCRYPTION_KEY, "ENCRYPTION_KEY")!);
  const key = keys.get(primaryId);
  if (!key) throw new VaultIntegrityError("primary vault key missing from cache");

  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const tag = c.getAuthTag();

  const cipher = [
    PREFIX,
    primaryId,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ct.toString("base64url"),
  ].join(".");

  return { keyId: primaryId, cipher };
}

export function decryptSecret(envelope: string): string {
  const parts = envelope.split(".");
  if (parts.length !== 5 || parts[0] !== PREFIX) {
    throw new VaultIntegrityError("malformed vault envelope");
  }
  const [, keyId, ivB64, tagB64, ctB64] = parts;

  const key = loadKeys().get(keyId);
  if (!key) {
    throw new VaultIntegrityError(`unknown vault keyId "${keyId}" (key rotated out?)`);
  }

  let iv: Buffer;
  let tag: Buffer;
  let ct: Buffer;
  try {
    iv = Buffer.from(ivB64, "base64url");
    tag = Buffer.from(tagB64, "base64url");
    ct = Buffer.from(ctB64, "base64url");
  } catch {
    throw new VaultIntegrityError("vault envelope is not valid base64url");
  }

  try {
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch {
    throw new VaultIntegrityError("authentication tag mismatch — ciphertext tampered or key wrong");
  }
}

/** UI-safe mask: keeps last 4 chars only. Never returns the secret. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "••••";
  return `••••${value.slice(-4)}`;
}
