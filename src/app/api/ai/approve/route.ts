// The "approve" workflow (per-complaint AI suggestion) is not part of Phase 8.
// The new governed AI provides batch analysis only (read-only, no data mutation).
import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";

export async function POST(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    return NextResponse.json(
      {
        error: "GONE",
        message: "Per-complaint AI approval is not available. Use /api/ai/analyses for governed batch analysis.",
      },
      { status: 410 }
    );
  } catch (error) {
    return mapAuthError(error) ?? NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
