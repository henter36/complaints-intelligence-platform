import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AUTH_ACTOR, safeEqual } from "@/server/auth/auth-config";
import {
  hashPassword,
  isPasswordValidationError,
  validateNewPassword,
  verifyPassword,
} from "@/server/auth/password-service";
import { writeAuditLog } from "@/server/audit/audit-log-service";

type AdminClient = Pick<Prisma.TransactionClient, "adminCredential" | "adminSession" | "auditLog">;

export class AdminCredentialError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AdminCredentialError";
    this.code = code;
  }
}

export async function getSingleAdmin(client: Pick<Prisma.TransactionClient, "adminCredential"> = db) {
  const admins = await client.adminCredential.findMany({
    orderBy: { createdAt: "asc" },
    take: 2,
  });

  if (admins.length === 0) {
    return null;
  }

  if (admins.length > 1) {
    throw new AdminCredentialError("MULTIPLE_ADMINS_NOT_SUPPORTED", "Only one admin account is supported.");
  }

  return admins[0];
}

export async function initializeAdminCredential(options?: {
  username?: string;
  passwordHash?: string;
  replace?: boolean;
}) {
  const username = options?.username ?? env.adminUsername;
  const passwordHash = options?.passwordHash ?? env.adminPasswordHash;

  if (!passwordHash) {
    throw new AdminCredentialError("ADMIN_PASSWORD_HASH_REQUIRED", "ADMIN_PASSWORD_HASH is required.");
  }

  return db.$transaction(async (tx) => {
    const existing = await tx.adminCredential.findMany({ take: 2 });

    if (existing.length > 0 && !options?.replace) {
      throw new AdminCredentialError("ADMIN_ALREADY_INITIALIZED", "Admin credential already exists.");
    }

    if (options?.replace) {
      await tx.adminSession.updateMany({
        where: { revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.adminCredential.deleteMany();
    }

    const admin = await tx.adminCredential.create({
      data: {
        username,
        passwordHash,
      },
    });

    await writeAuditLog(tx, {
      action: "AUTH_ADMIN_INITIALIZED",
      entityType: "AdminCredential",
      entityId: admin.id,
      actor: AUTH_ACTOR,
      metadata: { username },
    });

    return admin;
  });
}

export async function validateAdminLogin(username: string, password: string): Promise<{
  id: string;
  username: string;
} | null> {
  const admin = await getSingleAdmin();

  if (!admin) {
    return null;
  }

  const usernameMatches = safeEqual(username, admin.username);
  const passwordMatches = await verifyPassword(password, admin.passwordHash);

  if (!usernameMatches || !passwordMatches) {
    return null;
  }

  return { id: admin.id, username: admin.username };
}

export async function changeAdminPassword(input: {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}) {
  if (input.newPassword !== input.confirmPassword) {
    throw new AdminCredentialError("PASSWORD_CONFIRMATION_MISMATCH", "تأكيد كلمة المرور غير مطابق");
  }

  try {
    validateNewPassword(input.newPassword);
  } catch (error) {
    if (isPasswordValidationError(error)) {
      throw new AdminCredentialError(error.code, error.message);
    }
    throw error;
  }

  return db.$transaction(async (tx: AdminClient) => {
    const admin = await getSingleAdmin(tx);

    if (!admin || !(await verifyPassword(input.currentPassword, admin.passwordHash))) {
      throw new AdminCredentialError("INVALID_CURRENT_PASSWORD", "كلمة المرور الحالية غير صحيحة");
    }

    const nextHash = await hashPassword(input.newPassword);
    const updated = await tx.adminCredential.update({
      where: { id: admin.id },
      data: {
        passwordHash: nextHash,
        passwordChangedAt: new Date(),
      },
    });

    await tx.adminSession.updateMany({
      where: { revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await writeAuditLog(tx, {
      action: "AUTH_PASSWORD_CHANGED",
      entityType: "AdminCredential",
      entityId: updated.id,
      actor: AUTH_ACTOR,
    });

    return updated;
  });
}

export function isAdminCredentialError(error: unknown): error is AdminCredentialError {
  return error instanceof AdminCredentialError;
}
