import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const count = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    complaint: {
      findMany,
      count,
    },
  },
}));

describe("GET /api/dashboard", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

  beforeEach(() => {
    findMany.mockReset();
    count.mockReset();
  });

  afterEach(() => {
    consoleError.mockClear();
    vi.useRealTimers();
  });

  it("returns dashboard aggregates for a successful read", async () => {
    const now = new Date();
    findMany
      .mockResolvedValueOnce([
        {
          id: "cmp_1",
          status: "OPEN",
          priority: "HIGH",
          severity: "MEDIUM",
          complaintDate: new Date(now.getTime() - 60 * 60 * 1000),
          receivedAt: new Date(now.getTime() - 60 * 60 * 1000),
          dueDate: new Date(now.getTime() - 60 * 1000),
          closedAt: null,
          firstActionAt: null,
          processingStartedAt: null,
          isRepeated: false,
          isValidated: false,
          isPotentialDuplicate: false,
          beneficiarySatisfaction: null,
          classificationId: "c_1",
          region: "الرياض",
          department: "الطوارئ",
          classification: { nameAr: "المواعيد" },
          channel: "الهاتف",
        },
      ])
      .mockResolvedValueOnce([
        {
          complaintDate: now,
          receivedAt: now,
          status: "OPEN",
        },
      ]);
    count.mockResolvedValue(0);

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost/api/dashboard"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.volume.total).toBe(1);
    expect(body.volume.late).toBe(1);
    expect(body.distributions.byRegion).toEqual([{ name: "الرياض", count: 1 }]);
  });

  it("returns 500 when the database read fails", async () => {
    findMany.mockRejectedValueOnce(new Error("database unavailable"));

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost/api/dashboard"));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to fetch dashboard data");
  });

  it("applies dashboard request filters to trend query", async () => {
    const now = new Date("2026-07-31T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    findMany
      .mockResolvedValueOnce([
        {
          id: "cmp_1",
          status: "OPEN",
          priority: "HIGH",
          severity: "MEDIUM",
          complaintDate: new Date("2026-07-30T00:00:00Z"),
          receivedAt: new Date("2026-07-30T00:00:00Z"),
          dueDate: null,
          closedAt: null,
          firstActionAt: null,
          processingStartedAt: null,
          isRepeated: true,
          isValidated: true,
          isPotentialDuplicate: false,
          beneficiarySatisfaction: null,
          classificationId: "cls_1",
          region: "الرياض",
          department: "الطوارئ",
          classification: { nameAr: "المواعيد" },
          channel: "الهاتف",
        },
      ])
      .mockResolvedValueOnce([
        {
          complaintDate: new Date("2026-07-30T00:00:00Z"),
          status: "OPEN",
        },
      ]);
    count.mockResolvedValue(0);

    const { GET } = await import("./route");
    const response = await GET(new NextRequest(
      "http://localhost/api/dashboard?regionId=الرياض&departmentId=الطوارئ&status=OPEN&classificationId=cls_1&channel=الهاتف&priority=HIGH&severity=MEDIUM&isRepeated=true&isValidated=true&from=2026-07-20&to=2026-07-31"
    ));

    expect(response.status).toBe(200);
    expect(findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({
        isDeleted: false,
        region: "الرياض",
        department: "الطوارئ",
        status: "OPEN",
        classificationId: "cls_1",
        channel: "الهاتف",
        priority: "HIGH",
        severity: "MEDIUM",
        isRepeated: true,
        isValidated: true,
        complaintDate: {
          gte: new Date("2026-07-20"),
          lte: new Date("2026-07-31"),
        },
      }),
      select: { complaintDate: true, status: true },
    }));
  });

  it("returns an empty trend series when the requested dates do not intersect the 30-day window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T12:00:00Z"));
    findMany.mockResolvedValueOnce([]);
    count.mockResolvedValue(0);

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost/api/dashboard?from=2026-01-01&to=2026-01-31"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.trend.trendData).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
