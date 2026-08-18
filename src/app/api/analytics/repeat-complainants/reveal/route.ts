import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { decodeComplainantToken } from "@/server/complaints/complainant-token";

/**
 * Decodes an opaque drillthrough token back to the raw identifier — the ONLY
 * path by which a raw identifier is ever exposed on-screen (spec's explicit
 * reveal toggle), and only on an explicit per-person user action, never
 * preloaded. `token` itself is the opaque value, not the raw identifier, so
 * it appearing in this query string does not violate the "never the raw ID
 * in a query string" rule (same convention already used by the `/person`
 * detail route).
 */
export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const url = new URL(req.url);
    const token = url.searchParams.get("token");
    if (!token) {
      return NextResponse.json(
        { error: { code: "TOKEN_REQUIRED", message: "المعامل token مطلوب" } },
        { status: 400 }
      );
    }
    const identifier = decodeComplainantToken(token);
    if (!identifier) {
      return NextResponse.json(
        { error: { code: "INVALID_TOKEN", message: "رمز غير صالح" } },
        { status: 404 }
      );
    }
    return NextResponse.json({ identifier });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    console.error("Repeat-complainant reveal API error:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json(
      { error: { code: "REPEAT_COMPLAINANT_REVEAL_FAILED", message: "تعذر إظهار الهوية" } },
      { status: 500 }
    );
  }
}
