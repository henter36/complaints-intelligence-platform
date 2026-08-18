import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Opaque, server-resolvable drillthrough token for a complainant identifier
 * (spec: "لا تمرر رقم الهوية الخام في URL... استخدم معرفاً داخلياً آمناً").
 * AES-256-GCM with a random IV per call — the same identifier encodes to a
 * different token every time, so two people can never correlate sessions by
 * comparing token strings. Only this server (holding COMPLAINANT_TOKEN_SECRET)
 * can decode a token back to the real identifier.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/** Mirrors `getAuthSecret()` in auth-config.ts: required in production, a fixed dev/test fallback otherwise. */
export function getComplainantTokenSecret(): string {
  if (env.nodeEnv === "production" && !env.complainantTokenSecret) {
    throw new Error("COMPLAINANT_TOKEN_SECRET is required in production.");
  }

  const secret = env.complainantTokenSecret ?? "test-complainant-token-secret-32bytes";

  if (env.nodeEnv === "production" && secret.length < 32) {
    throw new Error("COMPLAINANT_TOKEN_SECRET must be at least 32 characters in production.");
  }

  return secret;
}

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function encodeComplainantToken(identifier: string): string {
  const key = deriveKey(getComplainantTokenSecret());
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(identifier, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64url");
}

/** Returns null (never throws) for a malformed, tampered, or foreign token — callers treat this as "no match". */
export function decodeComplainantToken(token: string): string | null {
  try {
    const buf = Buffer.from(token, "base64url");
    if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) return null;
    const iv = buf.subarray(0, IV_LENGTH);
    const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const key = deriveKey(getComplainantTokenSecret());
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}
