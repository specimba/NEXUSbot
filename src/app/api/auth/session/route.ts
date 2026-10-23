import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, panelPasswordConfigured, verifySessionToken } from "@/lib/auth";

export async function GET() {
  const store = await cookies();
  return NextResponse.json({
    ok: true,
    authenticated: verifySessionToken(store.get(SESSION_COOKIE)?.value),
    passwordConfigured: panelPasswordConfigured(),
  });
}
