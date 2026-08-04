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

const DAY_MS = 24 * 60 * 60 * 1000;

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

  // ---------------------------------------------------------------------------
  // Seven-day SLA compliance tests (replaces dueDate-based compliance tests)
  // ---------------------------------------------------------------------------

  describe("seven-day SLA compliance", () => {
    // deadline = complaintDate + 7 days = 2026-07-08T00:00:00Z

    it("1. open complaint measured at exactly day 7 is within SLA", async () => {
      const createdAt = new Date("2026-07-01T00:00:00Z");
      const deadline = new Date(createdAt.getTime() + 7 * DAY_MS); // 2026-07-08
      dbMocks.findMany.mockResolvedValueOnce([
        complaint({ complaintDate: createdAt, status: ComplaintStatus.OPEN }),
      ]);

      const result = await getComplaintKpis(new URLSearchParams(), deadline);

      expect(result.kpis.currentlyLateComplaints.currentValue).toBe(0);
      expect(result.performance.openWithinSlaCount).toBe(1);
      expect(result.performance.slaEligibleCount).toBe(1);
      expect(result.performance.slaCompliantCount).toBe(1);
      expect(result.performance.onTimeRate).toBe(100);
    });

    it("2. open complaint measured 1ms after day 7 is late", async () => {
      const createdAt = new Date("2026-07-01T00:00:00Z");
      const justAfterDeadline = new Date(createdAt.getTime() + 7 * DAY_MS + 1);
      dbMocks.findMany.mockResolvedValueOnce([
        complaint({ complaintDate: createdAt, status: ComplaintStatus.OPEN }),
      ]);

      const result = await getComplaintKpis(new URLSearchParams(), justAfterDeadline);

      expect(result.kpis.currentlyLateComplaints.currentValue).toBe(1);
      expect(result.performance.slaEligibleCount).toBe(1);
      expect(result.performance.slaNonCompliantCount).toBe(1);
      expect(result.performance.onTimeRate).toBe(0);
    });

    it("3. dueDate field does not affect seven-day SLA result", async () => {
      const createdAt = new Date("2026-07-01T00:00:00Z");
      const farFutureDueDate = new Date(createdAt.getTime() + 60 * DAY_MS);
      const afterDeadline = new Date(createdAt.getTime() + 8 * DAY_MS);
      dbMocks.findMany.mockResolvedValueOnce([
        complaint({
          complaintDate: createdAt,
          status: ComplaintStatus.OPEN,
          dueDate: farFutureDueDate, // irrelevant — SLA ignores dueDate
        }),
      ]);

      const result = await getComplaintKpis(new URLSearchParams(), afterDeadline);

      // Despite farFutureDueDate the complaint is OPEN_LATE under SLA
      expect(result.kpis.currentlyLateComplaints.currentValue).toBe(1);
      expect(result.performance.onTimeRate).toBe(0);
    });

    it("4. complaint closed exactly on day 7 is CLOSED_WITHIN_SLA (compliant)", async () => {
      const createdAt = new Date("2026-07-01T00:00:00Z");
      const deadline = new Date(createdAt.getTime() + 7 * DAY_MS); // closedAt = deadline
      dbMocks.findMany.mockResolvedValueOnce([
        complaint({
          complaintDate: createdAt,
          status: ComplaintStatus.CLOSED,
          closedAt: deadline,
        }),
      ]);

      const result = await getComplaintKpis(new URLSearchParams(), new Date(deadline.getTime() + DAY_MS));

      expect(result.performance.closedWithinSlaCount).toBe(1);
      expect(result.performance.closedLateCount).toBe(0);
      expect(result.performance.slaCompliantCount).toBe(1);
      expect(result.performance.onTimeRate).toBe(100);
    });

    it("5. complaint closed 1s after day 7 is CLOSED_LATE (non-compliant)", async () => {
      const createdAt = new Date("2026-07-01T00:00:00Z");
      const afterDeadline = new Date(createdAt.getTime() + 7 * DAY_MS + 1000);
      dbMocks.findMany.mockResolvedValueOnce([
        complaint({
          complaintDate: createdAt,
          status: ComplaintStatus.CLOSED,
          closedAt: afterDeadline,
        }),
      ]);

      const result = await getComplaintKpis(new URLSearchParams(), new Date(createdAt.getTime() + 20 * DAY_MS));

      expect(result.performance.closedLateCount).toBe(1);
      expect(result.performance.closedWithinSlaCount).toBe(0);
      expect(result.performance.slaNonCompliantCount).toBe(1);
      expect(result.performance.onTimeRate).toBe(0);
    });

    it("6. closed complaint without closedAt does not enter SLA compliance denominator", async () => {
      dbMocks.findMany.mockResolvedValueOnce([
        complaint({ status: ComplaintStatus.CLOSED, closedAt: null }),
      ]);

      const result = await getComplaintKpis(new URLSearchParams(), new Date("2026-07-31T00:00:00Z"));

      expect(result.performance.slaEligibleCount).toBe(0);
      expect(result.performance.closedWithoutTrustedDateCount).toBe(1);
      expect(result.performance.onTimeRate).toBeNull();
      expect(result.kpis.dueDateComplianceRate.available).toBe(false);
    });

    it("7. closed complaint without closedAt does not enter average resolution calculation", async () => {
      dbMocks.findMany.mockResolvedValueOnce([
        complaint({ status: ComplaintStatus.CLOSED, closedAt: null }),
      ]);

      const result = await getComplaintKpis(new URLSearchParams(), new Date("2026-07-31T00:00:00Z"));

      expect(result.performance.averageResolutionEligibleCount).toBe(0);
      expect(result.performance.averageResolutionDays).toBeNull();
      expect(result.kpis.averageResolutionDays.available).toBe(false);
    });

    it("8. all complaints closed without closedAt → onTimeRate null, eligibleCount 0, closedWithoutTrustedDateCount correct", async () => {
      dbMocks.findMany.mockResolvedValueOnce([
        complaint({ id: "c1", status: ComplaintStatus.CLOSED, closedAt: null }),
        complaint({ id: "c2", status: ComplaintStatus.CLOSED, closedAt: null }),
        complaint({ id: "c3", status: ComplaintStatus.CLOSED, closedAt: null }),
      ]);

      const result = await getComplaintKpis(new URLSearchParams(), new Date("2026-07-31T00:00:00Z"));

      expect(result.performance.onTimeRate).toBeNull();
      expect(result.performance.slaEligibleCount).toBe(0);
      expect(result.performance.averageResolutionEligibleCount).toBe(0);
      expect(result.performance.closedWithoutTrustedDateCount).toBe(3);
    });

    it("9. complaint closed same day as creation → averageResolutionDays 0, available true, eligibleCount > 0", async () => {
      const createdAt = new Date("2026-07-01T00:00:00Z");
      dbMocks.findMany.mockResolvedValueOnce([
        complaint({
          complaintDate: createdAt,
          status: ComplaintStatus.CLOSED,
          closedAt: createdAt, // same moment
        }),
      ]);

      const result = await getComplaintKpis(new URLSearchParams(), new Date("2026-07-31T00:00:00Z"));

      expect(result.performance.averageResolutionDays).toBe(0);
      expect(result.performance.averageResolutionEligibleCount).toBeGreaterThan(0);
      expect(result.kpis.averageResolutionDays.available).toBe(true);
      // 0 days is a valid result — must not show as unavailable
    });

    it("10. open complaint with stale closedAt does not enter average resolution", async () => {
      const createdAt = new Date("2026-07-01T00:00:00Z");
      dbMocks.findMany.mockResolvedValueOnce([
        complaint({
          complaintDate: createdAt,
          status: ComplaintStatus.OPEN, // still open despite closedAt
          closedAt: new Date(createdAt.getTime() + DAY_MS),
        }),
      ]);

      const result = await getComplaintKpis(new URLSearchParams(), new Date("2026-07-31T00:00:00Z"));

      // Open complaints don't contribute resolution duration
      expect(result.performance.averageResolutionEligibleCount).toBe(0);
      expect(result.performance.averageResolutionDays).toBeNull();
    });

    it("11. counts a mixed SLA fixture and preserves the eligibility invariant", async () => {
      const oldCreatedAt = new Date("2026-07-01T00:00:00Z");
      const recentCreatedAt = new Date("2026-07-05T00:00:00Z");
      const measuredAt = new Date("2026-07-10T00:00:00Z");
      const oldDeadline = new Date(oldCreatedAt.getTime() + 7 * DAY_MS);

      dbMocks.findMany.mockResolvedValueOnce([
        complaint({
          id: "open-within",
          complaintDate: recentCreatedAt,
          status: ComplaintStatus.OPEN,
        }),
        complaint({
          id: "open-late",
          complaintDate: oldCreatedAt,
          status: ComplaintStatus.OPEN,
        }),
        complaint({
          id: "closed-within",
          complaintDate: oldCreatedAt,
          status: ComplaintStatus.CLOSED,
          closedAt: oldDeadline,
        }),
        complaint({
          id: "closed-late",
          complaintDate: oldCreatedAt,
          status: ComplaintStatus.CLOSED,
          closedAt: new Date(oldDeadline.getTime() + DAY_MS),
        }),
        complaint({
          id: "closed-without-date",
          complaintDate: oldCreatedAt,
          status: ComplaintStatus.CLOSED,
          closedAt: null,
        }),
      ]);

      const result = await getComplaintKpis(
        new URLSearchParams(),
        measuredAt
      );

      const {
        slaEligibleCount,
        slaCompliantCount,
        slaNonCompliantCount,
        openWithinSlaCount,
        closedWithinSlaCount,
        closedLateCount,
        closedWithoutTrustedDateCount,
      } = result.performance;

      expect(openWithinSlaCount).toBe(1);
      expect(result.kpis.currentlyLateComplaints.currentValue).toBe(1);
      expect(closedWithinSlaCount).toBe(1);
      expect(closedLateCount).toBe(1);
      expect(closedWithoutTrustedDateCount).toBe(1);

      expect(slaEligibleCount).toBe(4);
      expect(slaCompliantCount).toBe(2);
      expect(slaNonCompliantCount).toBe(2);
      expect(slaEligibleCount).toBe(
        slaCompliantCount + slaNonCompliantCount
      );
    });

    it("mixed SLA states produce correct counts across four eligibility categories", async () => {
      // now = 2026-07-15. Deadline for 2026-07-09 = 2026-07-16 (still within).
      const now = new Date("2026-07-15T00:00:00Z");
      const created09 = new Date("2026-07-09T00:00:00Z");   // deadline 2026-07-16
      const created24 = new Date("2026-06-24T00:00:00Z");   // deadline 2026-07-01
      dbMocks.findMany.mockResolvedValueOnce([
        // OPEN_WITHIN_SLA: deadline 2026-07-16, now 2026-07-15
        complaint({ id: "c1", complaintDate: created09, status: ComplaintStatus.OPEN }),
        // OPEN_LATE: deadline 2026-07-01, now 2026-07-15
        complaint({ id: "c2", complaintDate: created24, status: ComplaintStatus.OPEN }),
        // CLOSED_WITHIN_SLA: closedAt < deadline
        complaint({
          id: "c3", complaintDate: created09, status: ComplaintStatus.CLOSED,
          closedAt: new Date("2026-07-15T00:00:00Z"), // 6 days after created09 < deadline 2026-07-16
        }),
        // CLOSED_LATE: closedAt > deadline
        complaint({
          id: "c4", complaintDate: created24, status: ComplaintStatus.CLOSED,
          closedAt: new Date("2026-07-02T00:00:00Z"), // 1 day after deadline 2026-07-01
        }),
        // CLOSED_WITHOUT_TRUSTED_DATE
        complaint({ id: "c5", complaintDate: created09, status: ComplaintStatus.CLOSED, closedAt: null }),
      ]);

      const result = await getComplaintKpis(new URLSearchParams(), now);

      expect(result.performance.openWithinSlaCount).toBe(1);
      expect(result.performance.slaEligibleCount).toBe(4);      // excludes CWTTD
      expect(result.performance.slaCompliantCount).toBe(2);     // c1 + c3
      expect(result.performance.slaNonCompliantCount).toBe(2);  // c2 + c4
      expect(result.performance.closedWithoutTrustedDateCount).toBe(1);
      expect(result.performance.onTimeRate).toBe(50);

      // averageResolution: c3 = 6 days, c4 = 8 days → avg = 7
      expect(result.performance.averageResolutionEligibleCount).toBe(2);
      expect(result.performance.averageResolutionDays).toBe(7);
    });
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

  describe("parity: total from query = total in KPI result", () => {
    it("two-batch import scenario: total includes all records from both batches", async () => {
      // Simulates the real-world scenario: batch 39 (1190) + batch 40 (923) = 2113 total.
      // This test uses small fixture numbers to verify the parity invariant without
      // hardcoding 2113 in production code.
      const batch1 = Array.from({ length: 7 }, (_, i) =>
        complaint({ id: `b1_${i}`, status: ComplaintStatus.CLOSED, closedAt: null })
      );
      const batch2 = Array.from({ length: 5 }, (_, i) =>
        complaint({ id: `b2_${i}`, status: ComplaintStatus.CLOSED, closedAt: null })
      );
      dbMocks.findMany.mockResolvedValueOnce([...batch1, ...batch2]);

      const result = await getComplaintKpis(new URLSearchParams(), new Date("2026-07-31T00:00:00Z"));

      expect(result.volume.total).toBe(12);
      expect(result.volume.closed).toBe(12);
      expect(result.performance.closedWithoutTrustedDateCount).toBe(12);
      expect(result.performance.onTimeRate).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Backward-compatibility alias tests
  // ---------------------------------------------------------------------------

  describe("kpis backward-compatibility aliases", () => {
    it("dueDateComplianceRate equals slaComplianceRate", async () => {
      const createdAt = new Date("2026-07-01T00:00:00Z");
      const deadline = new Date(createdAt.getTime() + 7 * DAY_MS);
      dbMocks.findMany.mockResolvedValueOnce([
        complaint({ complaintDate: createdAt, status: ComplaintStatus.CLOSED, closedAt: deadline }),
        complaint({ id: "c2", complaintDate: createdAt, status: ComplaintStatus.OPEN }),
      ]);

      const result = await getComplaintKpis(
        new URLSearchParams(),
        new Date(createdAt.getTime() + 10 * DAY_MS)
      );

      expect(result.kpis.dueDateComplianceRate.currentValue).toBe(result.kpis.slaComplianceRate.currentValue);
      expect(result.kpis.dueDateComplianceRate.previousValue).toBe(result.kpis.slaComplianceRate.previousValue);
      expect(result.kpis.dueDateComplianceRate.available).toBe(result.kpis.slaComplianceRate.available);
    });

    it("closedWithinDueDate equals closedWithinSlaCount", async () => {
      const createdAt = new Date("2026-07-01T00:00:00Z");
      const beforeDeadline = new Date(createdAt.getTime() + 5 * DAY_MS);
      dbMocks.findMany.mockResolvedValueOnce([
        complaint({ complaintDate: createdAt, status: ComplaintStatus.CLOSED, closedAt: beforeDeadline }),
        complaint({ id: "c2", complaintDate: createdAt, status: ComplaintStatus.CLOSED, closedAt: null }),
      ]);

      const result = await getComplaintKpis(
        new URLSearchParams(),
        new Date(createdAt.getTime() + 10 * DAY_MS)
      );

      expect(result.kpis.closedWithinDueDate.currentValue).toBe(result.kpis.closedWithinSlaCount.currentValue);
      expect(result.kpis.closedWithinDueDate.direction).toBe(result.kpis.closedWithinSlaCount.direction);
    });

    it("withoutDueDate equals closedWithoutTrustedDateCount", async () => {
      dbMocks.findMany.mockResolvedValueOnce([
        complaint({ status: ComplaintStatus.CLOSED, closedAt: null }),
        complaint({ id: "c2", status: ComplaintStatus.CLOSED, closedAt: null }),
        complaint({ id: "c3", status: ComplaintStatus.CLOSED, closedAt: null }),
      ]);

      const result = await getComplaintKpis(new URLSearchParams(), new Date("2026-07-31T00:00:00Z"));

      expect(result.kpis.withoutDueDate.currentValue).toBe(result.kpis.closedWithoutTrustedDateCount.currentValue);
      expect(result.kpis.withoutDueDate.currentValue).toBe(3);
    });
  });
});
