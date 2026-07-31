// Legacy per-complaint AI analysis endpoint.
// Redirects to /api/ai/status to inform callers of AI state.
import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { env } from "@/lib/env";

export async function POST(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    if (!env.aiEnabled) {
      return NextResponse.json(
        { error: "AI_DISABLED", message: "AI is not enabled. Use /api/ai/analyses for governed AI analysis." },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: "DEPRECATED", message: "Use POST /api/ai/analyses for governed AI analysis." },
      { status: 410 }
    );
  } catch (error) {
    return mapAuthError(error) ?? NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
