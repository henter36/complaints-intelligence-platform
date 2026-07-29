import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { AUTH_ACTOR, SESSION_COOKIE_NAME } from "@/server/auth/auth-config";
import { getSessionTokenFromRequest, revokeSessionByToken } from "@/server/auth/session-service";
import { writeAuditLog } from "@/server/audit/audit-log-service";
import { assertSameOrigin, CsrfValidationError } from "@/server/auth/auth-guard";

async function writeLogoutAudit(): Promise<void> {
  try {
    await writeAuditLog(db, {
      action: "AUTH_LOGOUT",
      entityType: "AdminSession",
      actor: AUTH_ACTOR,
    });
  } catch (error) {
    console.error("Logout audit write failed:", error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    await revokeSessionByToken(getSessionTokenFromRequest(request));
    await writeLogoutAudit();

    const response = NextResponse.json({ ok: true });
    response.cookies.delete(SESSION_COOKIE_NAME);
    return response;
  } catch (error) {
    if (error instanceof CsrfValidationError) {
      return NextResponse.json(
        { error: { code: "INVALID_ORIGIN", message: "مصدر الطلب غير مسموح" } },
        { status: 403 }
      );
    }

    console.error("Logout failed:", error);
    return NextResponse.json(
      { error: { code: "LOGOUT_FAILED", message: "تعذر تسجيل الخروج" } },
      { status: 500 }
    );
  }
}
