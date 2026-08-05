import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  categoryFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    complaint: { findMany: mocks.findMany },
    category: { findMany: mocks.categoryFindMany },
  },
}));

vi.mock("@/server/auth/auth-guard", () => ({
  requireAdminApiSession: vi.fn().mockResolvedValue({ id: "session_test", username: "admin" }),
  mapAuthError: vi.fn().mockReturnValue(null),
}));

import { GET } from "./route";

describe("GET /api/filters wingCode query", () => {
  beforeEach(() => {
    mocks.findMany.mockReset();
    mocks.categoryFindMany.mockReset();
    mocks.categoryFindMany.mockResolvedValue([]);
  });

  it("queries wingCode with distinct, orderBy asc, and take 500", async () => {
    mocks.findMany.mockImplementation(async (args: { distinct?: string[]; orderBy?: unknown; take?: number }) => {
      if (args.distinct?.[0] === "wingCode") {
        expect(args.orderBy).toEqual({ wingCode: "asc" });
        expect(args.take).toBe(500);
        return Array.from({ length: 3 }, (_, i) => ({ wingCode: `W${i + 1}` }));
      }
      return [];
    });

    const res = await GET(new NextRequest("http://localhost/api/filters"));
    expect(res.status).toBe(200);
    const body = await res.json();

    const wingQuery = mocks.findMany.mock.calls.find(
      (call) => call[0]?.distinct?.[0] === "wingCode"
    )?.[0];
    expect(wingQuery).toMatchObject({
      where: { isDeleted: false, wingCode: { not: null } },
      select: { wingCode: true },
      distinct: ["wingCode"],
      orderBy: { wingCode: "asc" },
      take: 500,
    });

    expect(body.wingCodes[0]).toEqual({ id: "__UNSPECIFIED__", name: "غير محدد" });
    expect(body.wingCodes).toHaveLength(4);
    expect(body.wingCodes.some((w: { id: string }) => w.id === null || w.id === "")).toBe(false);
  });

  it("does not return more than 500 real wing codes plus unspecified", async () => {
    mocks.findMany.mockImplementation(async (args: { distinct?: string[]; take?: number }) => {
      if (args.distinct?.[0] === "wingCode") {
        expect(args.take).toBe(500);
        return Array.from({ length: 500 }, (_, i) => ({ wingCode: `CODE_${i}` }));
      }
      return [];
    });

    const res = await GET(new NextRequest("http://localhost/api/filters"));
    const body = await res.json();
    expect(body.wingCodes).toHaveLength(501);
    expect(body.wingCodes[0].name).toBe("غير محدد");
    expect(body.wingCodes.slice(1)).toHaveLength(500);
  });

  it("excludes null wing codes from the real code list", async () => {
    mocks.findMany.mockImplementation(async (args: { distinct?: string[] }) => {
      if (args.distinct?.[0] === "wingCode") {
        return [{ wingCode: "A1" }, { wingCode: null }, { wingCode: "  " }, { wingCode: "B2" }];
      }
      return [];
    });

    const res = await GET(new NextRequest("http://localhost/api/filters"));
    const body = await res.json();
    const real = body.wingCodes.filter((w: { id: string }) => w.id !== "__UNSPECIFIED__");
    expect(real.map((w: { id: string }) => w.id)).toEqual(["A1", "B2"]);
  });
});
