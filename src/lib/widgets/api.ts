import type { Widget } from "@prisma/client";
import { decryptSecret } from "@/lib/crypto";

/**
 * Widget → API serializer.
 *
 * The Widget table carries vault material for the stable OBS link
 * (obsTokenId / obsLinkCipher / obsBaseUrl). Those columns must NEVER reach
 * the client raw: the cipher envelope is server-side only. Instead the panel
 * receives a derived `obsLink` — the DECRYPTED origin-independent link
 * (`/api/widgets/<id>/stream?token=…`) plus the host anchor — because the
 * whole point of the stable link is that the operator can re-copy the SAME
 * URL after any panel refresh (the old flow lost it in React state and minted
 * a different token on every click).
 *
 * `obsLinkBroken` is set when a cipher exists but the vault can no longer
 * decrypt it (key rotated out / tampered) — the UI then offers a reset.
 */

export type ObsLinkApi = {
  /** Origin-independent link: "/api/widgets/<id>/stream?token=<plaintext>" */
  path: string;
  /** Host anchor ("http://localhost:3000"). null → follow current origin. */
  baseUrl: string | null;
};

export type WidgetApi = Omit<Widget, "obsTokenId" | "obsLinkCipher" | "obsBaseUrl"> & {
  obsLink?: ObsLinkApi;
  obsLinkBroken?: boolean;
};

export function toWidgetApi(w: Widget): WidgetApi {
  const { obsTokenId: _obsTokenId, obsLinkCipher, obsBaseUrl, ...rest } = w;

  let obsLink: ObsLinkApi | undefined;
  let obsLinkBroken: true | undefined;

  if (obsLinkCipher) {
    try {
      obsLink = { path: decryptSecret(obsLinkCipher), baseUrl: obsBaseUrl ?? null };
    } catch {
      obsLinkBroken = true;
    }
  }

  return {
    ...rest,
    ...(obsLink ? { obsLink } : {}),
    ...(obsLinkBroken ? { obsLinkBroken } : {}),
  };
}
