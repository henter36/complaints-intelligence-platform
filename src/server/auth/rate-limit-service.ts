import { db } from "@/lib/db";
import { hashSensitiveValue } from "@/server/auth/auth-config";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;

export class LoginRateLimitError extends Error {
  readonly code = "TOO_MANY_REQUESTS";

  constructor() {
    super("Too many login attempts");
    this.name = "LoginRateLimitError";
  }
}

export function isLoginRateLimitError(error: unknown): error is LoginRateLimitError {
  return error instanceof LoginRateLimitError;
}

export function getLoginAttemptIdentity(input: {
  username: string;
  ip?: string | null;
}) {
  return {
    identifierHash: hashSensitiveValue(input.username.trim().toLowerCase()),
    ipHash: input.ip ? hashSensitiveValue(input.ip) : null,
  };
}

export async function reserveLoginAttempt(input: {
  identifierHash: string;
  ipHash?: string | null;
}): Promise<{ id: string }> {
  return db.$transaction(async (tx) => {
    const since = new Date(Date.now() - WINDOW_MS);
    const failedAttempts = await tx.loginAttempt.count({
      where: {
        identifierHash: input.identifierHash,
        succeeded: false,
        attemptedAt: { gte: since },
      },
    });

    if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
      throw new LoginRateLimitError();
    }

    const attempt = await tx.loginAttempt.create({
      data: {
        identifierHash: input.identifierHash,
        ipHash: input.ipHash ?? null,
        succeeded: false,
      },
      select: { id: true },
    });

    const cutoff = new Date(Date.now() - WINDOW_MS * 4);
    await tx.loginAttempt.deleteMany({
      where: { attemptedAt: { lt: cutoff } },
    });

    return attempt;
  });
}

export async function markLoginAttemptSucceeded(id: string): Promise<void> {
  await db.loginAttempt.update({
    where: { id },
    data: { succeeded: true },
  });
}
