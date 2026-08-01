// @vitest-environment node
import type { NextConfig } from "next";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("next.config security headers", () => {
  it("does not set Content-Security-Policy (delegated to proxy)", async () => {
    const headersFn = (nextConfig as NextConfig).headers;
    const headerGroups = headersFn ? await headersFn() : [];
    const allHeaders = headerGroups.flatMap((group) => group.headers);
    const hasCsp = allHeaders.some((h) => h.key === "Content-Security-Policy");
    expect(hasCsp).toBe(false);
  });

  it("keeps X-Frame-Options header", async () => {
    const headersFn = (nextConfig as NextConfig).headers;
    const headerGroups = headersFn ? await headersFn() : [];
    const allHeaders = headerGroups.flatMap((group) => group.headers);
    expect(allHeaders.some((h) => h.key === "X-Frame-Options")).toBe(true);
  });
});
