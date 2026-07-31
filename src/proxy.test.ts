// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

function getCspDirective(policy: string, directive: string): string {
  return (
    policy
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(`${directive} `)) ?? ""
  );
}

async function loadProxy() {
  const { proxy } = await import("./proxy");
  return proxy;
}

describe("proxy CSP — production", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("sets Content-Security-Policy on a public path", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const proxy = await loadProxy();
    const response = proxy(new NextRequest("http://localhost/login"));
    const csp = response.headers.get("Content-Security-Policy");
    expect(csp).toBeTruthy();
  });

  it("script-src contains 'self' and a nonce in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const proxy = await loadProxy();
    const response = proxy(new NextRequest("http://localhost/login"));
    const csp = response.headers.get("Content-Security-Policy")!;
    const scriptSrc = getCspDirective(csp, "script-src");
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("'nonce-");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("script-src-elem contains nonce and no unsafe-inline", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const proxy = await loadProxy();
    const response = proxy(new NextRequest("http://localhost/login"));
    const csp = response.headers.get("Content-Security-Policy")!;
    const scriptSrcElem = getCspDirective(csp, "script-src-elem");
    expect(scriptSrcElem).toContain("'nonce-");
    expect(scriptSrcElem).not.toContain("'unsafe-inline'");
  });
});

describe("proxy CSP — development", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("script-src contains 'unsafe-eval' in development", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
    const { proxy } = await import("./proxy");
    const response = proxy(new NextRequest("http://localhost/login"));
    const csp = response.headers.get("Content-Security-Policy")!;
    const scriptSrc = getCspDirective(csp, "script-src");
    expect(scriptSrc).toContain("'unsafe-eval'");
  });
});

describe("proxy nonce", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("sets x-nonce header", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const proxy = await loadProxy();
    const response = proxy(new NextRequest("http://localhost/login"));
    expect(response.headers.get("x-nonce")).toBeTruthy();
  });

  it("nonce is non-empty", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const proxy = await loadProxy();
    const response = proxy(new NextRequest("http://localhost/login"));
    const nonce = response.headers.get("x-nonce")!;
    expect(nonce.length).toBeGreaterThan(0);
  });

  it("nonce appears in script-src", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const proxy = await loadProxy();
    const response = proxy(new NextRequest("http://localhost/login"));
    const nonce = response.headers.get("x-nonce")!;
    const csp = response.headers.get("Content-Security-Policy")!;
    const scriptSrc = getCspDirective(csp, "script-src");
    expect(scriptSrc).toContain(`'nonce-${nonce}'`);
  });

  it("two requests produce different nonces", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const proxy = await loadProxy();
    const r1 = proxy(new NextRequest("http://localhost/login"));
    const r2 = proxy(new NextRequest("http://localhost/login"));
    expect(r1.headers.get("x-nonce")).not.toBe(r2.headers.get("x-nonce"));
  });
});

describe("proxy CSP on different response types", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("sets CSP on a public path that returns NextResponse.next", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const proxy = await loadProxy();
    // /login is public, so proxy returns NextResponse.next
    const response = proxy(new NextRequest("http://localhost/login"));
    expect(response.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  it("sets CSP on a redirect (unauthenticated protected page)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const proxy = await loadProxy();
    // /dashboard is protected and no cookie -> redirect
    const response = proxy(new NextRequest("http://localhost/dashboard"));
    expect(response.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  it("sets CSP on 401 response (unauthenticated API)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const proxy = await loadProxy();
    // /api/complaints is protected and no cookie -> 401
    const response = proxy(new NextRequest("http://localhost/api/complaints"));
    expect(response.headers.get("Content-Security-Policy")).toBeTruthy();
    expect(response.status).toBe(401);
  });
});
