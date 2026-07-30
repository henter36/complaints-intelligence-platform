import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password-service";

const BCRYPT_TEST_TIMEOUT_MS = 15_000;

describe("password service", () => {
  it("accepts the correct password and rejects the wrong password", async () => {
    const hash = await hashPassword("StrongPassword123");

    await expect(verifyPassword("StrongPassword123", hash)).resolves.toBe(true);
    await expect(verifyPassword("WrongPassword123", hash)).resolves.toBe(false);
  }, BCRYPT_TEST_TIMEOUT_MS);

  it("uses a different salted hash for the same password", async () => {
    const first = await hashPassword("StrongPassword123");
    const second = await hashPassword("StrongPassword123");

    expect(first).not.toBe(second);
    expect(first).not.toContain("StrongPassword123");
  }, BCRYPT_TEST_TIMEOUT_MS);

  it("rejects invalid hashes safely", async () => {
    await expect(verifyPassword("StrongPassword123", "not-a-valid-hash")).resolves.toBe(false);
  });
});
