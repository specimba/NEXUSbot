import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, panelPasswordConfigured, verifySessionToken } from "@/lib/auth";

/**
 * authenticated is true when EITHER the bearer header OR the cookie verifies.
 * The bearer path serves cross-site iframe embeds (preview panel) where
 * browsers drop the session cookie; the cookie path is unchanged for same-site
 * + API tooling.
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  let authenticated = false;
  if (authHeader?.startsWith("Bearer ")) {
    authenticated = verifySessionToken(authHeader.slice("Bearer ".length).trim());
  }
  if (!authenticated) {
    const store = await cookies();
    authenticated = verifySessionToken(store.get(SESSION_COOKIE)?.value);
  }
  return NextResponse.json({
    ok: true,
    authenticated,
    passwordConfigured: panelPasswordConfigured(),
  });
}
