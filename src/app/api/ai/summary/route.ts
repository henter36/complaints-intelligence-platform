import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";

export async function POST(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    return NextResponse.json(
      {
        error: "AI executive summaries are not enabled in this phase.",
        code: "AI_NOT_CONFIGURED",
      },
      { status: 501 }
    );
  } catch (error) {
    return mapAuthError(error) ?? NextResponse.json({ error: "AI summary failed" }, { status: 500 });
  }
}
