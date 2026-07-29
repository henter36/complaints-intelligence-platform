import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { AUTH_ACTOR, getCookieOptions, SESSION_COOKIE_NAME } from "@/server/auth/auth-config";
import { createAdminSession, getRequestIp } from "@/server/auth/session-service";
import { validateAdminLogin } from "@/server/auth/admin-service";
import {
  getLoginAttemptIdentity,
  isLoginRateLimitError,
  markLoginAttemptSucceeded,
  reserveLoginAttempt,
} from "@/server/auth/rate-limit-service";
import { writeAuditLog } from "@/server/audit/audit-log-service";
import { assertSameOrigin, CsrfValidationError } from "@/server/auth/auth-guard";

const loginSchema = z.object({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(512),
});

const INVALID_LOGIN_RESPONSE = {
  error: {
    code: "INVALID_CREDENTIALS",
    message: "بيانات الدخول غير صحيحة",
  },
};

const LOGIN_UNAVAILABLE_RESPONSE = {
  error: {
    code: "LOGIN_UNAVAILABLE",
    message: "تعذر تسجيل الدخول مؤقتًا",
  },
};

async function writeAuthAudit(input: Parameters<typeof writeAuditLog>[1]): Promise<void> {
  try {
    await writeAuditLog(db, input);
  } catch (error) {
    console.error("Auth audit write failed:", error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return NextResponse.json(
        { error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "يجب إرسال JSON" } },
        { status: 415 }
      );
    }

    const input = loginSchema.parse(await request.json());
    const identity = getLoginAttemptIdentity({
      username: input.username,
      ip: getRequestIp(request),
    });

    const attempt = await reserveLoginAttempt(identity);
    const admin = await validateAdminLogin(input.username, input.password);

    if (!admin) {
      await writeAuthAudit({
        action: "AUTH_LOGIN_FAILED",
        entityType: "AdminCredential",
        actor: AUTH_ACTOR,
        metadata: { identifierHash: identity.identifierHash },
      });
      return NextResponse.json(INVALID_LOGIN_RESPONSE, { status: 401 });
    }

    const { token, session } = await createAdminSession({ request, username: admin.username });

    try {
      await markLoginAttemptSucceeded(attempt.id);
    } catch (error) {
      console.error("Login attempt success update failed:", error);
    }

    await writeAuthAudit({
      action: "AUTH_LOGIN_SUCCEEDED",
      entityType: "AdminSession",
      entityId: session.id,
      actor: AUTH_ACTOR,
    });

    const response = NextResponse.json({ authenticated: true, username: admin.username });
    response.cookies.set(SESSION_COOKIE_NAME, token, getCookieOptions());
    return response;
  } catch (error) {
    if (error instanceof CsrfValidationError) {
      return NextResponse.json(
        { error: { code: "INVALID_ORIGIN", message: "مصدر الطلب غير مسموح" } },
        { status: 403 }
      );
    }

    if (isLoginRateLimitError(error)) {
      await writeAuthAudit({
        action: "AUTH_RATE_LIMITED",
        entityType: "LoginAttempt",
        actor: AUTH_ACTOR,
      });
      return NextResponse.json(
        { error: { code: "TOO_MANY_REQUESTS", message: "محاولات كثيرة، حاول لاحقًا" } },
        { status: 429 }
      );
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json(INVALID_LOGIN_RESPONSE, { status: 401 });
    }

    console.error("Login failed:", error);
    return NextResponse.json(LOGIN_UNAVAILABLE_RESPONSE, { status: 500 });
  }
}
