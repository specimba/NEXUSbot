import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import {
  GITHUB_APP_ID_LABEL,
  GITHUB_APP_SECRET_LABEL,
  GITHUB_SERVICE,
  logGitHubEvent,
  looksLikeGitHubPat,
  resolveGitHubAppConfig,
} from "@/lib/connectors/github";
import { db } from "@/lib/db";

/**
 * GET    /api/github/app (session required) — vault App credential presence,
 *        masked previews only.
 * PUT    /api/github/app {clientId, clientSecret} — store BOTH as encrypted vault
 *        Credential rows (service "github", labels "app-client-id" and
 *        "app-client-secret"). This is the 12-b replacement for the old
 *        "set GITHUB_CLIENT_ID/SECRET in .env" instruction.
 * DELETE /api/github/app — idempotent removal of both rows.
 *
 * P7: request and response NEVER echo the values — masked previews only
 * (••••tail). The client secret is encrypted on arrival and never logged.
 * A8: a PAT-shaped value in either field is refused (403) and never stored.
 */

const CLIENT_ID_MIN = 8;
const CLIENT_ID_MAX = 64;
const CLIENT_SECRET_MIN = 16;
const CLIENT_SECRET_MAX = 256;

function plausibleClientId(v: string): boolean {
  // GitHub OAuth App IDs: 20-hex (classic) or "Iv1." + 16 chars (newer).
  // Deliberately loose (charset/length) so a changed ID format never locks the
  // owner out — GitHub itself rejects bad IDs at flow time, honestly surfaced.
  return new RegExp(`^[A-Za-z0-9.]{${CLIENT_ID_MIN},${CLIENT_ID_MAX}}$`).test(v);
}

function plausibleClientSecret(v: string): boolean {
  return !/\s/.test(v) && v.length >= CLIENT_SECRET_MIN && v.length <= CLIENT_SECRET_MAX;
}

async function upsertVault(label: string, value: string): Promise<void> {
  const { keyId, cipher } = encryptSecret(value);
  await db.credential.upsert({
    where: { service_label: { service: GITHUB_SERVICE, label } },
    create: { service: GITHUB_SERVICE, label, keyId, cipher },
    update: { keyId, cipher },
  });
}

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  if (!rateLimit(`github-app-get:${clientKey(req)}`, 30, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many requests — retry shortly." } },
      { status: 429 },
    );
  }

  const app = await resolveGitHubAppConfig();
  let clientIdMasked: string | null = null;
  if (app.clientId) clientIdMasked = maskSecret(app.clientId); // ••••tail — never the value

  return NextResponse.json({
    ok: true,
    appConfigured: app.configured,
    credentialSource: app.source,
    clientIdMasked,
    secretStored: app.clientSecret !== null,
  });
}

export async function PUT(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  if (!rateLimit(`github-app-put:${clientKey(req)}`, 10, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many requests — retry in a minute." } },
      { status: 429 },
    );
  }

  const body = (await req.json().catch(() => null)) as
    | { clientId?: unknown; clientSecret?: unknown }
    | null;
  const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
  const clientSecret = typeof body?.clientSecret === "string" ? body.clientSecret.trim() : "";

  // A8: a PAT is never a valid App credential — refuse before any processing.
  if (looksLikeGitHubPat(clientId) || looksLikeGitHubPat(clientSecret)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "PAT_REFUSED",
          message: "PAT refused by A8 — paste the OAuth App Client ID and Client Secret (github.com/settings/developers).",
        },
      },
      { status: 403 },
    );
  }

  if (!plausibleClientId(clientId) || !plausibleClientSecret(clientSecret)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "BAD_APP_CREDENTIALS",
          message: `clientId must be ${CLIENT_ID_MIN}–${CLIENT_ID_MAX} chars (e.g. Iv1.… or 20-hex) and clientSecret ${CLIENT_SECRET_MIN}–${CLIENT_SECRET_MAX} chars without whitespace.`,
        },
      },
      { status: 400 },
    );
  }

  await upsertVault(GITHUB_APP_ID_LABEL, clientId);
  await upsertVault(GITHUB_APP_SECRET_LABEL, clientSecret);
  await logGitHubEvent("github.app_credentials_stored", {
    clientIdMasked: maskSecret(clientId),
    source: "vault",
  });

  // 201 Created-style response; masked previews only — values never echoed (P7).
  return NextResponse.json(
    {
      ok: true,
      stored: true,
      credentialSource: "vault",
      clientIdMasked: maskSecret(clientId),
      clientSecretMasked: maskSecret(clientSecret),
    },
    { status: 201 },
  );
}

export async function DELETE(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  if (!rateLimit(`github-app-del:${clientKey(req)}`, 10, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many requests — retry in a minute." } },
      { status: 429 },
    );
  }

  const res = await db.credential.deleteMany({
    where: { service: GITHUB_SERVICE, label: { in: [GITHUB_APP_ID_LABEL, GITHUB_APP_SECRET_LABEL] } },
  });
  if (res.count > 0) await logGitHubEvent("github.app_credentials_removed", {});

  // Idempotent: absent rows still answer ok.
  return NextResponse.json({ ok: true, deleted: res.count, appConfigured: false });
}
