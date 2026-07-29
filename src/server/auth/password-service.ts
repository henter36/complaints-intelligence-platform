import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 12;

export class PasswordValidationError extends Error {
  readonly code = "WEAK_PASSWORD";

  constructor(message: string) {
    super(message);
    this.name = "PasswordValidationError";
  }
}

export async function hashPassword(password: string): Promise<string> {
  validateNewPassword(password);
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, passwordHash);
  } catch {
    return false;
  }
}

export function validateNewPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordValidationError("كلمة المرور الجديدة يجب ألا تقل عن 12 حرفًا");
  }

  const hasLetter = /[\p{L}]/u.test(password);
  const hasNumber = /\d/.test(password);

  if (!hasLetter || !hasNumber) {
    throw new PasswordValidationError("كلمة المرور الجديدة يجب أن تحتوي على حروف وأرقام");
  }
}

export function isPasswordValidationError(error: unknown): error is PasswordValidationError {
  return error instanceof PasswordValidationError;
}
