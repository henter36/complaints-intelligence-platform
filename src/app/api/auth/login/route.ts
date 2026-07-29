import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { AUTH_ACTOR, getCookieOptions, SESSION_COOKIE_NAME } from "@/server/auth/auth-config";
import { createAdminSession, getRequestIp } from "@/server/auth/session-service";
import { validateAdminLogin } from "@/server/auth/admin-service";
import {
  assertLoginAllowed,
  getLoginAttemptIdentity,
  isLoginRateLimitError,
  recordLoginAttempt,
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

    await assertLoginAllowed(identity);

    const admin = await validateAdminLogin(input.username, input.password);
    await recordLoginAttempt({ ...identity, succeeded: Boolean(admin) });

    if (!admin) {
      await writeAuditLog(db, {
        action: "AUTH_LOGIN_FAILED",
        entityType: "AdminCredential",
        actor: AUTH_ACTOR,
        metadata: { identifierHash: identity.identifierHash },
      });
      return NextResponse.json(INVALID_LOGIN_RESPONSE, { status: 401 });
    }

    const { token, session } = await createAdminSession({ request, username: admin.username });

    await writeAuditLog(db, {
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
      await writeAuditLog(db, {
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
    return NextResponse.json(INVALID_LOGIN_RESPONSE, { status: 401 });
  }
}
