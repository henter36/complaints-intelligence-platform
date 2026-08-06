import { describe, expect, it } from "vitest";
import { isDevDbUrl } from "./benchmark-paths";

describe("isDevDbUrl", () => {
  it("matches unix absolute file URL", () => {
    expect(isDevDbUrl("file:/Users/me/project/prisma/dev.db")).toBe(true);
  });

  it("matches unix relative path", () => {
    expect(isDevDbUrl("prisma/dev.db")).toBe(true);
  });

  it("matches unix absolute path without file prefix", () => {
    expect(isDevDbUrl("/tmp/work/prisma/dev.db")).toBe(true);
  });

  it("matches windows file URL path", () => {
    expect(isDevDbUrl(String.raw`file:C:\work\repo\prisma\dev.db`)).toBe(true);
  });

  it("does not match other sqlite files", () => {
    expect(isDevDbUrl("file:/Users/me/project/prisma/test.db")).toBe(false);
  });
});
