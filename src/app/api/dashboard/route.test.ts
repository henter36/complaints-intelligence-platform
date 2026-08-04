import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    complaint: {
      findMany,
    },
  },
}));

vi.mock("@/server/auth/auth-guard", () => ({
  requireAdminApiSession: vi.fn().mockResolvedValue({ id: "session_test", username: "admin" }),
  mapAuthError: vi.fn().mockReturnValue(null),
}));

describe("GET /api/dashboard", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

  beforeEach(() => {
    findMany.mockReset();
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
          // Created 8 days ago so the 7-day SLA deadline (createdAt + 7d) is 1 day in the past → OPEN_LATE
          complaintDate: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
          receivedAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
          dueDate: null,
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
    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost/api/dashboard"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.volume.total).toBe(1);
    expect(body.volume.late).toBe(1);
    expect(body.kpis.currentlyLateComplaints.currentValue).toBe(1);
    expect(body.distributions.byRegion[0]).toMatchObject({ name: "منطقة الرياض", count: 1 });
  });

  it("returns 500 when the database read fails", async () => {
    findMany.mockRejectedValueOnce(new Error("database unavailable"));

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost/api/dashboard"));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("DASHBOARD_QUERY_FAILED");
  });

  it("applies dashboard request filters to the central KPI query", async () => {
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
      .mockResolvedValueOnce([]);

    const { GET } = await import("./route");
    const response = await GET(new NextRequest(
      "http://localhost/api/dashboard?regionId=الرياض&departmentId=الطوارئ&status=OPEN&classificationId=cls_1&channel=الهاتف&priority=HIGH&severity=MEDIUM&isRepeated=true&isValidated=true&from=2026-07-20&to=2026-07-31"
    ));

    expect(response.status).toBe(200);
    expect(findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
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
      select: expect.objectContaining({ complaintDate: true, status: true, receivedAt: true }),
    }));
  });

  it("returns a stable empty trend series for empty data", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T12:00:00Z"));
    findMany.mockResolvedValue([]);

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost/api/dashboard?from=2026-01-01&to=2026-01-31"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.trend.trendData).toHaveLength(31);
    expect(body.trend.trendData.every((row: { total: number }) => row.total === 0)).toBe(true);
    expect(findMany).toHaveBeenCalled();
  });
});
