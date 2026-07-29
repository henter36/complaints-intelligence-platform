import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

export const SESSION_COOKIE_NAME = "cip_session";
export const AUTH_ACTOR = "single-admin";
export const AUTH_ERROR_RESPONSE = {
  error: {
    code: "UNAUTHORIZED",
    message: "يلزم تسجيل الدخول",
  },
};

export function getAuthSecret(): string {
  if (env.nodeEnv === "production" && !env.authSecret) {
    throw new Error("AUTH_SECRET is required in production.");
  }

  const secret = env.authSecret ?? "test-auth-secret-with-at-least-32-bytes";

  if (env.nodeEnv === "production" && secret.length < 32) {
    throw new Error("AUTH_SECRET must be at least 32 characters in production.");
  }

  return secret;
}

export function getSessionTtlMs(): number {
  return env.sessionTtlHours * 60 * 60 * 1000;
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSensitiveValue(value: string): string {
  return createHmac("sha256", getAuthSecret()).update(value).digest("hex");
}

export function safeEqual(left: string, right: string): boolean {
  const leftHash = hashSensitiveValue(left);
  const rightHash = hashSensitiveValue(right);
  return timingSafeEqual(Buffer.from(leftHash), Buffer.from(rightHash));
}

export function getCookieOptions() {
  const maxAge = Math.floor(getSessionTtlMs() / 1000);

  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.nodeEnv === "production",
    path: "/",
    maxAge,
  };
}

export function getClientFingerprint(input: {
  ip?: string | null;
  userAgent?: string | null;
}) {
  return {
    ipHash: input.ip ? hashSensitiveValue(input.ip) : null,
    userAgentHash: input.userAgent ? hashSensitiveValue(input.userAgent) : null,
  };
}
