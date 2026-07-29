import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  AUTH_ACTOR,
  createSessionToken,
  getClientFingerprint,
  getSessionTtlMs,
  hashSensitiveValue,
  SESSION_COOKIE_NAME,
} from "@/server/auth/auth-config";
import { writeAuditLog } from "@/server/audit/audit-log-service";

type SessionClient = Pick<Prisma.TransactionClient, "adminSession" | "auditLog">;

const LAST_SEEN_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

export type CurrentAdminSession = {
  id: string;
  username: string;
};

export function getRequestIp(request: NextRequest): string | null {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? request.headers.get("x-real-ip")
    ?? null;
}

export function getSessionTokenFromRequest(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

export async function getSessionTokenFromCookies(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE_NAME)?.value;
}

export async function createAdminSession(input: {
  request: NextRequest;
  username: string;
}) {
  const token = createSessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + getSessionTtlMs());
  const fingerprint = getClientFingerprint({
    ip: getRequestIp(input.request),
    userAgent: input.request.headers.get("user-agent"),
  });

  const session = await db.adminSession.create({
    data: {
      tokenHash: hashSensitiveValue(token),
      expiresAt,
      lastSeenAt: now,
      ipHash: fingerprint.ipHash,
      userAgentHash: fingerprint.userAgentHash,
    },
  });

  return {
    token,
    session,
    expiresAt,
  };
}

async function resolveSessionByToken(
  token: string | undefined,
  client: Pick<Prisma.TransactionClient, "adminSession" | "adminCredential"> = db
): Promise<CurrentAdminSession | null> {
  if (!token) {
    return null;
  }

  const tokenHash = hashSensitiveValue(token);
  const session = await client.adminSession.findUnique({ where: { tokenHash } });
  const now = new Date();

  if (!session || session.revokedAt || session.expiresAt <= now) {
    return null;
  }

  if (now.getTime() - session.lastSeenAt.getTime() > LAST_SEEN_UPDATE_INTERVAL_MS) {
    await client.adminSession.update({
      where: { id: session.id },
      data: { lastSeenAt: now },
    });
  }

  const admin = await client.adminCredential.findFirst({
    orderBy: { createdAt: "asc" },
    select: { username: true },
  });

  if (!admin) {
    return null;
  }

  return {
    id: session.id,
    username: admin.username,
  };
}

export async function getCurrentAdminSession(request: NextRequest): Promise<CurrentAdminSession | null> {
  return resolveSessionByToken(getSessionTokenFromRequest(request));
}

export async function getCurrentAdminSessionFromCookies(): Promise<CurrentAdminSession | null> {
  return resolveSessionByToken(await getSessionTokenFromCookies());
}

export async function revokeSessionByToken(
  token: string | undefined,
  client: SessionClient = db
): Promise<void> {
  if (!token) {
    return;
  }

  const tokenHash = hashSensitiveValue(token);
  const session = await client.adminSession.findUnique({ where: { tokenHash } });

  if (!session || session.revokedAt) {
    return;
  }

  await client.adminSession.update({
    where: { id: session.id },
    data: { revokedAt: new Date() },
  });

  await writeAuditLog(client, {
    action: "AUTH_SESSION_REVOKED",
    entityType: "AdminSession",
    entityId: session.id,
    actor: AUTH_ACTOR,
  });
}

export async function cleanupExpiredSessions(): Promise<number> {
  const result = await db.adminSession.updateMany({
    where: {
      revokedAt: null,
      expiresAt: { lte: new Date() },
    },
    data: { revokedAt: new Date() },
  });

  return result.count;
}
