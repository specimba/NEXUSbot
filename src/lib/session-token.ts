/**
 * Client-side session token storage.
 *
 * The panel is commonly embedded in a cross-origin preview iframe where
 * SameSite cookies are unreliable (sometimes blocked outright). So the session
 * token ALSO lives in localStorage and every same-origin fetch attaches it as
 * `Authorization: Bearer <token>` — see the fetch wrapper in providers.tsx.
 * localStorage is scoped to the app origin inside the iframe, so it works
 * wherever the cookie does not. Cookie remains as a same-origin fallback.
 */

const KEY = "nexus_session_token";

export function getSessionToken(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string): void {
  try {
    window.localStorage.setItem(KEY, token);
  } catch {
    /* storage unavailable — cookie path remains */
  }
}

export function clearSessionToken(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
