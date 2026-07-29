import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";

export async function POST(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    return NextResponse.json(
      {
        error: "AI_NOT_CONFIGURED",
        message: "AI approval is outside this phase and requires governed AI workflow configuration.",
      },
      { status: 501 }
    );
  } catch (error) {
    return mapAuthError(error) ?? NextResponse.json({ error: "AI approval failed" }, { status: 500 });
  }
}
