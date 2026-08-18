import { describe, expect, it } from "vitest";
import { encodeComplainantToken, decodeComplainantToken } from "./complainant-token";

describe("complainant token", () => {
  it("round-trips an identifier through encode/decode", () => {
    const token = encodeComplainantToken("1082536010");
    expect(decodeComplainantToken(token)).toBe("1082536010");
  });

  it("never emits the raw identifier as a substring of the token", () => {
    const token = encodeComplainantToken("1082536010");
    expect(token).not.toContain("1082536010");
  });

  it("produces a different token every call for the same identifier (random IV)", () => {
    const a = encodeComplainantToken("1082536010");
    const b = encodeComplainantToken("1082536010");
    expect(a).not.toBe(b);
    expect(decodeComplainantToken(a)).toBe("1082536010");
    expect(decodeComplainantToken(b)).toBe("1082536010");
  });

  it("returns null (never throws) for garbage input", () => {
    expect(decodeComplainantToken("not-a-real-token")).toBeNull();
    expect(decodeComplainantToken("")).toBeNull();
    expect(decodeComplainantToken("a")).toBeNull();
  });

  it("returns null for a tampered token (auth tag mismatch)", () => {
    const token = encodeComplainantToken("1082536010");
    const tampered = token.slice(0, -4) + (token.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    expect(decodeComplainantToken(tampered)).toBeNull();
  });

  it("round-trips Arabic and mixed-format identifiers", () => {
    const token = encodeComplainantToken("ن-1234-أ");
    expect(decodeComplainantToken(token)).toBe("ن-1234-أ");
  });
});
