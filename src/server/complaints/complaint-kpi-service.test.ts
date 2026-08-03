import { ComplaintPriority, ComplaintStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getComplaintKpis, getPreviousPeriodRange } from "./complaint-kpi-service";

const dbMocks = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    complaint: {
      findMany: dbMocks.findMany,
    },
  },
}));

function complaint(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmp_1",
    status: ComplaintStatus.OPEN,
    priority: ComplaintPriority.MEDIUM,
    severity: ComplaintPriority.MEDIUM,
    complaintDate: new Date("2026-07-01T00:00:00Z"),
    receivedAt: new Date("2026-07-01T00:00:00Z"),
    dueDate: null,
    closedAt: null,
    firstActionAt: null,
    processingStartedAt: null,
    delayReason: null,
    isRepeated: false,
    isValidated: true,
    isPotentialDuplicate: false,
    beneficiarySatisfaction: null,
    region: "الرياض",
    facility: "المركز",
    department: "الدعم",
    classificationId: "cls_1",
    categoryId: "cat_1",
    channel: "الهاتف",
    subject: "موضوع",
    classification: { id: "cls_1", nameAr: "تصنيف" },
    category: { id: "cat_1", nameAr: "فئة" },
    statusHistory: [],
    ...overrides,
  };
}

describe("complaint KPI service", () => {
  beforeEach(() => {
    dbMocks.findMany.mockReset();
  });

  it("marks reopenCount increases as negative", async () => {
    dbMocks.findMany
      .mockResolvedValueOnce([
        complaint({
          statusHistory: [
            { fromStatus: ComplaintStatus.CLOSED, toStatus: ComplaintStatus.OPEN },
          ],
        }),
      ])
      .mockResolvedValueOnce([complaint()]);

    const result = await getComplaintKpis(
      new URLSearchParams("from=2026-07-01&to=2026-07-31"),
      new Date("2026-07-31T00:00:00Z")
    );

    expect(result.kpis.reopenCount.currentValue).toBe(1);
    expect(result.kpis.reopenCount.previousValue).toBe(0);
    expect(result.kpis.reopenCount.trend).toBe("up");
    expect(result.kpis.reopenCount.direction).toBe("negative");
  });

  it("does not merge classification groups with the same name and different ids", async () => {
    dbMocks.findMany.mockResolvedValueOnce([
      complaint({ id: "cmp_1", classificationId: "cls_1", classification: { id: "cls_1", nameAr: "مشترك" } }),
      complaint({ id: "cmp_2", classificationId: "cls_2", classification: { id: "cls_2", nameAr: "مشترك" } }),
    ]);

    const result = await getComplaintKpis(new URLSearchParams(), new Date("2026-07-31T00:00:00Z"));

    expect(result.distributions.byClassification).toHaveLength(2);
    expect(result.distributions.byClassification.map((item) => item.id).sort()).toEqual(["cls_1", "cls_2"]);
  });

  it("uses the name as group key when id is missing", async () => {
    dbMocks.findMany.mockResolvedValueOnce([
      complaint({ id: "cmp_1", classificationId: null, classification: null }),
      complaint({ id: "cmp_2", classificationId: null, classification: null }),
    ]);

    const result = await getComplaintKpis(new URLSearchParams(), new Date("2026-07-31T00:00:00Z"));

    expect(result.distributions.byClassification).toHaveLength(1);
    expect(result.distributions.byClassification[0]).toMatchObject({ name: "غير مصنف", id: null, total: 2 });
  });

  it("keeps drill-down ids on grouped metrics", async () => {
    dbMocks.findMany.mockResolvedValueOnce([
      complaint({ classificationId: "cls_1", classification: { id: "cls_1", nameAr: "تصنيف" } }),
    ]);

    const result = await getComplaintKpis(new URLSearchParams(), new Date("2026-07-31T00:00:00Z"));

    expect(result.distributions.byClassification[0]?.id).toBe("cls_1");
  });

  it("builds a 30-day trend when no range is requested", async () => {
    dbMocks.findMany.mockResolvedValueOnce([]);

    const result = await getComplaintKpis(new URLSearchParams(), new Date("2026-07-31T00:00:00Z"));

    expect(result.trend.trendData).toHaveLength(30);
  });

  it("builds trend buckets for an old requested range", async () => {
    dbMocks.findMany
      .mockResolvedValueOnce([
        complaint({ complaintDate: new Date("2026-01-02T00:00:00Z"), receivedAt: new Date("2026-01-02T00:00:00Z") }),
      ])
      .mockResolvedValueOnce([]);

    const result = await getComplaintKpis(
      new URLSearchParams("from=2026-01-01&to=2026-01-03"),
      new Date("2026-07-31T00:00:00Z")
    );

    expect(result.trend.trendData).toHaveLength(3);
    expect(result.trend.trendData.find((point) => point.date === "2026-01-02")?.total).toBe(1);
  });

  it("builds a one-day trend for a one-day range", async () => {
    dbMocks.findMany
      .mockResolvedValueOnce([complaint({ complaintDate: new Date("2026-01-02T12:00:00Z") })])
      .mockResolvedValueOnce([]);

    const result = await getComplaintKpis(
      new URLSearchParams("from=2026-01-02&to=2026-01-02"),
      new Date("2026-07-31T00:00:00Z")
    );

    expect(result.trend.trendData).toEqual([
      expect.objectContaining({ date: "2026-01-02", total: 1 }),
    ]);
  });

  it("excludes data outside the requested trend range", async () => {
    dbMocks.findMany
      .mockResolvedValueOnce([
        complaint({ id: "inside", complaintDate: new Date("2026-01-02T00:00:00Z") }),
        complaint({ id: "outside", complaintDate: new Date("2026-01-05T00:00:00Z") }),
      ])
      .mockResolvedValueOnce([]);

    const result = await getComplaintKpis(
      new URLSearchParams("from=2026-01-01&to=2026-01-03"),
      new Date("2026-07-31T00:00:00Z")
    );

    expect(result.trend.trendData.reduce((sum, point) => sum + point.total, 0)).toBe(1);
  });

  it("returns actual classification cross-tab counts", async () => {
    dbMocks.findMany.mockResolvedValueOnce([
      complaint({ id: "cmp_1", region: "الرياض", department: "أ", classification: { id: "cls_1", nameAr: "تصنيف" } }),
      complaint({ id: "cmp_2", region: "الرياض", department: "ب", classification: { id: "cls_1", nameAr: "تصنيف" } }),
    ]);

    const result = await getComplaintKpis(new URLSearchParams(), new Date("2026-07-31T00:00:00Z"));

    expect(result.crossTabs.classificationByRegion).toEqual([
      expect.objectContaining({ classification: "تصنيف", group: "الرياض", count: 2 }),
    ]);
    expect(result.crossTabs.classificationByDepartment).toEqual([
      expect.objectContaining({ group: "أ", count: 1 }),
      expect.objectContaining({ group: "ب", count: 1 }),
    ]);
  });

  it("uses the shared status and due-date rules for open, late, and compliance KPIs", async () => {
    const now = new Date("2026-07-31T00:00:00Z");
    dbMocks.findMany.mockResolvedValueOnce([
      complaint({ id: "open-new", status: ComplaintStatus.NEW }),
      complaint({ id: "open-progress", status: ComplaintStatus.IN_PROGRESS }),
      complaint({
        id: "open-late",
        status: ComplaintStatus.AWAITING_RESPONSE,
        dueDate: new Date("2026-07-20T00:00:00Z"),
      }),
      complaint({
        id: "closed-on-time",
        status: ComplaintStatus.CLOSED,
        dueDate: new Date("2026-07-20T00:00:00Z"),
        closedAt: new Date("2026-07-20T00:00:00Z"),
      }),
      complaint({
        id: "closed-late",
        status: ComplaintStatus.RESOLVED,
        dueDate: new Date("2026-07-20T00:00:00Z"),
        closedAt: new Date("2026-07-21T00:00:00Z"),
      }),
      complaint({ id: "closed-no-due", status: ComplaintStatus.CLOSED, closedAt: now }),
    ]);

    const result = await getComplaintKpis(new URLSearchParams(), now);

    expect(result.volume.open).toBe(3);
    expect(result.volume.closed).toBe(3);
    expect(result.kpis.currentlyLateComplaints.currentValue).toBe(1);
    expect(result.kpis.closedLateComplaints.currentValue).toBe(1);
    expect(result.performance.onTimeEligibleClosed).toBe(2);
    expect(result.performance.onTimeRate).toBe(50);
  });

  it("marks compliance unavailable when no closed complaint can be judged", async () => {
    dbMocks.findMany.mockResolvedValueOnce([
      complaint({ status: ComplaintStatus.OPEN, dueDate: null }),
      complaint({ id: "closed-no-due", status: ComplaintStatus.CLOSED, closedAt: new Date("2026-07-20T00:00:00Z") }),
    ]);

    const result = await getComplaintKpis(new URLSearchParams(), new Date("2026-07-31T00:00:00Z"));

    expect(result.performance.onTimeEligibleClosed).toBe(0);
    expect(result.performance.onTimeRate).toBeNull();
    expect(result.kpis.dueDateComplianceRate.available).toBe(false);
    expect(result.kpis).not.toHaveProperty("dueDateEligibleClosed");
  });

  it("normalizes equivalent region names into one group", async () => {
    dbMocks.findMany.mockResolvedValueOnce([
      complaint({ id: "r1", region: "الرياض" }),
      complaint({ id: "r2", region: "منطقة الرياض" }),
    ]);

    const result = await getComplaintKpis(new URLSearchParams(), new Date("2026-07-31T00:00:00Z"));

    expect(result.distributions.byRegion).toEqual([
      expect.objectContaining({ name: "منطقة الرياض", total: 2 }),
    ]);
  });

  it("derives the same dates from the previous year when requested", () => {
    const previous = getPreviousPeriodRange(
      new Date("2026-01-03T00:00:00Z"),
      new Date("2026-08-02T00:00:00Z"),
      "SAME_PERIOD_LAST_YEAR"
    );
    expect(previous?.from.toISOString()).toBe("2025-01-03T00:00:00.000Z");
    expect(previous?.to.toISOString()).toBe("2025-08-02T00:00:00.000Z");
  });

  it("does not query comparison data when comparison is disabled", async () => {
    dbMocks.findMany.mockResolvedValueOnce([]);
    await getComplaintKpis(
      new URLSearchParams("from=2026-07-01&to=2026-07-31"),
      new Date("2026-07-31T00:00:00Z"),
      { includeComparison: false }
    );
    expect(dbMocks.findMany).toHaveBeenCalledTimes(1);
  });

  describe("byRegionPriority", () => {
    it("counts complaints per region broken down by priority", async () => {
      dbMocks.findMany.mockResolvedValueOnce([
        complaint({ id: "c1", region: "الرياض", priority: ComplaintPriority.CRITICAL }),
        complaint({ id: "c2", region: "الرياض", priority: ComplaintPriority.HIGH }),
        complaint({ id: "c3", region: "الرياض", priority: ComplaintPriority.MEDIUM }),
        complaint({ id: "c4", region: "جدة", priority: ComplaintPriority.LOW }),
        complaint({ id: "c5", region: "جدة", priority: ComplaintPriority.MEDIUM }),
      ]);

      const result = await getComplaintKpis(new URLSearchParams(), new Date("2026-07-31T00:00:00Z"));
      const riyadh = result.distributions.byRegionPriority.find((r) => r.region.includes("الرياض"));
      const jeddah = result.distributions.byRegionPriority.find((r) => r.region.includes("جدة"));

      expect(riyadh).toMatchObject({ critical: 1, high: 1, medium: 1, low: 0, unknown: 0, total: 3 });
      expect(jeddah).toMatchObject({ critical: 0, high: 0, medium: 1, low: 1, unknown: 0, total: 2 });
    });

    it("sorts rows by descending total", async () => {
      dbMocks.findMany.mockResolvedValueOnce([
        complaint({ id: "c1", region: "جدة", priority: ComplaintPriority.MEDIUM }),
        complaint({ id: "c2", region: "الرياض", priority: ComplaintPriority.HIGH }),
        complaint({ id: "c3", region: "الرياض", priority: ComplaintPriority.LOW }),
      ]);

      const result = await getComplaintKpis(new URLSearchParams(), new Date("2026-07-31T00:00:00Z"));
      expect(result.distributions.byRegionPriority[0]!.total).toBeGreaterThanOrEqual(
        result.distributions.byRegionPriority[1]!.total
      );
    });
  });

  describe("previousDistributions", () => {
    it("returns previousDistributions when a comparison period is available", async () => {
      dbMocks.findMany
        .mockResolvedValueOnce([
          complaint({ id: "curr", region: "الرياض" }),
        ])
        .mockResolvedValueOnce([
          complaint({ id: "prev1", region: "جدة" }),
          complaint({ id: "prev2", region: "جدة" }),
        ]);

      const result = await getComplaintKpis(
        new URLSearchParams("from=2026-07-01&to=2026-07-31"),
        new Date("2026-07-31T00:00:00Z")
      );

      expect(result.previousDistributions).not.toBeNull();
      const prevJeddah = result.previousDistributions?.byRegion.find((r) => r.name.includes("جدة"));
      expect(prevJeddah?.total).toBe(2);
    });

    it("returns null previousDistributions when no comparison period is derivable", async () => {
      dbMocks.findMany.mockResolvedValueOnce([complaint()]);

      // No from/to → no previous period
      const result = await getComplaintKpis(
        new URLSearchParams(),
        new Date("2026-07-31T00:00:00Z")
      );

      expect(result.previousDistributions).toBeNull();
    });
  });
});
