import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";

export async function GET(request: NextRequest) {
  try {
    const session = await requireAdminApiSession(request);
    return NextResponse.json({
      authenticated: true,
      username: session.username,
    });
  } catch (error) {
    return mapAuthError(error) ?? NextResponse.json(
      { error: { code: "AUTH_CHECK_FAILED", message: "تعذر التحقق من الجلسة" } },
      { status: 500 }
    );
  }
}
