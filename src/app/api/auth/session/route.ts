import { NextResponse } from "next/server";
import { isAuthenticated, panelPasswordConfigured } from "@/lib/auth";

export async function GET() {
  return NextResponse.json({
    ok: true,
    authenticated: await isAuthenticated(),
    passwordConfigured: panelPasswordConfigured(),
  });
}
