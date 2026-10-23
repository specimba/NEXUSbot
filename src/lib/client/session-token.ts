/**
 * Session-token client store — the cookie-free lifeline for cross-site iframes.
 *
 * The panel is rendered inside the sandbox preview panel's CROSS-SITE iframe,
 * where browsers drop SameSite cookies entirely (login returns ok:true but the
 * `nexus_session` cookie never lands, so the gate re-locks). The login route
 * therefore also returns the same stateless HMAC session token in the body; we
 * keep it here and attach it as `Authorization: Bearer <token>` on same-origin
 * `/api/` requests via installSessionAuthInterceptor(). The cookie mechanism
 * itself is unchanged — same-site browsing and API tooling (curl) keep using
 * the cookie exactly as before.
 */

const TOKEN_KEY = "nexus_session_token";

let memoryToken: string | null = null;
let storageBroken = false;

function readStorage(): string | null {
  if (storageBroken) return null;
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    // Safari ITP can throw on storage access in third-party iframes —
    // degrade to the in-memory fallback so the current session still works.
    storageBroken = true;
    return null;
  }
}

function writeStorage(token: string): void {
  if (storageBroken) return;
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    storageBroken = true;
  }
}

function removeStorage(): void {
  if (storageBroken) return;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    storageBroken = true;
  }
}

export function saveSessionToken(token: string): void {
  if (!token) return;
  memoryToken = token;
  writeStorage(token);
}

export function getSessionToken(): string | null {
  const stored = readStorage();
  if (stored) {
    memoryToken = stored;
    return stored;
  }
  return memoryToken;
}

export function clearSessionToken(): void {
  memoryToken = null;
  removeStorage();
}

type PatchedFetch = typeof fetch & { __nexusSessionAuthPatched?: boolean };

/**
 * Idempotently patch window.fetch so same-origin requests whose path starts
 * with `/api/` gain `Authorization: Bearer <token>` when a session token
 * exists and the caller did not already set an Authorization header.
 * Cross-origin requests are never touched. Double-patching is guarded by a
 * module flag (plus a window flag that survives HMR re-evaluation).
 */
export function installSessionAuthInterceptor(): void {
  if (typeof window === "undefined") return;
  const globalWin = window as typeof window & { __nexusSessionAuthInstalled?: boolean };
  const patchedFetch = window.fetch as PatchedFetch;
  if (globalWin.__nexusSessionAuthInstalled || patchedFetch.__nexusSessionAuthPatched) return;
  globalWin.__nexusSessionAuthInstalled = true;

  const originalFetch = window.fetch.bind(window);

  const interceptor = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    try {
      const url = input instanceof Request ? input.url : String(input);
      const parsed = new URL(url, window.location.href);
      const isSameOriginApi =
        parsed.origin === window.location.origin && parsed.pathname.startsWith("/api/");
      if (isSameOriginApi) {
        // Per fetch spec, init.headers (when present) overrides Request headers.
        const requestHeaders = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        const token = requestHeaders.has("authorization") ? null : getSessionToken();
        if (token) {
          requestHeaders.set("Authorization", `Bearer ${token}`);
          return originalFetch(input, { ...init, headers: requestHeaders });
        }
      }
    } catch {
      // Never let the interceptor break a request — fall through to plain fetch.
    }
    return originalFetch(input, init);
  };

  Object.defineProperty(interceptor, "__nexusSessionAuthPatched", { value: true });
  window.fetch = interceptor as typeof window.fetch;
}
