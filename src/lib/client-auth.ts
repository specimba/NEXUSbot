"use client";

/**
 * NEXUS OS client session store + fetch shim.
 *
 * Why: the panel is often viewed inside the sandbox preview <iframe>, which is a
 * cross-site context. Browsers (Chrome 2024+, Safari) silently DROP SameSite=Lax
 * cookies set from cross-site frames — so a successful login still ended up
 * "signed out" on the next query. The server now returns the same HMAC-signed
 * session token in the login response body; we persist it in localStorage and
 * attach it as `Authorization: Bearer` on every same-origin /api request.
 * Cookie stays the primary channel when it works; Bearer is the guaranteed one.
 */

const TOKEN_KEY = "nexus_session_token";

export function storeSessionToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode etc. — cookie channel still applies */
  }
}

export function clearSessionToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export function getSessionToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Idempotently wrap window.fetch so every relative /api call carries the Bearer
 * token when available. Cookie-only callers are unaffected; external/socket.io
 * requests are untouched.
 */
export function installAuthFetchShim(): void {
  if (typeof window === "undefined") return;
  const w = window as typeof window & { __nexusAuthShim?: boolean };
  if (w.__nexusAuthShim) return;
  w.__nexusAuthShim = true;

  const original = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (!url.startsWith("/api/")) return original(input, init);

    const token = getSessionToken();
    if (!token) return original(input, init);

    const headers = new Headers(
      init.headers ??
        (typeof input === "string" || input instanceof URL ? undefined : input.headers),
    );
    if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
    return original(input, { ...init, headers });
  };
}
