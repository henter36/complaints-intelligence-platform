import { NextRequest, NextResponse } from "next/server";
import { AUTH_ERROR_RESPONSE } from "@/server/auth/auth-config";
import { getCurrentAdminSession, type CurrentAdminSession } from "@/server/auth/session-service";

export class UnauthorizedError extends Error {
  readonly code = "UNAUTHORIZED";

  constructor() {
    super("يلزم تسجيل الدخول");
    this.name = "UnauthorizedError";
  }
}

export class CsrfValidationError extends Error {
  readonly code = "INVALID_ORIGIN";

  constructor() {
    super("مصدر الطلب غير مسموح");
    this.name = "CsrfValidationError";
  }
}

export async function requireAdminSession(request: NextRequest): Promise<CurrentAdminSession> {
  const session = await getCurrentAdminSession(request);

  if (!session) {
    throw new UnauthorizedError();
  }

  return session;
}

export function assertSameOrigin(request: NextRequest): void {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return;
  }

  const origin = request.headers.get("origin");
  const host = request.headers.get("host");

  if (!origin || !host) {
    throw new CsrfValidationError();
  }

  try {
    if (new URL(origin).host !== host) {
      throw new CsrfValidationError();
    }
  } catch {
    throw new CsrfValidationError();
  }
}

export async function requireAdminApiSession(request: NextRequest): Promise<CurrentAdminSession> {
  assertSameOrigin(request);
  return requireAdminSession(request);
}

export function unauthorizedResponse(): NextResponse {
  const response = NextResponse.json(AUTH_ERROR_RESPONSE, { status: 401 });
  response.cookies.delete("cip_session");
  return response;
}

export function forbiddenOriginResponse(): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: "INVALID_ORIGIN",
        message: "مصدر الطلب غير مسموح",
      },
    },
    { status: 403 }
  );
}

export function mapAuthError(error: unknown): NextResponse | null {
  if (error instanceof UnauthorizedError) {
    return unauthorizedResponse();
  }

  if (error instanceof CsrfValidationError) {
    return forbiddenOriginResponse();
  }

  return null;
}
