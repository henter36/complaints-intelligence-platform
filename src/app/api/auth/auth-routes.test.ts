import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "@/server/auth/password-service";

const loginAttemptCount = vi.fn();
const loginAttemptCreate = vi.fn();
const loginAttemptDeleteMany = vi.fn();
const loginAttemptUpdate = vi.fn();
const adminCredentialFindMany = vi.fn();
const adminCredentialUpdate = vi.fn();
const adminSessionCreate = vi.fn();
const adminSessionFindUnique = vi.fn();
const adminSessionUpdate = vi.fn();
const adminSessionUpdateMany = vi.fn();
const auditLogCreate = vi.fn();
const complaintFindMany = vi.fn();
const complaintCount = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    loginAttempt: {
      count: loginAttemptCount,
      create: loginAttemptCreate,
      deleteMany: loginAttemptDeleteMany,
      update: loginAttemptUpdate,
    },
    adminCredential: {
      findMany: adminCredentialFindMany,
      findFirst: vi.fn().mockResolvedValue({ username: "admin" }),
      update: adminCredentialUpdate,
    },
    adminSession: {
      create: adminSessionCreate,
      findUnique: adminSessionFindUnique,
      update: adminSessionUpdate,
      updateMany: adminSessionUpdateMany,
    },
    auditLog: {
      create: auditLogCreate,
    },
    complaint: {
      findMany: complaintFindMany,
      count: complaintCount,
    },
    $transaction: vi.fn(async (callback) => callback({
      adminCredential: {
        findMany: adminCredentialFindMany,
        findFirst: vi.fn().mockResolvedValue({ username: "admin" }),
        update: adminCredentialUpdate,
      },
      loginAttempt: {
        count: loginAttemptCount,
        create: loginAttemptCreate,
        deleteMany: loginAttemptDeleteMany,
        update: loginAttemptUpdate,
      },
      adminSession: {
        create: adminSessionCreate,
        findUnique: adminSessionFindUnique,
        update: adminSessionUpdate,
        updateMany: adminSessionUpdateMany,
      },
      auditLog: { create: auditLogCreate },
    })),
  },
}));

function jsonRequest(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost",
      Host: "localhost",
    },
    body: JSON.stringify(body),
  });
}

describe("auth API routes", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    loginAttemptCount.mockResolvedValue(0);
    loginAttemptCreate.mockResolvedValue({ id: "attempt_1" });
    loginAttemptDeleteMany.mockResolvedValue({ count: 0 });
    loginAttemptUpdate.mockResolvedValue({ id: "attempt_1" });
    adminSessionCreate.mockResolvedValue({ id: "session_1" });
    adminCredentialUpdate.mockResolvedValue({ id: "admin_1", username: "admin" });
    adminSessionUpdateMany.mockResolvedValue({ count: 1 });
    auditLogCreate.mockResolvedValue({});
  });

  afterEach(() => {
    consoleError.mockClear();
  });

  it("logs in with valid credentials and does not return the session token in JSON", async () => {
    adminCredentialFindMany.mockResolvedValue([
      {
        id: "admin_1",
        username: "admin",
        passwordHash: await hashPassword("StrongPassword123"),
      },
    ]);

    const { POST } = await import("./login/route");
    const response = await POST(jsonRequest("/api/auth/login", {
      username: "admin",
      password: "StrongPassword123",
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ authenticated: true, username: "admin" });
    expect(JSON.stringify(body)).not.toContain("cip_session");
    expect(response.headers.get("set-cookie")).toContain("cip_session=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")?.toLowerCase()).toContain("samesite=lax");
    expect(loginAttemptUpdate).toHaveBeenCalledWith({
      where: { id: "attempt_1" },
      data: { succeeded: true },
    });
  });

  it("uses a generic error for invalid credentials", async () => {
    adminCredentialFindMany.mockResolvedValue([
      {
        id: "admin_1",
        username: "admin",
        passwordHash: await hashPassword("StrongPassword123"),
      },
    ]);

    const { POST } = await import("./login/route");
    const response = await POST(jsonRequest("/api/auth/login", {
      username: "admin",
      password: "WrongPassword123",
    }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.message).toBe("بيانات الدخول غير صحيحة");
  });

  it("rate limits repeated failed login attempts", async () => {
    loginAttemptCount.mockResolvedValue(5);

    const { POST } = await import("./login/route");
    const response = await POST(jsonRequest("/api/auth/login", {
      username: "admin",
      password: "WrongPassword123",
    }));
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body.error.code).toBe("TOO_MANY_REQUESTS");
  });

  it("returns 500 when session creation fails after credentials are valid", async () => {
    adminCredentialFindMany.mockResolvedValue([
      {
        id: "admin_1",
        username: "admin",
        passwordHash: await hashPassword("StrongPassword123"),
      },
    ]);
    adminSessionCreate.mockRejectedValueOnce(new Error("session store unavailable"));

    const { POST } = await import("./login/route");
    const response = await POST(jsonRequest("/api/auth/login", {
      username: "admin",
      password: "StrongPassword123",
    }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("LOGIN_UNAVAILABLE");
  });

  it("rejects protected complaints API requests without a session", async () => {
    const { GET } = await import("../complaints/route");
    const response = await GET(new NextRequest("http://localhost/api/complaints"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(complaintFindMany).not.toHaveBeenCalled();
  });

  it("changes password and revokes existing sessions", async () => {
    const currentHash = await hashPassword("StrongPassword123");
    adminCredentialFindMany.mockResolvedValue([
      {
        id: "admin_1",
        username: "admin",
        passwordHash: currentHash,
      },
    ]);
    adminSessionFindUnique.mockResolvedValue({
      id: "session_1",
      tokenHash: "hashed",
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      lastSeenAt: new Date(),
    });

    const { POST } = await import("./change-password/route");
    const request = jsonRequest("/api/auth/change-password", {
      currentPassword: "StrongPassword123",
      newPassword: "NewStrongPassword123",
      confirmPassword: "NewStrongPassword123",
    });
    request.cookies.set("cip_session", "raw-token");

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(adminCredentialUpdate).toHaveBeenCalled();
    expect(adminSessionUpdateMany).toHaveBeenCalledWith({
      where: { revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(response.headers.get("set-cookie")).toContain("cip_session=");
  });

  it("does not report logout success when session revocation fails", async () => {
    adminSessionFindUnique.mockResolvedValue({
      id: "session_1",
      tokenHash: "hashed",
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      lastSeenAt: new Date(),
    });
    adminSessionUpdate.mockRejectedValueOnce(new Error("revocation failed"));

    const { POST } = await import("./logout/route");
    const request = jsonRequest("/api/auth/logout", {});
    request.cookies.set("cip_session", "raw-token");

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("LOGOUT_FAILED");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
