// @vitest-environment node
//
// Unit tests for the executive brief data builder.
// All DB calls are mocked — no real SQLite instance required in CI.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  buildExecutiveBriefData,
  buildFullAnalyticalData,
  computeThirteenMonthWindow,
  computeMonthlyHistoryWindow,
  groupComplaintsByMonth,
  aggregateMonthlyComplaintTrend,
  resolveTrustedClosedAt,
  isComplaintAffectingMonthlyTrend,
  dedupeTrendComplaintsById,
  buildMonthlyTrendPrimaryWhere,
  buildTopClassifications,
  buildFacilitiesNeedingFollowUp,
  buildFacilitiesWithSustainedImprovement,
  buildClassificationTrendRows,
  buildRegionOnlyConclusions,
  MONTHLY_WINDOW_SIZE,
  ARABIC_MONTH_NAMES,
} from "./report-executive-brief-data-service";
import { ComplaintStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import type { ReportFilters } from "./report-definition-service";
import type { ComparisonResult, DeptClassPeriodCount, PeriodRange, RegionChangeRow } from "./report-comparison";
import type { ReportPeriodGroupSnapshot } from "./report-period-snapshot-service";
import type { ComplaintGroupMetrics, ComplaintKpiResult } from "@/server/complaints/complaint-kpi-service";
import type { AnalyticalFinding } from "@/lib/analytics/analytical-finding";
import {
  UNCLASSIFIED_CLASSIFICATION_KEY,
  UNCLASSIFIED_CLASSIFICATION_LABEL,
} from "@/lib/reports/classification-keys";
import { assertRegionalReconciliation } from "@/lib/reports/region-normalization";
import {
  sumClassificationOpenLate,
  sumRegionReferenceRows,
  reconcileClassificationOpenLate,
} from "./report-reconciliation";

// ---------------------------------------------------------------------------
// Hoist mocks so they are available before module imports are processed.
// ---------------------------------------------------------------------------

const dbMocks = vi.hoisted(() => ({
  complaintGroupBy: vi.fn(),
  complaintFindMany: vi.fn(),
  complaintFindFirst: vi.fn(),
  complaintCount: vi.fn(),
  facilityFindMany: vi.fn(),
  statusHistoryGroupBy: vi.fn(),
  statusHistoryCount: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    complaint: {
      groupBy: dbMocks.complaintGroupBy,
      findMany: dbMocks.complaintFindMany,
      findFirst: dbMocks.complaintFindFirst,
      count: dbMocks.complaintCount,
    },
    complaintStatusHistory: {
      groupBy: dbMocks.statusHistoryGroupBy,
      count: dbMocks.statusHistoryCount,
    },
    facility: {
      findMany: dbMocks.facilityFindMany,
    },
    $queryRaw: dbMocks.queryRaw,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no regions in the all-time list, no complaints in the DB.
  dbMocks.complaintGroupBy.mockResolvedValue([]);
  dbMocks.complaintFindMany.mockResolvedValue([]);
  dbMocks.complaintFindFirst.mockResolvedValue(null);
  dbMocks.complaintCount.mockResolvedValue(0);
  dbMocks.facilityFindMany.mockResolvedValue([]);
  dbMocks.statusHistoryGroupBy.mockResolvedValue([]);
  dbMocks.statusHistoryCount.mockResolvedValue(0);
  dbMocks.queryRaw.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ISO = (d: string) => new Date(`${d}T00:00:00.000Z`);

const BASE_FILTERS: ReportFilters = { from: "2026-07-01", to: "2026-07-07" };
const NOW = new Date("2026-07-08T00:00:00.000Z");

const CURRENT_PERIOD: PeriodRange = {
  from: ISO("2026-07-01"),
  toExclusive: ISO("2026-07-08"),
};

const PREVIOUS_PERIOD: PeriodRange = {
  from: ISO("2026-06-24"),
  toExclusive: ISO("2026-07-01"),
};

function makeKpiResult(overrides: Partial<ComplaintKpiResult> = {}): ComplaintKpiResult {
  const kpi = (current: number, previous?: number) => ({
    currentValue: current,
    previousValue: previous ?? null,
    absoluteChange: previous != null ? current - previous : null,
    percentageChange: previous != null && previous > 0 ? Math.round(((current - previous) / previous) * 100) : null,
    trend: "flat" as const,
    direction: "neutral" as const,
  });

  return {
    kpis: {
      totalComplaints: kpi(100, 80),
      openComplaints: kpi(30, 25),
      closedComplaints: kpi(65, 50),
      cancelledComplaints: kpi(5, 5),
      currentlyLateComplaints: kpi(8, 10),
      closedLateComplaints: kpi(3, 5),
      // Canonical SLA KPI fields
      slaComplianceRate: kpi(95.0, 90.0),
      closedWithinSlaCount: kpi(62, 45),
      closedWithoutTrustedDateCount: kpi(2, 3),
      unclassifiedComplaints: kpi(4, 6),
      highPriorityOpenComplaints: kpi(5, 8),
      averageResolutionDays: kpi(3.5, 4.0),
      medianResolutionDays: kpi(2.0, 2.5),
      averageOpenAgeDays: kpi(5.0, 6.0),
      closureRate: kpi(65.0, 62.5),
      reopenCount: kpi(2, 1),
      // Deprecated aliases (backward-compat boundary only)
      dueDateComplianceRate: kpi(95.0, 90.0),
      closedWithinDueDate: kpi(62, 45),
      withoutDueDate: kpi(2, 3),
    },
    volume: {
      total: 100,
      open: 30,
      inProgress: 5,
      closed: 65,
      reopened: 2,
      rejected: 0,
      late: 8,
      repeated: 3,
      validated: 90,
      notValidated: 10,
      potentialDuplicates: 1,
    },
    performance: {
      closureRate: 65.0,
      onTimeRate: 95.0,
      lateRate: 8.0,
      avgFirstResponseHours: 4.0,
      avgProcessingHours: 72.0,
      avgOpenAgeHours: 120.0,
      averageResolutionDays: 3.5,
      medianResolutionDays: 2.0,
      overdueNoAction: 2,
      overdueNoActionRate: 2.0,
      reopenRate: 2.0,
      validityRate: 90.0,
      avgSatisfaction: 4.2,
      satisfactionRate: 84.0,
      // Seven-day SLA fields
      slaEligibleCount: 62,
      slaCompliantCount: 59,
      slaNonCompliantCount: 3,
      openWithinSlaCount: 22,
      closedWithinSlaCount: 37,
      closedLateCount: 3,
      closedWithoutTrustedDateCount: 2,
      averageResolutionEligibleCount: 40,
      onTimeEligibleClosed: 62, // alias for slaEligibleCount
    },
    trend: {
      previousTotal: 80,
      growthRate: 25.0,
      trendData: [],
    },
    distributions: {
      byRegion: [
        { name: "الرياض", id: null, count: 40, total: 40, open: 10, closed: 28, currentlyLate: 3, closedLate: 1, withinDueDate: 27, complianceRate: 96.4, averageResolutionDays: 3.2, highPriorityOpen: 2, unclassified: 1, averageResolutionEligibleCount: 28, slaEligibleCount: 28, closedWithoutTrustedDateCount: 0 },
        { name: "جدة", id: null, count: 30, total: 30, open: 8, closed: 20, currentlyLate: 2, closedLate: 1, withinDueDate: 19, complianceRate: 95.0, averageResolutionDays: 3.5, highPriorityOpen: 1, unclassified: 0, averageResolutionEligibleCount: 19, slaEligibleCount: 19, closedWithoutTrustedDateCount: 0 },
        { name: "مكة", id: null, count: 20, total: 20, open: 7, closed: 12, currentlyLate: 2, closedLate: 1, withinDueDate: 11, complianceRate: 91.7, averageResolutionDays: 4.1, highPriorityOpen: 2, unclassified: 2, averageResolutionEligibleCount: 11, slaEligibleCount: 11, closedWithoutTrustedDateCount: 0 },
        { name: "المدينة", id: null, count: 10, total: 10, open: 5, closed: 5, currentlyLate: 1, closedLate: 0, withinDueDate: 5, complianceRate: 100.0, averageResolutionDays: 2.8, highPriorityOpen: 0, unclassified: 1, averageResolutionEligibleCount: 5, slaEligibleCount: 5, closedWithoutTrustedDateCount: 0 },
      ],
      byFacility: [],
      byDepartment: [
        { name: "الصحة", id: "dept-health", count: 45, total: 45, open: 12, closed: 31, currentlyLate: 4, closedLate: 2, withinDueDate: 29, complianceRate: 93.5, averageResolutionDays: 3.8, highPriorityOpen: 3, unclassified: 2, averageResolutionEligibleCount: 29, slaEligibleCount: 29, closedWithoutTrustedDateCount: 0 },
        { name: "التعليم", id: "dept-edu", count: 35, total: 35, open: 10, closed: 24, currentlyLate: 2, closedLate: 1, withinDueDate: 23, complianceRate: 95.8, averageResolutionDays: 3.2, highPriorityOpen: 1, unclassified: 1, averageResolutionEligibleCount: 23, slaEligibleCount: 23, closedWithoutTrustedDateCount: 0 },
        { name: "الخدمات", id: "dept-svc", count: 20, total: 20, open: 8, closed: 10, currentlyLate: 2, closedLate: 0, withinDueDate: 10, complianceRate: 100.0, averageResolutionDays: 2.9, highPriorityOpen: 1, unclassified: 1, averageResolutionEligibleCount: 10, slaEligibleCount: 10, closedWithoutTrustedDateCount: 0 },
      ],
      byClassification: [
        { name: "فئة اختبار / ضوضاء", id: "class-01", categoryId: "cat-1", categoryName: "فئة اختبار", classificationName: "ضوضاء", count: 30, total: 30, open: 8, closed: 20, currentlyLate: 3, closedLate: 1, withinDueDate: 19, complianceRate: 95.0, averageResolutionDays: 3.2, highPriorityOpen: 1, unclassified: 0, averageResolutionEligibleCount: 19, slaEligibleCount: 19, closedWithoutTrustedDateCount: 0 },
        { name: "فئة اختبار / بنية تحتية", id: "class-02", categoryId: "cat-1", categoryName: "فئة اختبار", classificationName: "بنية تحتية", count: 25, total: 25, open: 7, closed: 17, currentlyLate: 2, closedLate: 1, withinDueDate: 16, complianceRate: 94.1, averageResolutionDays: 3.8, highPriorityOpen: 2, unclassified: 1, averageResolutionEligibleCount: 16, slaEligibleCount: 16, closedWithoutTrustedDateCount: 0 },
        { name: "فئة اختبار / مخلفات", id: "class-03", categoryId: "cat-1", categoryName: "فئة اختبار", classificationName: "مخلفات", count: 20, total: 20, open: 5, closed: 13, currentlyLate: 1, closedLate: 0, withinDueDate: 13, complianceRate: 100.0, averageResolutionDays: 2.8, highPriorityOpen: 0, unclassified: 0, averageResolutionEligibleCount: 13, slaEligibleCount: 13, closedWithoutTrustedDateCount: 0 },
        { name: "فئة اختبار / مياه", id: "class-04", categoryId: "cat-1", categoryName: "فئة اختبار", classificationName: "مياه", count: 15, total: 15, open: 6, closed: 8, currentlyLate: 1, closedLate: 1, withinDueDate: 7, complianceRate: 87.5, averageResolutionDays: 4.5, highPriorityOpen: 2, unclassified: 1, averageResolutionEligibleCount: 7, slaEligibleCount: 7, closedWithoutTrustedDateCount: 0 },
        { name: "فئة اختبار / إضاءة", id: "class-05", categoryId: "cat-1", categoryName: "فئة اختبار", classificationName: "إضاءة", count: 10, total: 10, open: 4, closed: 7, currentlyLate: 1, closedLate: 0, withinDueDate: 7, complianceRate: 100.0, averageResolutionDays: 2.5, highPriorityOpen: 0, unclassified: 0, averageResolutionEligibleCount: 7, slaEligibleCount: 7, closedWithoutTrustedDateCount: 0 },
      ],
      byCategory: [],
      byChannel: [],
      byStatus: [],
      byPriority: [],
      bySeverity: [],
      byDelayReason: [],
      bySubject: [],
      byMonth: [],
    },
    crossTabs: {
      classificationByRegion: [],
      classificationByDepartment: [],
    },
    alerts: {
      criticalComplaints: 0,
      lateCritical: 0,
    },
    ...overrides,
  } as unknown as ComplaintKpiResult;
}

function makeComparison(hasPrevious = true): ComparisonResult {
  const allPairs: DeptClassPeriodCount[] = [
    {
      departmentId: "dept-health",
      departmentName: "الصحة",
      classificationId: "class-01",
      classificationName: "ضوضاء",
      classificationPath: "فئة اختبار / ضوضاء",
      currentCount: 15,
      previousCount: 10,
    },
  ];

  return {
    currentPeriod: CURRENT_PERIOD,
    previousPeriod: hasPrevious ? PREVIOUS_PERIOD : null,
    currentTotal: 100,
    previousTotal: hasPrevious ? 80 : null,
    regionTrend: {
      allDates: ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05", "2026-07-06", "2026-07-07"],
      series: [
        {
          regionName: "الرياض",
          points: [
            { date: "2026-07-01", count: 5 },
            { date: "2026-07-02", count: 6 },
            { date: "2026-07-03", count: 7 },
            { date: "2026-07-04", count: 4 },
            { date: "2026-07-05", count: 8 },
            { date: "2026-07-06", count: 5 },
            { date: "2026-07-07", count: 5 },
          ],
        },
        {
          regionName: "جدة",
          points: [
            { date: "2026-07-01", count: 4 },
            { date: "2026-07-02", count: 4 },
            { date: "2026-07-03", count: 4 },
            { date: "2026-07-04", count: 4 },
            { date: "2026-07-05", count: 5 },
            { date: "2026-07-06", count: 4 },
            { date: "2026-07-07", count: 5 },
          ],
        },
      ],
      truncated: false,
      otherSeriesName: null,
    },
    regionChanges: [
      { regionName: "الرياض", currentCount: 40, previousCount: 30, difference: 10, changeRate: 33.3, direction: "ارتفاع" },
      { regionName: "جدة", currentCount: 30, previousCount: 35, difference: -5, changeRate: -14.3, direction: "انخفاض" },
      { regionName: "مكة", currentCount: 20, previousCount: 10, difference: 10, changeRate: 100.0, direction: "ارتفاع" },
      { regionName: "المدينة", currentCount: 10, previousCount: 5, difference: 5, changeRate: 100.0, direction: "ارتفاع" },
    ],
    deptClassRises: [
      {
        departmentId: "dept-health",
        departmentName: "الصحة",
        classificationId: "class-01",
        classificationName: "ضوضاء",
      classificationPath: "فئة اختبار / ضوضاء",
        currentCount: 15,
        previousCount: 10,
        difference: 5,
        changeRate: 50.0,
        classificationContribution: 100.0,
      },
    ],
    deptClassRisesTotal: 1,
    deptClassAllPairs: allPairs,
    executiveSummaryPoints: [
      "استُقبلت خلال الفترة الحالية 100 شكوى.",
      "سجّلت الرياض أعلى ارتفاع.",
    ],
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Tests: CI — no DB schema required
// ---------------------------------------------------------------------------

describe("CI isolation", () => {
  it("buildExecutiveBriefData does not require a real DB schema", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison(false);
    // If the test completes without throwing P2021, the mock is working.
    await expect(buildExecutiveBriefData(BASE_FILTERS, result, comparison, undefined, NOW)).resolves.toBeDefined();
    expect(dbMocks.complaintGroupBy).toHaveBeenCalled();
  });

  it("buildFullAnalyticalData does not require a real DB schema", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison(false);
    await expect(buildFullAnalyticalData(BASE_FILTERS, result, comparison, undefined, NOW)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: buildBriefKpis (via buildExecutiveBriefData)
// ---------------------------------------------------------------------------

describe("buildExecutiveBriefData — KPI cards", () => {
  it("returns exactly 8 brief KPI cards", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    expect(data.briefKpis).toHaveLength(8);
  });

  it("KPI keys are unique", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    const keys = data.briefKpis.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("includes expected KPI keys", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    const keys = data.briefKpis.map((k) => k.key);
    expect(keys).toContain("total");
    expect(keys).toContain("open");
    expect(keys).toContain("closed");
    expect(keys).toContain("currentlyLate");
    expect(keys).toContain("complianceRate");
    expect(keys).toContain("averageResolutionDays");
    expect(keys).toContain("closedLate");
    expect(keys).toContain("netChange");
  });

  it("keeps the approved KPI presentation order", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    expect(data.briefKpis.map((kpi) => kpi.key)).toEqual([
      "total",
      "open",
      "closed",
      "currentlyLate",
      "closedLate",
      "complianceRate",
      "averageResolutionDays",
      "netChange",
    ]);
  });

  it("keeps compliance unavailable when slaEligibleCount is 0 (all complaints closed without trusted closedAt)", async () => {
    const result = makeKpiResult();
    result.performance.onTimeRate = null;
    result.performance.slaEligibleCount = 0;
    result.performance.slaCompliantCount = 0;
    result.performance.slaNonCompliantCount = 0;
    result.performance.closedWithoutTrustedDateCount = 65;
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, makeComparison(), undefined, NOW);
    expect(data.briefKpis.find((kpi) => kpi.key === "complianceRate")?.value).toBeNull();
  });

  it("closed KPI: fewer closed during the current period → negative assessment", async () => {
    // Closed once inside PREVIOUS_PERIOD only (closedDuringPeriod: current=0, previous=1).
    dbMocks.complaintFindMany.mockResolvedValue([
      {
        id: "c-closed-prev",
        status: ComplaintStatus.CLOSED,
        complaintDate: ISO("2026-06-01"),
        receivedAt: ISO("2026-06-01"),
        closedAt: ISO("2026-06-26"),
        sourceUpdatedAt: null,
        region: null,
        department: null,
        classificationId: null,
        statusHistory: [
          { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CLOSED, changedAt: ISO("2026-06-26") },
        ],
      },
    ]);
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    expect(data.periodMetrics?.current.closedDuringPeriod).toBe(0);
    expect(data.periodMetrics?.previous?.closedDuringPeriod).toBe(1);
    expect(data.briefKpis.find((k) => k.key === "closed")?.assessment).toBe("negative");
  });

  it("currentlyLate KPI: fewer late at current period end → positive assessment", async () => {
    // Old open complaint closed inside CURRENT_PERIOD, after PREVIOUS_PERIOD end:
    // late+open at previous.toExclusive, closed (not late) at current.toExclusive.
    dbMocks.complaintFindMany.mockResolvedValue([
      {
        id: "c-late-prev-only",
        status: ComplaintStatus.CLOSED,
        complaintDate: ISO("2026-01-01"),
        receivedAt: ISO("2026-01-01"),
        closedAt: ISO("2026-07-03"),
        sourceUpdatedAt: null,
        region: null,
        department: null,
        classificationId: null,
        statusHistory: [
          { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CLOSED, changedAt: ISO("2026-07-03") },
        ],
      },
    ]);
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    expect(data.periodMetrics?.current.lateAtEnd).toBe(0);
    expect(data.periodMetrics?.previous?.lateAtEnd).toBe(1);
    expect(data.briefKpis.find((k) => k.key === "currentlyLate")?.assessment).toBe("positive");
  });

  it("KPI cards have correct format fields", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    expect(data.briefKpis.find((k) => k.key === "complianceRate")?.format).toBe("percent");
    expect(data.briefKpis.find((k) => k.key === "averageResolutionDays")?.format).toBe("days");
  });

  it("difference and changeRate are null when no previous period", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(false), undefined, NOW);
    for (const card of data.briefKpis) {
      expect(card.previousValue).toBeNull();
      expect(card.difference).toBeNull();
      expect(card.changeRate).toBeNull();
    }
  });

  it("assessment is neutral when no previous period", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(false), undefined, NOW);
    for (const card of data.briefKpis) {
      expect(card.assessment).toBe("neutral");
    }
  });

  it("difference is computed correctly (current − previous)", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    // volume.total = 100, kpis.totalComplaints.previousValue = 80
    expect(data.briefKpis.find((k) => k.key === "total")?.difference).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Tests: all reference regions (Left Join)
// ---------------------------------------------------------------------------

describe("buildExecutiveBriefData — allRegions", () => {
  it("returns an array of region rows", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    expect(Array.isArray(data.allRegions)).toBe(true);
  });

  it("each row has required fields", async () => {
    // Return one region from the all-time groupBy mock.
    dbMocks.complaintGroupBy.mockResolvedValue([{ region: "الرياض" }]);
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    for (const row of data.allRegions) {
      expect(typeof row.regionName).toBe("string");
      expect(typeof row.currentCount).toBe("number");
      expect(typeof row.previousCount).toBe("number");
      expect(typeof row.difference).toBe("number");
      expect(typeof row.direction).toBe("string");
    }
  });

  it("difference = currentCount − previousCount", async () => {
    dbMocks.complaintGroupBy.mockResolvedValue([{ region: "الرياض" }, { region: "جدة" }]);
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    for (const row of data.allRegions) {
      expect(row.difference).toBe(row.currentCount - row.previousCount);
    }
  });

  it("keeps a positive difference for a region that increased", async () => {
    dbMocks.complaintGroupBy.mockResolvedValue([{ region: "الرياض" }]);
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    const riyadh = data.allRegions.find((row) => row.regionName === "منطقة الرياض");
    expect(riyadh).toBeDefined();
    expect(riyadh!.difference).toBeGreaterThan(0);
  });

  it("keeps a negative difference for a region that decreased", async () => {
    dbMocks.complaintGroupBy.mockResolvedValue([{ region: "جدة" }]);
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    const jeddah = data.allRegions.find((row) => row.regionName === "جدة");
    expect(jeddah).toBeDefined();
    expect(jeddah!.difference).toBeLessThan(0);
  });

  it("changeRate is null when previousCount is 0", async () => {
    dbMocks.complaintGroupBy.mockResolvedValue([{ region: "منطقة جديدة" }]);
    const comparison = makeComparison();
    comparison.regionChanges.push({
      regionName: "منطقة جديدة",
      currentCount: 5,
      previousCount: 0,
      difference: 5,
      changeRate: null,
      direction: "جديد",
    });
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    const newRegion = data.allRegions.find((r) => r.regionName === "منطقة جديدة");
    expect(newRegion).toBeDefined();
    expect(newRegion!.changeRate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: top classifications — categoryName removed from contract
// ---------------------------------------------------------------------------

describe("buildExecutiveBriefData — topClassifications", () => {
  it("returns at most 8 classification rows", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    expect(data.topClassifications.length).toBeLessThanOrEqual(8);
  });

  it("top classification has the highest count", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    if (data.topClassifications.length >= 2) {
      expect(data.topClassifications[0].currentCount).toBeGreaterThanOrEqual(data.topClassifications[1].currentCount);
    }
  });

  it("each row has classification path fields and ids", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    for (const row of data.topClassifications) {
      expect(typeof row.classificationId).toBe("string");
      expect(typeof row.classificationName).toBe("string");
      expect(typeof row.classificationPath).toBe("string");
      expect(row).toHaveProperty("categoryId");
      expect(row).toHaveProperty("categoryName");
      expect(typeof row.categoryName).toBe("string");
      expect(row.classificationPath).toContain(row.classificationName);
    }
  });

  it("shareOfTotal sums to approximately 100% or less", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    const totalShare = data.topClassifications.reduce((s, r) => s + r.shareOfTotal, 0);
    expect(totalShare).toBeLessThanOrEqual(100.1);
    expect(totalShare).toBeGreaterThan(0);
  });

  it("shareOfTotal is 0 when volume.total is 0", async () => {
    const result = makeKpiResult();
    (result.volume as { total: number }).total = 0;
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, makeComparison(), undefined, NOW);
    for (const row of data.topClassifications) {
      expect(row.shareOfTotal).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: comparative timeline
// ---------------------------------------------------------------------------

describe("buildExecutiveBriefData — comparativeTimeline", () => {
  it("returns current period points", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    expect(data.comparativeTimeline.current.points.length).toBeGreaterThan(0);
  });

  it("relative days start at 1", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    expect(data.comparativeTimeline.current.points[0].relativeDay).toBe(1);
  });

  it("always returns exactly 13 monthly points regardless of period length", async () => {
    // New implementation: buildComparativeTimeline always uses 13-month window
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    expect(data.comparativeTimeline.aggregation).toBe("monthly");
    expect(data.comparativeTimeline.current.points).toHaveLength(13);
  });

  it.each([
    { days: 7 },
    { days: 31 },
    { days: 56 },
    { days: 180 },
  ] as const)(
    "always uses monthly aggregation with 13 points for a $days-day period",
    async ({ days }) => {
      const comparison = makeComparison(false);
      comparison.currentPeriod = {
        from: ISO("2026-01-01"),
        toExclusive: new Date(ISO("2026-01-01").getTime() + days * 86_400_000),
      };
      comparison.regionTrend = {
        allDates: [],
        series: [],
        truncated: false,
        otherSeriesName: null,
      };
      const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
      expect(data.comparativeTimeline.aggregation).toBe("monthly");
      expect(data.comparativeTimeline.current.points).toHaveLength(13);
    }
  );

  it("previous period is null when no comparison", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(false), undefined, NOW);
    expect(data.comparativeTimeline.previous).toBeNull();
  });

  it("current counts reflect complaints returned by DB (not regionTrend)", async () => {
    // New implementation: fetchComplaintsForTimeline queries the DB directly.
    // Two complaints in July 2026 bucket (month 1 of window starting July 2026).
    dbMocks.complaintFindMany
      .mockResolvedValueOnce([
        { complaintDate: new Date("2026-07-02T00:00:00.000Z"), receivedAt: new Date("2026-07-02T00:00:00.000Z") },
        { complaintDate: new Date("2026-07-05T00:00:00.000Z"), receivedAt: new Date("2026-07-05T00:00:00.000Z") },
      ])
      .mockResolvedValueOnce([]); // previous period
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    // Bucket 1 = July 2026 → should have 2 complaints
    expect(data.comparativeTimeline.current.points[0].count).toBe(2);
    // All other months → 0
    for (let i = 1; i < data.comparativeTimeline.current.points.length; i++) {
      expect(data.comparativeTimeline.current.points[i].count).toBe(0);
    }
  });

  it("previous period queries DB with receivedAt fallback (null complaintDate)", async () => {
    // Current period: no complaints
    // Previous period: 2 complaints in June 2026 bucket (month 1 of previous window)
    dbMocks.complaintFindMany
      .mockResolvedValueOnce([])  // current period
      .mockResolvedValueOnce([   // previous period
        { complaintDate: new Date("2026-06-25T00:00:00.000Z"), receivedAt: new Date("2026-06-24T00:00:00.000Z") },
        { complaintDate: null, receivedAt: new Date("2026-06-26T00:00:00.000Z") },
      ]);
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    const prevPoints = data.comparativeTimeline.previous?.points ?? [];
    // Both complaints fall in June 2026 (month bucket 1 of the previous window)
    expect(prevPoints[0].count).toBe(2);
  });

  it("now is passed from caller — findMany is called for current period, previous period, snapshot candidates, and the pattern-analysis window", async () => {
    // buildComparativeTimeline calls findMany twice (current + previous period);
    // the period-snapshot service adds one more fixed call (snapshot candidates);
    // the pattern-analysis engine adds its own single windowed call.
    await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    expect(dbMocks.complaintFindMany).toHaveBeenCalledTimes(4);
  });

  it("complaintDate present but outside period is not counted by receivedAt", async () => {
    // Effective-date policy: complaintDate takes precedence — this complaint must NOT be counted.
    // Service relies on Prisma OR clause — our mock returns only what Prisma would return.
    // We verify that the mock was called with the OR clause for the current period.
    await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    // findMany called 4 times: current period timeline, previous period timeline, snapshot candidates, pattern-analysis window.
    expect(dbMocks.complaintFindMany).toHaveBeenCalledTimes(4);
    // Verify the WHERE passed to first findMany (current period) includes the OR clause.
    const [[callArg]] = dbMocks.complaintFindMany.mock.calls;
    expect(callArg.where).toHaveProperty("OR");
    const orClauses: unknown[] = callArg.where.OR;
    // First clause: complaintDate in range.
    expect(orClauses[0]).toMatchObject({ complaintDate: { gte: expect.any(Date), lt: expect.any(Date) } });
    // Second clause: complaintDate null + receivedAt in range.
    expect(orClauses[1]).toMatchObject({ complaintDate: null, receivedAt: { gte: expect.any(Date), lt: expect.any(Date) } });
  });
});

// ---------------------------------------------------------------------------
// Tests: concentration bands
// ---------------------------------------------------------------------------

describe("buildExecutiveBriefData — concentrationBands", () => {
  it("returns exactly 3 concentration bands", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    expect(data.concentrationBands).toHaveLength(3);
  });

  it("includes all 3 entity types", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    const types = data.concentrationBands.map((b) => b.entityType);
    expect(types).toContain("region");
    expect(types).toContain("classification");
    expect(types).toContain("department");
  });

  it("top1Share <= top3Share <= top5Share", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    for (const band of data.concentrationBands) {
      expect(band.top1SharePercent).toBeLessThanOrEqual(band.top3SharePercent);
      expect(band.top3SharePercent).toBeLessThanOrEqual(band.top5SharePercent);
    }
  });

  it("shares are between 0 and 100", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    for (const band of data.concentrationBands) {
      expect(band.top1SharePercent).toBeGreaterThanOrEqual(0);
      expect(band.top5SharePercent).toBeLessThanOrEqual(100);
    }
  });

  it("all shares are 0 when total is 0", async () => {
    const result = makeKpiResult();
    (result.volume as { total: number }).total = 0;
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, makeComparison(), undefined, NOW);
    for (const band of data.concentrationBands) {
      expect(band.top1SharePercent).toBe(0);
      expect(band.top3SharePercent).toBe(0);
      expect(band.top5SharePercent).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: buildFullAnalyticalData
// ---------------------------------------------------------------------------

describe("buildFullAnalyticalData — structure", () => {
  it("includes all brief data fields", async () => {
    const data = await buildFullAnalyticalData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    expect(data.briefKpis).toBeDefined();
    expect(data.allRegions).toBeDefined();
    expect(data.topClassifications).toBeDefined();
    expect(data.comparativeTimeline).toBeDefined();
    expect(data.concentrationBands).toBeDefined();
  });

  it("includes FULL_ANALYTICAL-only fields", async () => {
    const data = await buildFullAnalyticalData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    expect(data.netBacklogFlow).toBeDefined();
    expect(data.perfVolumeRows).toBeDefined();
    expect(data.continuityRows).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: net backlog flow
// ---------------------------------------------------------------------------

describe("buildFullAnalyticalData — netBacklogFlow", () => {
  it("net = inflow - outflow", async () => {
    dbMocks.complaintCount.mockResolvedValue(25);
    dbMocks.statusHistoryGroupBy.mockResolvedValue(new Array(10).fill({ complaintId: "x" }));
    const data = await buildFullAnalyticalData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    expect(data.netBacklogFlow.inflow).toBe(25);
    expect(data.netBacklogFlow.outflow).toBe(10);
    expect(data.netBacklogFlow.net).toBe(15);
  });

  it("inflow count uses effective-date OR clause", async () => {
    await buildFullAnalyticalData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    const [[callArg]] = dbMocks.complaintCount.mock.calls;
    expect(callArg.where).toHaveProperty("OR");
    const orClauses: unknown[] = callArg.where.OR;
    expect(orClauses[0]).toMatchObject({ complaintDate: { gte: expect.any(Date), lt: expect.any(Date) } });
    expect(orClauses[1]).toMatchObject({ complaintDate: null, receivedAt: { gte: expect.any(Date), lt: expect.any(Date) } });
  });

  it("inflow excludes isDeleted complaints", async () => {
    await buildFullAnalyticalData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    const [[callArg]] = dbMocks.complaintCount.mock.calls;
    expect(callArg.where.isDeleted).toBe(false);
  });

  it("uses the number of returned complaint groups as outflow", async () => {
    // Prisma groupBy returns one row per distinct complaint, so outflow equals
    // the number of returned complaint groups.
    dbMocks.statusHistoryGroupBy.mockResolvedValue([
      { complaintId: "c-001" },
      { complaintId: "c-002" },
    ]);
    const data = await buildFullAnalyticalData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    expect(data.netBacklogFlow.outflow).toBe(2);
    expect(dbMocks.statusHistoryGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["complaintId"],
        where: expect.objectContaining({
          toStatus: { in: ["CLOSED", "RESOLVED"] },
          changedAt: {
            gte: CURRENT_PERIOD.from,
            lt: CURRENT_PERIOD.toExclusive,
          },
          complaint: {
            is: expect.objectContaining({ isDeleted: false }),
          },
        }),
      })
    );
  });

  it("outflow uses changedAt for the date range, not complaintDate", async () => {
    await buildFullAnalyticalData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    const [[callArg]] = dbMocks.statusHistoryGroupBy.mock.calls;
    expect(callArg.where.changedAt).toMatchObject({
      gte: expect.any(Date),
      lt: expect.any(Date),
    });
    // complaintDate should not appear on the top-level status-history where.
    expect(callArg.where).not.toHaveProperty("complaintDate");
  });

  it("outflow excludes deleted complaints via complaint.is filter", async () => {
    await buildFullAnalyticalData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    const [[callArg]] = dbMocks.statusHistoryGroupBy.mock.calls;
    expect(callArg.where.complaint?.is?.isDeleted).toBe(false);
  });

  it("outflow only counts CLOSED or RESOLVED transitions", async () => {
    await buildFullAnalyticalData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    const [[callArg]] = dbMocks.statusHistoryGroupBy.mock.calls;
    expect(callArg.where.toStatus).toMatchObject({ in: expect.arrayContaining(["CLOSED", "RESOLVED"]) });
  });
});

// ---------------------------------------------------------------------------
// Tests: performance vs volume
// ---------------------------------------------------------------------------

describe("buildFullAnalyticalData — perfVolumeRows", () => {
  it("is sorted by totalComplaints descending (uses unordered input)", async () => {
    const result = makeKpiResult();
    // Deliberately unordered: 3 → 10 → 6 (should come out as 10, 6, 3).
    (result.distributions as { byDepartment: unknown[] }).byDepartment = [
      { name: "إدارة ب", id: "d2", count: 3, total: 3, open: 0, closed: 3, currentlyLate: 0, closedLate: 0, withinDueDate: 3, complianceRate: 100, averageResolutionDays: 1, highPriorityOpen: 0, unclassified: 0 },
      { name: "إدارة أ", id: "d1", count: 10, total: 10, open: 2, closed: 8, currentlyLate: 1, closedLate: 0, withinDueDate: 8, complianceRate: 100, averageResolutionDays: 2, highPriorityOpen: 1, unclassified: 0 },
      { name: "إدارة ج", id: "d3", count: 6, total: 6, open: 1, closed: 5, currentlyLate: 0, closedLate: 0, withinDueDate: 5, complianceRate: 100, averageResolutionDays: 1.5, highPriorityOpen: 0, unclassified: 0 },
    ];
    const data = await buildFullAnalyticalData(BASE_FILTERS, result, makeComparison(), undefined, NOW);
    const totals = data.perfVolumeRows.map((r) => r.totalComplaints);
    expect(totals).toEqual([10, 6, 3]);
  });

  it("share sums to approximately 100%", async () => {
    const data = await buildFullAnalyticalData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    const total = data.perfVolumeRows.reduce((s, r) => s + r.share, 0);
    if (data.perfVolumeRows.length > 0) {
      expect(total).toBeGreaterThan(0);
      expect(total).toBeLessThanOrEqual(100.5);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: continuity analysis
// ---------------------------------------------------------------------------

describe("buildFullAnalyticalData — continuityRows", () => {
  it("returns no continuity rows when the comparison period is unavailable", async () => {
    const comparison = makeComparison(false);
    comparison.deptClassAllPairs = [
      { departmentId: "d1", departmentName: "الصحة", classificationId: "c1", classificationName: "ضوضاء",
      classificationPath: "فئة اختبار / ضوضاء", currentCount: 5, previousCount: 0 },
      { departmentId: "d2", departmentName: "التعليم", classificationId: "c2", classificationName: "مخلفات",
      classificationPath: "فئة اختبار / مخلفات", currentCount: 3, previousCount: 0 },
    ];

    const data = await buildFullAnalyticalData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);

    expect(data.continuityRows).toEqual([]);
    expect(data.continuityRows).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recurrenceType: expect.stringMatching(/new|persistent|resolved/) }),
      ])
    );
  });

  it("persistent: both periods > 0", async () => {
    const comparison = makeComparison();
    comparison.deptClassAllPairs = [
      { departmentId: "d1", departmentName: "الصحة", classificationId: "c1", classificationName: "ضوضاء",
      classificationPath: "فئة اختبار / ضوضاء", currentCount: 10, previousCount: 8 },
    ];
    const data = await buildFullAnalyticalData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    expect(data.continuityRows).toHaveLength(1);
    expect(data.continuityRows[0].recurrenceType).toBe("persistent");
    expect(data.continuityRows[0].appearsInBothPeriods).toBe(true);
  });

  it("new: only in current period", async () => {
    const comparison = makeComparison();
    comparison.deptClassAllPairs = [
      { departmentId: "d1", departmentName: "الصحة", classificationId: "c1", classificationName: "ضوضاء",
      classificationPath: "فئة اختبار / ضوضاء", currentCount: 5, previousCount: 0 },
    ];
    const data = await buildFullAnalyticalData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    expect(data.continuityRows[0].recurrenceType).toBe("new");
    expect(data.continuityRows[0].appearsInBothPeriods).toBe(false);
  });

  it("resolved: only in previous period", async () => {
    const comparison = makeComparison();
    comparison.deptClassAllPairs = [
      { departmentId: "d1", departmentName: "الصحة", classificationId: "c1", classificationName: "ضوضاء",
      classificationPath: "فئة اختبار / ضوضاء", currentCount: 0, previousCount: 7 },
    ];
    const data = await buildFullAnalyticalData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    expect(data.continuityRows[0].recurrenceType).toBe("resolved");
    expect(data.continuityRows[0].appearsInBothPeriods).toBe(false);
  });

  it("skips pairs where both counts are 0", async () => {
    const comparison = makeComparison();
    comparison.deptClassAllPairs = [
      { departmentId: "d1", departmentName: "الصحة", classificationId: "c1", classificationName: "ضوضاء",
      classificationPath: "فئة اختبار / ضوضاء", currentCount: 0, previousCount: 0 },
    ];
    const data = await buildFullAnalyticalData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    expect(data.continuityRows).toHaveLength(0);
  });

  it("uses deptClassAllPairs not just deptClassRises", async () => {
    // deptClassRises only has rising pairs.
    // deptClassAllPairs contains a resolved pair not present in rises.
    const comparison = makeComparison();
    comparison.deptClassRises = [];
    comparison.deptClassAllPairs = [
      { departmentId: "d1", departmentName: "الصحة", classificationId: "c1", classificationName: "ضوضاء",
      classificationPath: "فئة اختبار / ضوضاء", currentCount: 0, previousCount: 5 },
    ];
    const data = await buildFullAnalyticalData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    expect(data.continuityRows).toHaveLength(1);
    expect(data.continuityRows[0].recurrenceType).toBe("resolved");
  });

  it("no absent rows are produced", async () => {
    const comparison = makeComparison();
    comparison.deptClassAllPairs = [
      { departmentId: "d1", departmentName: "الصحة", classificationId: "c1", classificationName: "ضوضاء",
      classificationPath: "فئة اختبار / ضوضاء", currentCount: 5, previousCount: 3 },
      { departmentId: "d1", departmentName: "الصحة", classificationId: "c2", classificationName: "مياه",
      classificationPath: "فئة اختبار / مياه", currentCount: 0, previousCount: 2 },
      { departmentId: "d2", departmentName: "التعليم", classificationId: "c3", classificationName: "بنية تحتية",
      classificationPath: "فئة اختبار / بنية تحتية", currentCount: 3, previousCount: 0 },
    ];
    const data = await buildFullAnalyticalData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    for (const row of data.continuityRows) {
      expect(row.recurrenceType).not.toBe("absent");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: buildExecutiveBriefData — previous timeline OR fallback
// ---------------------------------------------------------------------------

describe("buildExecutiveBriefData — previous timeline OR fallback", () => {
  it("includes complaints where complaintDate=null and receivedAt falls in previous period", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    // New: buildComparativeTimeline calls findMany twice (current then previous).
    // First call: current period (July 2026 window) → no complaints.
    // Second call: previous period (June 2026 window) → one complaint in June.
    dbMocks.complaintFindMany
      .mockResolvedValueOnce([])  // current period
      .mockResolvedValueOnce([   // previous period
        { complaintDate: null, receivedAt: new Date("2026-06-25T00:00:00.000Z") },
      ]);
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    expect(data.comparativeTimeline.previous).not.toBeNull();
    // Previous period starts June 2026 → bucket 1 (relativeDay=1) covers all of June.
    // 2026-06-25 falls in June 2026 → relativeDay === 1, count === 1.
    const june = data.comparativeTimeline.previous?.points.find((p) => p.relativeDay === 1);
    expect(june?.count).toBe(1);
  });

  it("does not count a complaint with complaintDate outside period even if receivedAt is inside", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    // Return a complaint where complaintDate is outside previous period
    // (The OR filter in production code should NOT return this from the DB query,
    //  so we simulate what the DB would actually return with correct filters)
    dbMocks.complaintFindMany.mockResolvedValueOnce([]);
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    const total = data.comparativeTimeline.previous?.points.reduce((s, p) => s + p.count, 0) ?? 0;
    expect(total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: buildFullAnalyticalData — net backlog flow filters
// ---------------------------------------------------------------------------

describe("buildFullAnalyticalData — net backlog flow filters", () => {
  it("inflow uses receivedAt when complaintDate is null", async () => {
    dbMocks.complaintCount.mockResolvedValue(5);
    dbMocks.statusHistoryGroupBy.mockResolvedValue([
      { complaintId: "complaint-1" },
      { complaintId: "complaint-2" },
    ]);
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildFullAnalyticalData(BASE_FILTERS, result, comparison);
    expect(data.netBacklogFlow.inflow).toBe(5);
  });

  it("net = inflow - outflow", async () => {
    dbMocks.complaintCount.mockResolvedValue(10);
    dbMocks.statusHistoryGroupBy.mockResolvedValue([
      { complaintId: "complaint-1" },
      { complaintId: "complaint-2" },
      { complaintId: "complaint-3" },
      { complaintId: "complaint-4" },
    ]);
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildFullAnalyticalData(BASE_FILTERS, result, comparison);
    expect(data.netBacklogFlow.net).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Tests: monthly timeline points carry Arabic month labels
// ---------------------------------------------------------------------------

describe("buildExecutiveBriefData — monthly timeline labels", () => {
  it("monthly points carry Arabic month name labels", async () => {
    const comparison = makeComparison(false);
    // 180-day period → monthly aggregation
    const start = ISO("2026-01-01");
    comparison.currentPeriod = {
      from: start,
      toExclusive: new Date(start.getTime() + 180 * 86_400_000),
    };
    comparison.regionTrend = { allDates: [], series: [], truncated: false, otherSeriesName: null };
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    expect(data.comparativeTimeline.aggregation).toBe("monthly");
    const labels = data.comparativeTimeline.current.points.map((p) => p.label).filter(Boolean);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels[0]).toContain("يناير");
    expect(labels[1]).toContain("فبراير");
  });

  it("all timeline points carry an Arabic month label (monthly aggregation always)", async () => {
    // New: buildComparativeTimeline always uses monthly aggregation → all points have labels
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(false), undefined, NOW);
    expect(data.comparativeTimeline.aggregation).toBe("monthly");
    for (const point of data.comparativeTimeline.current.points) {
      expect(typeof point.label).toBe("string");
      expect((point.label ?? "").length).toBeGreaterThan(0);
    }
  });

  it("monthly labels include the year", async () => {
    const comparison = makeComparison(false);
    const start = ISO("2025-11-01");
    comparison.currentPeriod = {
      from: start,
      toExclusive: new Date(start.getTime() + 180 * 86_400_000),
    };
    comparison.regionTrend = { allDates: [], series: [], truncated: false, otherSeriesName: null };
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    const labels = data.comparativeTimeline.current.points.map((p) => p.label).filter(Boolean) as string[];
    expect(labels.some((label) => label.includes("2025"))).toBe(true);
    expect(labels.some((label) => label.includes("2026"))).toBe(true);
  });

  it("allRegions: changeRate is null and direction is 'جديد' when previousCount=0 and currentCount>0", async () => {
    dbMocks.complaintGroupBy.mockResolvedValue([{ region: "منطقة جديدة" }]);
    const comparison = makeComparison();
    comparison.regionChanges.push({
      regionName: "منطقة جديدة",
      currentCount: 7,
      previousCount: 0,
      difference: 7,
      changeRate: null,
      direction: "جديد",
    });
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    const row = data.allRegions.find((r) => r.regionName === "منطقة جديدة");
    expect(row).toBeDefined();
    expect(row!.changeRate).toBeNull();
    expect(row!.direction).toBe("جديد");
    expect(row!.currentCount).toBe(7);
    expect(row!.previousCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: computeThirteenMonthWindow
// ---------------------------------------------------------------------------

describe("computeThirteenMonthWindow", () => {
  it("returns exactly 13 months", () => {
    const period = { from: new Date("2025-08-01T00:00:00.000Z"), toExclusive: new Date("2026-08-02T00:00:00.000Z") };
    expect(computeThirteenMonthWindow(period)).toHaveLength(MONTHLY_WINDOW_SIZE);
    expect(MONTHLY_WINDOW_SIZE).toBe(13);
  });

  it("months are in ascending order by monthKey", () => {
    const period = { from: new Date("2025-08-01T00:00:00.000Z"), toExclusive: new Date("2026-08-02T00:00:00.000Z") };
    const buckets = computeThirteenMonthWindow(period);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].key > buckets[i - 1].key).toBe(true);
    }
  });

  it("starts at the month of period.from", () => {
    const period = { from: new Date("2025-08-03T00:00:00.000Z"), toExclusive: new Date("2026-08-02T00:00:00.000Z") };
    const buckets = computeThirteenMonthWindow(period);
    expect(buckets[0].key).toBe("2025-08");
  });

  it("spans the year boundary correctly", () => {
    const period = { from: new Date("2025-11-01T00:00:00.000Z"), toExclusive: new Date("2026-11-01T00:00:00.000Z") };
    const buckets = computeThirteenMonthWindow(period);
    expect(buckets[0].key).toBe("2025-11");
    expect(buckets[2].key).toBe("2026-01");
    expect(buckets[12].key).toBe("2026-11");
  });

  it("bucket labels use Arabic month names and include the year", () => {
    const period = { from: new Date("2026-01-01T00:00:00.000Z"), toExclusive: new Date("2027-01-01T00:00:00.000Z") };
    const buckets = computeThirteenMonthWindow(period);
    expect(buckets[0].label).toBe(`${ARABIC_MONTH_NAMES[0]} 2026`);  // يناير 2026
    expect(buckets[11].label).toBe(`${ARABIC_MONTH_NAMES[11]} 2026`); // ديسمبر 2026
  });

  it("each bucket from is 1st of the month at midnight UTC", () => {
    const period = { from: new Date("2025-08-03T00:00:00.000Z"), toExclusive: new Date("2026-08-02T00:00:00.000Z") };
    const buckets = computeThirteenMonthWindow(period);
    for (const b of buckets) {
      expect(b.from.getUTCDate()).toBe(1);
      expect(b.from.getUTCHours()).toBe(0);
    }
  });

  it("consecutive bucket.from and previous bucket.toExclusive are equal", () => {
    const period = { from: new Date("2025-08-01T00:00:00.000Z"), toExclusive: new Date("2026-08-01T00:00:00.000Z") };
    const buckets = computeThirteenMonthWindow(period);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].from.getTime()).toBe(buckets[i - 1].toExclusive.getTime());
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: groupComplaintsByMonth
// ---------------------------------------------------------------------------

describe("groupComplaintsByMonth", () => {
  function bucket(key: string) {
    const [y, m] = key.split("-").map(Number);
    return {
      key,
      label: `${ARABIC_MONTH_NAMES[m - 1]} ${y}`,
      from: new Date(Date.UTC(y, m - 1, 1)),
      toExclusive: new Date(Date.UTC(y, m, 1)),
    };
  }

  it("initialises all buckets to zero for complaints with no matching dates", () => {
    const buckets = [bucket("2026-01"), bucket("2026-02"), bucket("2026-03")];
    const result = groupComplaintsByMonth([], buckets);
    for (const b of buckets) {
      expect(result.get(b.key)).toBe(0);
    }
  });

  it("uses complaintDate when available", () => {
    const buckets = [bucket("2026-03")];
    const complaints = [
      { complaintDate: new Date("2026-03-15T00:00:00.000Z"), receivedAt: new Date("2026-01-01T00:00:00.000Z") },
    ];
    const result = groupComplaintsByMonth(complaints, buckets);
    expect(result.get("2026-03")).toBe(1);
  });

  it("falls back to receivedAt when complaintDate is null", () => {
    const buckets = [bucket("2026-04")];
    const complaints = [
      { complaintDate: null, receivedAt: new Date("2026-04-10T00:00:00.000Z") },
    ];
    const result = groupComplaintsByMonth(complaints, buckets);
    expect(result.get("2026-04")).toBe(1);
  });

  it("does not count a complaint outside the window", () => {
    const buckets = [bucket("2026-03")];
    const complaints = [
      { complaintDate: new Date("2026-05-01T00:00:00.000Z"), receivedAt: new Date("2026-05-01T00:00:00.000Z") },
    ];
    const result = groupComplaintsByMonth(complaints, buckets);
    expect(result.get("2026-03")).toBe(0);
  });

  it("sum of all bucket counts equals number of complaints falling in window", () => {
    const buckets = [bucket("2026-01"), bucket("2026-02"), bucket("2026-03")];
    const complaints = [
      { complaintDate: new Date("2026-01-05T00:00:00.000Z"), receivedAt: new Date("2026-01-01T00:00:00.000Z") },
      { complaintDate: new Date("2026-02-10T00:00:00.000Z"), receivedAt: new Date("2026-01-01T00:00:00.000Z") },
      { complaintDate: null, receivedAt: new Date("2026-02-20T00:00:00.000Z") },
      { complaintDate: new Date("2026-04-01T00:00:00.000Z"), receivedAt: new Date("2026-04-01T00:00:00.000Z") }, // outside window
    ];
    const result = groupComplaintsByMonth(complaints, buckets);
    const total = [...result.values()].reduce((s, v) => s + v, 0);
    expect(total).toBe(3); // only 3 fall within the 3 buckets
  });

  it("multiple complaints in same bucket are summed", () => {
    const buckets = [bucket("2026-06")];
    const complaints = [
      { complaintDate: new Date("2026-06-01T00:00:00.000Z"), receivedAt: new Date("2026-06-01T00:00:00.000Z") },
      { complaintDate: new Date("2026-06-15T00:00:00.000Z"), receivedAt: new Date("2026-06-15T00:00:00.000Z") },
      { complaintDate: null, receivedAt: new Date("2026-06-20T00:00:00.000Z") },
    ];
    const result = groupComplaintsByMonth(complaints, buckets);
    expect(result.get("2026-06")).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Tests: 13-month window — integration with buildExecutiveBriefData monthly mode
// ---------------------------------------------------------------------------

describe("13-month window via buildExecutiveBriefData", () => {
  it("monthly mode returns exactly 13 timeline points", async () => {
    const comparison = makeComparison(false);
    // A ~13-month period triggers monthly aggregation in buildComparativeTimeline
    comparison.currentPeriod = {
      from: new Date("2025-08-03T00:00:00.000Z"),
      toExclusive: new Date("2026-08-02T00:00:00.000Z"),
    };
    comparison.regionTrend = { allDates: [], series: [], truncated: false, otherSeriesName: null };
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    // buildComparativeTimeline is called when period is long enough for monthly
    // The new 13-month window path sets aggregation = "monthly"
    expect(data.comparativeTimeline.aggregation).toBe("monthly");
    expect(data.comparativeTimeline.current.points).toHaveLength(13);
  });

  it("monthly points are in ascending order", async () => {
    const comparison = makeComparison(false);
    comparison.currentPeriod = {
      from: new Date("2025-08-03T00:00:00.000Z"),
      toExclusive: new Date("2026-08-02T00:00:00.000Z"),
    };
    comparison.regionTrend = { allDates: [], series: [], truncated: false, otherSeriesName: null };
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    const points = data.comparativeTimeline.current.points;
    for (let i = 1; i < points.length; i++) {
      expect(points[i].relativeDay).toBeGreaterThan(points[i - 1].relativeDay);
    }
  });

  it("empty months (no complaints) have count 0 not undefined", async () => {
    dbMocks.complaintFindMany.mockResolvedValue([]); // no complaints at all
    const comparison = makeComparison(false);
    comparison.currentPeriod = {
      from: new Date("2025-08-03T00:00:00.000Z"),
      toExclusive: new Date("2026-08-02T00:00:00.000Z"),
    };
    comparison.regionTrend = { allDates: [], series: [], truncated: false, otherSeriesName: null };
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    for (const point of data.comparativeTimeline.current.points) {
      expect(point.count).toBe(0);
    }
  });

  it("monthly sum equals total complaints returned by DB for that period", async () => {
    // DB returns 5 complaints, all in Jan 2026
    // (also consumed by the period-snapshot query, which needs status/statusHistory to resolve state).
    dbMocks.complaintFindMany.mockResolvedValue([
      { complaintDate: new Date("2026-01-05T00:00:00.000Z"), receivedAt: new Date("2026-01-05T00:00:00.000Z"), status: ComplaintStatus.OPEN, closedAt: null, sourceUpdatedAt: null, statusHistory: [] },
      { complaintDate: new Date("2026-01-10T00:00:00.000Z"), receivedAt: new Date("2026-01-10T00:00:00.000Z"), status: ComplaintStatus.OPEN, closedAt: null, sourceUpdatedAt: null, statusHistory: [] },
      { complaintDate: null, receivedAt: new Date("2026-01-15T00:00:00.000Z"), status: ComplaintStatus.OPEN, closedAt: null, sourceUpdatedAt: null, statusHistory: [] },
      { complaintDate: new Date("2026-01-20T00:00:00.000Z"), receivedAt: new Date("2026-01-20T00:00:00.000Z"), status: ComplaintStatus.OPEN, closedAt: null, sourceUpdatedAt: null, statusHistory: [] },
      { complaintDate: new Date("2026-01-25T00:00:00.000Z"), receivedAt: new Date("2026-01-25T00:00:00.000Z"), status: ComplaintStatus.OPEN, closedAt: null, sourceUpdatedAt: null, statusHistory: [] },
    ]);
    const comparison = makeComparison(false);
    comparison.currentPeriod = {
      from: new Date("2025-08-03T00:00:00.000Z"),
      toExclusive: new Date("2026-08-02T00:00:00.000Z"),
    };
    comparison.regionTrend = { allDates: [], series: [], truncated: false, otherSeriesName: null };
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    const total = data.comparativeTimeline.current.points.reduce((s, p) => s + p.count, 0);
    expect(total).toBe(5);
  });

  it("previous period timeline also returns 13 points in monthly mode", async () => {
    // First call: current period complaints; second call: previous period complaints
    dbMocks.complaintFindMany
      .mockResolvedValueOnce([])  // current period: no complaints
      .mockResolvedValueOnce([]); // previous period: no complaints
    const comparison = makeComparison(true);
    comparison.currentPeriod = {
      from: new Date("2025-08-03T00:00:00.000Z"),
      toExclusive: new Date("2026-08-02T00:00:00.000Z"),
    };
    comparison.previousPeriod = {
      from: new Date("2024-08-03T00:00:00.000Z"),
      toExclusive: new Date("2025-08-03T00:00:00.000Z"),
    };
    comparison.regionTrend = { allDates: [], series: [], truncated: false, otherSeriesName: null };
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    expect(data.comparativeTimeline.previous?.points).toHaveLength(13);
  });
});

// ---------------------------------------------------------------------------
// Tests: buildExecutiveBriefData — conclusions and notes with zero previous period
// ---------------------------------------------------------------------------

describe("buildExecutiveBriefData — conclusions/notes with zero previous data", () => {
  it("does not generate comparative rise/fall conclusions when previousTotal is 0", async () => {
    // previousTotal = 0 means the previous period was queried and returned zero
    // complaints (e.g. import-date issue). hasMeaningfulPreviousData must return
    // false → no comparative rise/fall conclusions.
    const comparison = makeComparison(true);
    comparison.previousTotal = 0;
    comparison.regionChanges = comparison.regionChanges.map((r) => ({
      ...r, previousCount: 0, difference: r.currentCount, changeRate: null,
    }));
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    const conclusions = data.conclusions ?? [];
    for (const c of conclusions) {
      expect(c).not.toContain("أعلى زيادة");
      expect(c).not.toContain("أعلى انخفاض");
    }
  });

  it("adds a data-quality note when previousTotal is 0 (previous period had no complaints)", async () => {
    // previousTotal = 0: a valid period was queried but returned zero results.
    const comparison = makeComparison(true);
    comparison.previousTotal = 0;
    comparison.regionChanges = comparison.regionChanges.map((r) => ({
      ...r, previousCount: 0, difference: r.currentCount, changeRate: null,
    }));
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    const hasZeroNote = (data.notes ?? []).some(
      (n) => n.includes("صفرية") || n.includes("استيراد") || n.includes("غياب تاريخ")
    );
    expect(hasZeroNote).toBe(true);
  });

  it("does not add zero-data note when previousTotal > 0", async () => {
    // makeComparison(true) has previousTotal: 80 — meaningful previous data.
    const comparison = makeComparison(true);
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    const hasZeroNote = (data.notes ?? []).some((n) => n.includes("صفرية"));
    expect(hasZeroNote).toBe(false);
  });

  it("generates comparative conclusions when previousTotal > 0 even if regionChanges has zero previous counts", async () => {
    // Root cause of the original bug: complaints existed in the previous period
    // but had no region, so regionChanges.reduce sum was 0 even though
    // previousTotal > 0. The fix uses previousTotal exclusively.
    const comparison = makeComparison(true);
    // previousTotal = 50: previous period had real data, but complaints had no region.
    comparison.previousTotal = 50;
    // regionChanges has no previous counts (all complaints had null region).
    comparison.regionChanges = comparison.regionChanges.map((r) => ({
      ...r, previousCount: 0, difference: r.currentCount, changeRate: null,
    }));
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    const noZeroNote = !(data.notes ?? []).some((n) => n.includes("صفرية"));
    // The zero-data note must NOT appear because hasMeaningfulPreviousData returns true.
    expect(noZeroNote).toBe(true);
  });

  it("adds no-previous-period note when previousPeriod is null", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(false), undefined, NOW);
    const hasNote = (data.notes ?? []).some((n) => n.includes("لا تتوفر فترة سابقة"));
    expect(hasNote).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: seven-day SLA integration with buildExecutiveBriefData
// ---------------------------------------------------------------------------

describe("buildExecutiveBriefData — seven-day SLA notes and KPIs", () => {
  it("SLA note is always the first note regardless of other conditions", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    expect((data.notes ?? []).length).toBeGreaterThan(0);
    expect((data.notes ?? [])[0]).toContain("7 أيام");
  });

  it("CWTTD note appears when closedWithoutTrustedDateCount > 0", async () => {
    const result = makeKpiResult();
    result.performance.closedWithoutTrustedDateCount = 10;
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, makeComparison(), undefined, NOW);
    const notes = data.notes ?? [];
    const hasCwttdNote = notes.some((n) => n.includes("بلا تاريخ إغلاق") || n.includes("موثوق"));
    expect(hasCwttdNote).toBe(true);
  });

  it("CWTTD note is absent when closedWithoutTrustedDateCount is 0", async () => {
    const result = makeKpiResult();
    result.performance.closedWithoutTrustedDateCount = 0;
    result.performance.onTimeRate = 95.0;
    result.performance.slaEligibleCount = 62;
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, makeComparison(), undefined, NOW);
    const notes = data.notes ?? [];
    const hasCwttdNote = notes.some((n) => n.includes("بلا تاريخ إغلاق") || n.includes("موثوق"));
    expect(hasCwttdNote).toBe(false);
  });

  it("insufficient-data note appears when onTimeRate is null and closedWithoutTrustedDateCount is 0", async () => {
    const result = makeKpiResult();
    result.performance.onTimeRate = null;
    result.performance.slaEligibleCount = 0;
    result.performance.closedWithoutTrustedDateCount = 0;
    result.performance.closedWithinSlaCount = 0;
    result.performance.closedLateCount = 0;
    result.performance.openWithinSlaCount = 0;
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, makeComparison(), undefined, NOW);
    const notes = data.notes ?? [];
    const hasInsufficientNote = notes.some((n) => n.includes("بيانات") || n.includes("قياس"));
    expect(hasInsufficientNote).toBe(true);
  });

  it("averageResolutionDays KPI value is null when averageResolutionEligibleCount is 0", async () => {
    const result = makeKpiResult();
    result.performance.averageResolutionEligibleCount = 0;
    result.performance.averageResolutionDays = null as unknown as number;
    result.kpis.averageResolutionDays.available = false;
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, makeComparison(), undefined, NOW);
    expect(data.briefKpis.find((k) => k.key === "averageResolutionDays")?.value).toBeNull();
  });

  it("averageResolutionDays KPI value is 0 when same-day closure (averageResolutionEligibleCount > 0)", async () => {
    const result = makeKpiResult();
    result.performance.averageResolutionDays = 0;
    result.performance.averageResolutionEligibleCount = 5;
    result.kpis.averageResolutionDays.currentValue = 0;
    result.kpis.averageResolutionDays.available = true;
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, makeComparison(), undefined, NOW);
    expect(data.briefKpis.find((k) => k.key === "averageResolutionDays")?.value).toBe(0);
  });

  it("allRegions table averageResolutionDays shows null for groups where averageResolutionEligibleCount is 0", async () => {
    const result = makeKpiResult();
    // Override byRegion distributions to have a group with no eligible count
    (result.distributions as { byRegion: unknown[] }).byRegion = [
      {
        name: "الرياض", id: null, count: 5, total: 5,
        open: 3, closed: 2, currentlyLate: 0, closedLate: 0,
        withinDueDate: 0, complianceRate: null, averageResolutionDays: 0,
        highPriorityOpen: 0, unclassified: 0,
        averageResolutionEligibleCount: 0, // no eligible → should show null
      },
    ];
    dbMocks.complaintGroupBy.mockResolvedValue([{ region: "الرياض" }]);
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, makeComparison(), undefined, NOW);
    // The allRegions table row for الرياض should not show an average when eligibleCount = 0
    const row = data.allRegions.find((r) => r.regionName.includes("الرياض"));
    expect(row).toBeDefined();
    // averageResolutionDays in the allRegions row should be null (no eligible)
    expect(row!.averageResolutionDays).toBeNull();
  });

  it("previousComplianceRate uses slaEligibleCount from previous result to gate availability", async () => {
    // Previous result has slaEligibleCount = 0 → previous complianceRate previousValue must be null
    const result = makeKpiResult();
    const previousResult = makeKpiResult();
    previousResult.performance.slaEligibleCount = 0;
    previousResult.performance.onTimeRate = null;
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, makeComparison(), previousResult, NOW);
    const complianceCard = data.briefKpis.find((k) => k.key === "complianceRate");
    expect(complianceCard?.previousValue).toBeNull();
  });

  it("notes array has at most 4 entries", async () => {
    const result = makeKpiResult();
    result.performance.closedWithoutTrustedDateCount = 10;
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, makeComparison(), undefined, NOW);
    expect((data.notes ?? []).length).toBeLessThanOrEqual(4);
  });

  it("closed KPI label uses updated Arabic text (current period)", async () => {
    const data = await buildExecutiveBriefData(
      BASE_FILTERS,
      makeKpiResult(),
      makeComparison(),
      undefined,
      NOW
    );
    const closedCard = data.briefKpis.find((k) => k.key === "closed");

    expect(closedCard?.label).toBe(
      "المغلقة خلال الفترة"
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: buildFullAnalyticalData — continuity rows
// ---------------------------------------------------------------------------

describe("buildFullAnalyticalData — continuity rows", () => {
  it("produces persistent when dept+class appears in both periods", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    comparison.deptClassAllPairs = [{
      departmentId: "dept-a", departmentName: "الصحة",
      classificationId: "class-01", classificationName: "ضوضاء",
      classificationPath: "فئة اختبار / ضوضاء",
      currentCount: 10, previousCount: 8,
    }];
    const data = await buildFullAnalyticalData(BASE_FILTERS, result, comparison);
    const row = data.continuityRows.find((r) => r.departmentName === "الصحة" && r.classificationName === "ضوضاء");
    expect(row?.recurrenceType).toBe("persistent");
  });

  it("produces new when dept+class has no previous count", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    comparison.deptClassAllPairs = [{
      departmentId: "dept-b", departmentName: "التعليم",
      classificationId: "class-02", classificationName: "مخلفات",
      classificationPath: "فئة اختبار / مخلفات",
      currentCount: 5, previousCount: 0,
    }];
    const data = await buildFullAnalyticalData(BASE_FILTERS, result, comparison);
    const row = data.continuityRows.find((r) => r.departmentName === "التعليم");
    expect(row?.recurrenceType).toBe("new");
  });
});

// ---------------------------------------------------------------------------
// Tests: computeMonthlyHistoryWindow (backward-looking)
// ---------------------------------------------------------------------------

describe("computeMonthlyHistoryWindow", () => {
  it("returns Aug 2025–Aug 2026 = 13 months when data is older than the window", () => {
    const buckets = computeMonthlyHistoryWindow({
      reportEnd: new Date("2026-08-04T12:00:00.000Z"),
      earliestAvailableDate: new Date("2024-01-01T00:00:00.000Z"),
      maxMonths: 13,
    });
    expect(buckets).toHaveLength(13);
    expect(buckets[0].key).toBe("2025-08");
    expect(buckets[12].key).toBe("2026-08");
  });

  it("starts at November 2025 when earliest data is Nov 2025", () => {
    const buckets = computeMonthlyHistoryWindow({
      reportEnd: new Date("2026-08-04T12:00:00.000Z"),
      earliestAvailableDate: new Date("2025-11-28T00:00:00.000Z"),
      maxMonths: 13,
    });
    expect(buckets[0].key).toBe("2025-11");
    expect(buckets.at(-1)?.key).toBe("2026-08");
    expect(buckets).toHaveLength(10);
  });

  it("never creates a month after report end month", () => {
    const buckets = computeMonthlyHistoryWindow({
      reportEnd: new Date("2026-08-04T12:00:00.000Z"),
      earliestAvailableDate: new Date("2026-07-05T00:00:00.000Z"),
      maxMonths: 13,
    });
    expect(buckets.map((b) => b.key)).toEqual(["2026-07", "2026-08"]);
    for (const b of buckets) {
      expect(b.key <= "2026-08").toBe(true);
    }
  });

  it("uses toExclusive − 1ms semantics for reportEndMonth", () => {
    // Period ends exclusive on Sep 1 → last included day is Aug 31
    const buckets = computeMonthlyHistoryWindow({
      reportEnd: new Date(new Date("2026-09-01T00:00:00.000Z").getTime() - 1),
      earliestAvailableDate: new Date("2025-01-01T00:00:00.000Z"),
      maxMonths: 13,
    });
    expect(buckets.at(-1)?.key).toBe("2026-08");
  });
});

// ---------------------------------------------------------------------------
// Tests: aggregateMonthlyComplaintTrend series definitions
// ---------------------------------------------------------------------------

describe("aggregateMonthlyComplaintTrend", () => {
  const buckets = computeMonthlyHistoryWindow({
    reportEnd: new Date("2026-08-15T00:00:00.000Z"),
    earliestAvailableDate: new Date("2026-07-01T00:00:00.000Z"),
    maxMonths: 13,
  });

  const OPEN = ComplaintStatus.OPEN;
  const CLOSED = ComplaintStatus.CLOSED;

  function trend(partial: {
    complaintDate: Date | null;
    receivedAt: Date;
    closedAt: Date | null;
    status?: ComplaintStatus;
    lastUpdatedAt?: Date | null;
    statusHistory?: Array<{ fromStatus: ComplaintStatus | null; toStatus: ComplaintStatus; changedAt: Date }>;
  }) {
    return {
      status: partial.status ?? OPEN,
      complaintDate: partial.complaintDate,
      receivedAt: partial.receivedAt,
      closedAt: partial.closedAt,
      lastUpdatedAt: partial.lastUpdatedAt ?? null,
      statusHistory: partial.statusHistory ?? [],
    };
  }

  it("receivedCount uses complaintDate ?? receivedAt", () => {
    const points = aggregateMonthlyComplaintTrend(
      [
        trend({
          complaintDate: new Date("2026-07-10T00:00:00.000Z"),
          receivedAt: new Date("2026-01-01T00:00:00.000Z"),
          closedAt: null,
        }),
        trend({
          complaintDate: null,
          receivedAt: new Date("2026-08-02T00:00:00.000Z"),
          closedAt: null,
        }),
      ],
      buckets
    );
    expect(points.find((p) => p.monthKey === "2026-07")?.receivedCount).toBe(1);
    expect(points.find((p) => p.monthKey === "2026-08")?.receivedCount).toBe(1);
  });

  it("closedDuringMonthCount requires a trusted closedAt", () => {
    const created = new Date("2026-07-01T00:00:00.000Z");
    const points = aggregateMonthlyComplaintTrend(
      [
        trend({
          status: CLOSED,
          complaintDate: created,
          receivedAt: created,
          closedAt: new Date("2026-07-05T00:00:00.000Z"),
        }),
        trend({
          status: CLOSED,
          complaintDate: created,
          receivedAt: created,
          closedAt: new Date("2026-06-01T00:00:00.000Z"),
        }),
        trend({ status: CLOSED, complaintDate: created, receivedAt: created, closedAt: null }),
      ],
      buckets
    );
    expect(points.find((p) => p.monthKey === "2026-07")?.closedDuringMonthCount).toBe(1);
  });

  it("uses lastUpdatedAt as closedDuringMonth when closedAt is missing", () => {
    const created = new Date("2026-07-01T00:00:00.000Z");
    const points = aggregateMonthlyComplaintTrend(
      [
        trend({
          status: CLOSED,
          complaintDate: created,
          receivedAt: created,
          closedAt: null,
          lastUpdatedAt: new Date("2026-07-08T00:00:00.000Z"),
        }),
      ],
      buckets
    );
    expect(points.find((p) => p.monthKey === "2026-07")?.closedDuringMonthCount).toBe(1);
    expect(points.find((p) => p.monthKey === "2026-07")?.openAtMonthEndCount).toBe(0);
  });

  it("closedDuringMonthCount prefers a genuine StatusHistory transition over closedAt (spec section 15)", () => {
    const created = new Date("2026-07-01T00:00:00.000Z");
    const points = aggregateMonthlyComplaintTrend(
      [
        trend({
          status: CLOSED,
          complaintDate: created,
          receivedAt: created,
          // closedAt suggests August, but the real transition happened in July.
          closedAt: new Date("2026-08-05T00:00:00.000Z"),
          statusHistory: [
            { fromStatus: OPEN, toStatus: CLOSED, changedAt: new Date("2026-07-20T00:00:00.000Z") },
          ],
        }),
      ],
      buckets
    );
    expect(points.find((p) => p.monthKey === "2026-07")?.closedDuringMonthCount).toBe(1);
    expect(points.find((p) => p.monthKey === "2026-08")?.closedDuringMonthCount).toBe(0);
  });

  it("regression: a bulk-import creation record (fromStatus: null) does not misdate closedDuringMonthCount to the import month", () => {
    // Same real dev.db shape as the period-snapshot regression test: the only
    // StatusHistory row is a creation record with fromStatus: null and
    // changedAt = import processing time, not the real closure date.
    const created = new Date("2026-07-01T00:00:00.000Z");
    const points = aggregateMonthlyComplaintTrend(
      [
        trend({
          status: CLOSED,
          complaintDate: created,
          receivedAt: created,
          closedAt: new Date("2026-07-05T00:00:00.000Z"),
          statusHistory: [
            { fromStatus: null, toStatus: CLOSED, changedAt: new Date("2026-08-06T12:00:00.000Z") },
          ],
        }),
      ],
      buckets
    );
    // Falls back to closedAt (July), not the import month (August).
    expect(points.find((p) => p.monthKey === "2026-07")?.closedDuringMonthCount).toBe(1);
    expect(points.find((p) => p.monthKey === "2026-08")?.closedDuringMonthCount).toBe(0);
  });

  it("openAtMonthEndCount rebuilds historic balance", () => {
    const created = new Date("2026-07-01T00:00:00.000Z");
    const points = aggregateMonthlyComplaintTrend(
      [
        trend({
          status: CLOSED,
          complaintDate: created,
          receivedAt: created,
          closedAt: new Date("2026-08-10T00:00:00.000Z"),
        }),
      ],
      buckets
    );
    expect(points.find((p) => p.monthKey === "2026-07")?.openAtMonthEndCount).toBe(1);
    expect(points.find((p) => p.monthKey === "2026-08")?.openAtMonthEndCount).toBe(0);
  });

  it("lateAtMonthEndCount uses a 7-day deadline; exact boundary is not late", () => {
    const created = new Date("2026-07-01T00:00:00.000Z");
    const exact7 = new Date("2026-07-25T00:00:00.000Z");
    const lateOne = new Date("2026-07-20T00:00:00.000Z");

    const points = aggregateMonthlyComplaintTrend(
      [
        trend({ complaintDate: exact7, receivedAt: exact7, closedAt: null }),
        trend({ complaintDate: lateOne, receivedAt: lateOne, closedAt: null }),
        trend({ complaintDate: created, receivedAt: created, closedAt: null }),
      ],
      buckets
    );
    const july = points.find((p) => p.monthKey === "2026-07")!;
    expect(july.openAtMonthEndCount).toBe(3);
    expect(july.lateAtMonthEndCount).toBe(2);
  });

  it("keeps zero months inside the window", () => {
    const points = aggregateMonthlyComplaintTrend(
      [
        trend({
          complaintDate: new Date("2026-07-05T00:00:00.000Z"),
          receivedAt: new Date("2026-07-05T00:00:00.000Z"),
          closedAt: null,
        }),
      ],
      buckets
    );
    const aug = points.find((p) => p.monthKey === "2026-08");
    expect(aug).toBeDefined();
    expect(aug!.receivedCount).toBe(0);
  });

  describe("partial-month clamp (spec section 16, reference report 2026-07-26 → 2026-08-02)", () => {
    // reportToExclusive = 2026-08-03T00:00:00.000Z (day after 2026-08-02).
    const reportEndExclusive = new Date("2026-08-03T00:00:00.000Z");
    const partialBuckets = computeMonthlyHistoryWindow({
      reportEnd: new Date(reportEndExclusive.getTime() - 1),
      earliestAvailableDate: new Date("2026-07-01T00:00:00.000Z"),
      maxMonths: 13,
    });

    it("does not count a complaint registered after 2026-08-02 in the August bucket", () => {
      const points = aggregateMonthlyComplaintTrend(
        [
          trend({
            complaintDate: new Date("2026-08-05T00:00:00.000Z"),
            receivedAt: new Date("2026-08-05T00:00:00.000Z"),
            closedAt: null,
          }),
        ],
        partialBuckets,
        { reportEndExclusive }
      );
      expect(points.find((p) => p.monthKey === "2026-08")?.receivedCount).toBe(0);
    });

    it("does not count a complaint closed after 2026-08-02 in the August bucket", () => {
      const created = new Date("2026-07-01T00:00:00.000Z");
      const points = aggregateMonthlyComplaintTrend(
        [trend({ status: CLOSED, complaintDate: created, receivedAt: created, closedAt: new Date("2026-08-10T00:00:00.000Z") })],
        partialBuckets,
        { reportEndExclusive }
      );
      expect(points.find((p) => p.monthKey === "2026-08")?.closedDuringMonthCount).toBe(0);
    });

    it("does not count lateness that only occurs after 2026-08-02 in the August bucket", () => {
      // Created on 2026-07-27, so the seven-day SLA deadline is exactly
      // 2026-08-03T00:00:00Z. Because lateness uses a strict `>` comparison,
      // the complaint is open but not late at the report-end boundary.
      const created = new Date("2026-07-27T00:00:00.000Z"); // deadline 2026-08-03 (exclusive boundary, not late)
      const points = aggregateMonthlyComplaintTrend(
        [trend({ complaintDate: created, receivedAt: created, closedAt: null })],
        partialBuckets,
        { reportEndExclusive }
      );
      const aug = points.find((p) => p.monthKey === "2026-08")!;
      expect(aug.openAtMonthEndCount).toBe(1);
      expect(aug.lateAtMonthEndCount).toBe(0);
    });

    it("does not change earlier, already-complete buckets", () => {
      const points = aggregateMonthlyComplaintTrend(
        [
          trend({
            complaintDate: new Date("2026-07-05T00:00:00.000Z"),
            receivedAt: new Date("2026-07-05T00:00:00.000Z"),
            closedAt: null,
          }),
        ],
        partialBuckets,
        { reportEndExclusive }
      );
      expect(points.find((p) => p.monthKey === "2026-07")?.receivedCount).toBe(1);
    });

    it("without reportEndExclusive, falls back to the natural full-month boundary", () => {
      const points = aggregateMonthlyComplaintTrend(
        [
          trend({
            complaintDate: new Date("2026-08-05T00:00:00.000Z"),
            receivedAt: new Date("2026-08-05T00:00:00.000Z"),
            closedAt: null,
          }),
        ],
        partialBuckets
      );
      expect(points.find((p) => p.monthKey === "2026-08")?.receivedCount).toBe(1);
    });
  });

  it("resolveTrustedClosedAt rejects dates before creation without lastUpdatedAt", () => {
    expect(
      resolveTrustedClosedAt({
        status: CLOSED,
        complaintDate: new Date("2026-07-10T00:00:00.000Z"),
        receivedAt: new Date("2026-07-10T00:00:00.000Z"),
        closedAt: new Date("2026-07-01T00:00:00.000Z"),
        lastUpdatedAt: null,
        statusHistory: [],
      })
    ).toBeNull();
  });

  it("empty month buckets yield empty trend", () => {
    expect(aggregateMonthlyComplaintTrend([], [])).toEqual([]);
  });
});

describe("isComplaintAffectingMonthlyTrend — candidate filter", () => {
  const windowFrom = new Date("2025-08-01T00:00:00.000Z");
  const windowToExclusive = new Date("2026-09-01T00:00:00.000Z");
  const OPEN = ComplaintStatus.OPEN;
  const CLOSED = ComplaintStatus.CLOSED;

  function row(partial: {
    complaintDate: Date | null;
    receivedAt: Date;
    closedAt: Date | null;
    status?: ComplaintStatus;
    lastUpdatedAt?: Date | null;
    id?: string;
  }) {
    return {
      id: partial.id,
      status: partial.status ?? OPEN,
      complaintDate: partial.complaintDate,
      receivedAt: partial.receivedAt,
      closedAt: partial.closedAt,
      lastUpdatedAt: partial.lastUpdatedAt ?? null,
      statusHistory: [],
    };
  }

  it("excludes created-and-closed fully before windowFrom", () => {
    expect(
      isComplaintAffectingMonthlyTrend(
        row({
          status: CLOSED,
          complaintDate: new Date("2024-01-01T00:00:00.000Z"),
          receivedAt: new Date("2024-01-01T00:00:00.000Z"),
          closedAt: new Date("2024-02-01T00:00:00.000Z"),
        }),
        windowFrom,
        windowToExclusive
      )
    ).toBe(false);
  });

  it("includes open carry-in (created before window, closedAt null)", () => {
    expect(
      isComplaintAffectingMonthlyTrend(
        row({
          complaintDate: new Date("2024-06-01T00:00:00.000Z"),
          receivedAt: new Date("2024-06-01T00:00:00.000Z"),
          closedAt: null,
        }),
        windowFrom,
        windowToExclusive
      )
    ).toBe(true);
  });

  it("includes closed inside the window with creation before window", () => {
    expect(
      isComplaintAffectingMonthlyTrend(
        row({
          status: CLOSED,
          complaintDate: new Date("2024-06-01T00:00:00.000Z"),
          receivedAt: new Date("2024-06-01T00:00:00.000Z"),
          closedAt: new Date("2025-09-15T00:00:00.000Z"),
        }),
        windowFrom,
        windowToExclusive
      )
    ).toBe(true);
  });

  it("includes created inside the window", () => {
    expect(
      isComplaintAffectingMonthlyTrend(
        row({
          complaintDate: new Date("2026-01-10T00:00:00.000Z"),
          receivedAt: new Date("2026-01-10T00:00:00.000Z"),
          closedAt: null,
        }),
        windowFrom,
        windowToExclusive
      )
    ).toBe(true);
  });

  it("excludes created at/after windowToExclusive", () => {
    expect(
      isComplaintAffectingMonthlyTrend(
        row({
          complaintDate: new Date("2026-09-01T00:00:00.000Z"),
          receivedAt: new Date("2026-09-01T00:00:00.000Z"),
          closedAt: null,
        }),
        windowFrom,
        windowToExclusive
      )
    ).toBe(false);
  });

  it("keeps untrusted closedAt (closed before create) as affecting open stock", () => {
    expect(
      isComplaintAffectingMonthlyTrend(
        row({
          status: CLOSED,
          complaintDate: new Date("2024-01-15T00:00:00.000Z"),
          receivedAt: new Date("2024-01-15T00:00:00.000Z"),
          closedAt: new Date("2023-12-01T00:00:00.000Z"),
        }),
        windowFrom,
        windowToExclusive
      )
    ).toBe(true);
  });

  it("does not grow kept set with old trusted-closed history", () => {
    const pool = Array.from({ length: 500 }, (_, i) =>
      row({
        id: `old-${i}`,
        status: CLOSED,
        complaintDate: new Date("2020-01-01T00:00:00.000Z"),
        receivedAt: new Date("2020-01-01T00:00:00.000Z"),
        closedAt: new Date("2020-02-01T00:00:00.000Z"),
      })
    );
    pool.push(
      row({
        id: "open-carry",
        complaintDate: new Date("2024-01-01T00:00:00.000Z"),
        receivedAt: new Date("2024-01-01T00:00:00.000Z"),
        closedAt: null,
      }),
      row({
        id: "in-window",
        complaintDate: new Date("2026-01-05T00:00:00.000Z"),
        receivedAt: new Date("2026-01-05T00:00:00.000Z"),
        closedAt: null,
      }),
      row({
        id: "close-in-window",
        status: CLOSED,
        complaintDate: new Date("2024-03-01T00:00:00.000Z"),
        receivedAt: new Date("2024-03-01T00:00:00.000Z"),
        closedAt: new Date("2025-10-01T00:00:00.000Z"),
      })
    );
    const kept = pool.filter((c) =>
      isComplaintAffectingMonthlyTrend(c, windowFrom, windowToExclusive)
    );
    expect(kept).toHaveLength(3);
    expect(kept.map((c) => c.id).sort()).toEqual([
      "close-in-window",
      "in-window",
      "open-carry",
    ]);
  });

  it("dedupeTrendComplaintsById uses id uniquely", () => {
    const rows = dedupeTrendComplaintsById([
      {
        id: "a",
        status: OPEN,
        complaintDate: null,
        receivedAt: new Date("2026-01-01T00:00:00.000Z"),
        closedAt: null,
        lastUpdatedAt: null,
        statusHistory: [],
      },
      {
        id: "a",
        status: OPEN,
        complaintDate: new Date("2026-01-02T00:00:00.000Z"),
        receivedAt: new Date("2026-01-01T00:00:00.000Z"),
        closedAt: null,
        lastUpdatedAt: null,
        statusHistory: [],
      },
      {
        id: "b",
        status: OPEN,
        complaintDate: null,
        receivedAt: new Date("2026-01-03T00:00:00.000Z"),
        closedAt: null,
        lastUpdatedAt: null,
        statusHistory: [],
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === "a")?.complaintDate?.toISOString()).toContain("2026-01-02");
  });

  it("primary where includes a lower time bound and non-date base filters", () => {
    const departmentPredicate = { department: "d1" };
    const where = buildMonthlyTrendPrimaryWhere(
      {
        isDeleted: false,
        region: "منطقة الرياض",
        AND: [departmentPredicate],
      },
      windowFrom,
      windowToExclusive
    );
    expect(where).toMatchObject({
      isDeleted: false,
      region: "منطقة الرياض",
    });
    expect(Array.isArray(where.AND)).toBe(true);
    const andPredicates = where.AND as Prisma.ComplaintWhereInput[];
    expect(andPredicates).toContainEqual(departmentPredicate);
    expect(andPredicates).toContainEqual({
      OR: [
        { complaintDate: { lt: windowToExclusive } },
        { complaintDate: null, receivedAt: { lt: windowToExclusive } },
      ],
    });
    expect(andPredicates).toContainEqual({
      OR: [
        { complaintDate: { gte: windowFrom } },
        { complaintDate: null, receivedAt: { gte: windowFrom } },
        { closedAt: null },
        { closedAt: { gte: windowFrom } },
        { sourceUpdatedAt: { gte: windowFrom } },
      ],
    });
  });
});

describe("MonthlyComplaintTrendPoint contract (no MonthlyStockFlowPoint alias)", () => {
  it("alias MonthlyStockFlowPoint is gone from source surface", () => {
    const contract = fs.readFileSync(
      path.join(process.cwd(), "src/lib/reports/report-contract.ts"),
      "utf8"
    );
    const dataService = fs.readFileSync(
      path.join(process.cwd(), "src/server/reports/report-data-service.ts"),
      "utf8"
    );
    expect(contract).not.toMatch(/MonthlyStockFlowPoint/);
    expect(dataService).not.toMatch(/MonthlyStockFlowPoint/);
    expect(contract).toContain("MonthlyComplaintTrendPoint");
    expect(dataService).toContain("monthlyStockFlow: MonthlyComplaintTrendPoint[]");
  });
});

describe("buildExecutiveBriefData — periodMetrics and snapshot contract (spec sections 10-14)", () => {
  function snapshotRow(overrides: Partial<{
    id: string;
    status: ComplaintStatus;
    complaintDate: Date | null;
    receivedAt: Date;
    closedAt: Date | null;
    sourceUpdatedAt: Date | null;
    region: string | null;
    department: string | null;
    classificationId: string | null;
    statusHistory: Array<{ fromStatus: ComplaintStatus | null; toStatus: ComplaintStatus; changedAt: Date }>;
  }> & { id: string }) {
    return {
      status: ComplaintStatus.OPEN,
      complaintDate: null,
      receivedAt: ISO("2026-06-01"),
      closedAt: null,
      sourceUpdatedAt: null,
      region: null,
      department: null,
      classificationId: null,
      statusHistory: [],
      ...overrides,
    };
  }

  it("exposes periodMetrics.current and periodMetrics.previous with the four snapshot indicators", async () => {
    dbMocks.complaintFindMany.mockResolvedValue([
      snapshotRow({ id: "p1", complaintDate: ISO("2026-06-25") }), // received during CURRENT_PERIOD
    ]);
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    expect(data.periodMetrics).toBeDefined();
    expect(data.periodMetrics!.current).toMatchObject({
      receivedDuringPeriod: expect.any(Number),
      closedDuringPeriod: expect.any(Number),
      openAtEnd: expect.any(Number),
      lateAtEnd: expect.any(Number),
    });
    expect(data.periodMetrics!.previous).not.toBeNull();
  });

  it("periodMetrics.previous is null when there is no comparison period", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(false), undefined, NOW);
    expect(data.periodMetrics!.previous).toBeNull();
  });

  it("a CANCELLED complaint with no closure transition is never counted as open at period end (regression: 12-vs-11 drift)", async () => {
    dbMocks.complaintFindMany.mockResolvedValue([
      snapshotRow({
        id: "cancelled-1",
        status: ComplaintStatus.CANCELLED,
        complaintDate: ISO("2026-06-01"),
        classificationId: "cls-x",
      }),
    ]);
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    expect(data.periodMetrics!.current.openAtEnd).toBe(0);
    expect(data.periodMetrics!.current.lateAtEnd).toBe(0);
    const classificationRow = (data.classificationSnapshotAtEnd ?? []).find((r) => r.classificationId === "cls-x");
    expect(classificationRow?.openAtEnd ?? 0).toBe(0);
  });

  it("classificationSnapshotAtEnd covers every bucket, and its openAtEnd/lateAtEnd sums equal the overall snapshot", async () => {
    dbMocks.complaintFindMany.mockResolvedValue([
      snapshotRow({ id: "k1", complaintDate: ISO("2026-01-01"), classificationId: "cls-a" }),
      snapshotRow({ id: "k2", complaintDate: ISO("2026-01-01"), classificationId: "cls-b" }),
      snapshotRow({ id: "k3", complaintDate: ISO("2026-01-01"), classificationId: null }),
      snapshotRow({
        id: "k4",
        status: ComplaintStatus.CANCELLED,
        complaintDate: ISO("2026-01-01"),
        classificationId: "cls-a",
      }),
    ]);
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    const rows = data.classificationSnapshotAtEnd ?? [];
    // 3 buckets: cls-a, cls-b, unclassified — the cancelled complaint does not create a 4th.
    expect(rows).toHaveLength(3);
    const sumOpen = rows.reduce((s, r) => s + r.openAtEnd, 0);
    const sumLate = rows.reduce((s, r) => s + r.lateAtEnd, 0);
    expect(sumOpen).toBe(data.periodMetrics!.current.openAtEnd);
    expect(sumLate).toBe(data.periodMetrics!.current.lateAtEnd);
  });

  it("regionSnapshotAtEnd openAtEnd/lateAtEnd sums equal the overall current snapshot", async () => {
    dbMocks.complaintFindMany.mockResolvedValue([
      snapshotRow({ id: "g1", complaintDate: ISO("2026-01-01"), region: "الرياض" }),
      snapshotRow({ id: "g2", complaintDate: ISO("2026-01-01"), region: null }),
    ]);
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    const rows = data.regionSnapshotAtEnd ?? [];
    const sumOpen = rows.reduce((s, r) => s + r.openAtEnd, 0);
    const sumLate = rows.reduce((s, r) => s + r.lateAtEnd, 0);
    expect(sumOpen).toBe(data.periodMetrics!.current.openAtEnd);
    expect(sumLate).toBe(data.periodMetrics!.current.lateAtEnd);
  });

  it("departmentPeriodMetrics rows sum receivedDuringPeriod/openAtEnd/lateAtEnd back to the overall snapshot", async () => {
    dbMocks.complaintFindMany.mockResolvedValue([
      snapshotRow({ id: "d1", complaintDate: ISO("2026-06-25"), department: "الطوارئ" }),
      snapshotRow({ id: "d2", complaintDate: ISO("2026-06-25"), department: null }),
    ]);
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    const rows = data.departmentPeriodMetrics ?? [];
    const sums = rows.reduce(
      (acc, r) => ({
        receivedDuringPeriod: acc.receivedDuringPeriod + r.receivedDuringPeriod,
        openAtEnd: acc.openAtEnd + r.openAtEnd,
        lateAtEnd: acc.lateAtEnd + r.lateAtEnd,
      }),
      { receivedDuringPeriod: 0, openAtEnd: 0, lateAtEnd: 0 }
    );
    expect(sums.receivedDuringPeriod).toBe(data.periodMetrics!.current.receivedDuringPeriod);
    expect(sums.openAtEnd).toBe(data.periodMetrics!.current.openAtEnd);
    expect(sums.lateAtEnd).toBe(data.periodMetrics!.current.lateAtEnd);
  });

  it("topDepartments open/closed/currentlyLate come from the period snapshot, not current-status distributions", async () => {
    // Department "الطوارئ": one complaint created before the period and still open (backlog).
    dbMocks.complaintFindMany.mockResolvedValue([
      snapshotRow({ id: "bl1", complaintDate: ISO("2026-01-01"), department: "الطوارئ" }),
    ]);
    const kpiResult = makeKpiResult();
    kpiResult.distributions.byDepartment = [
      {
        name: "الطوارئ",
        count: 0,
        total: 0, // no complaints registered THIS period — but backlog is still open
        open: 0,
        closed: 0,
        currentlyLate: 0,
        closedLate: 0,
        withinDueDate: 0,
        complianceRate: null,
        averageResolutionDays: 0,
        averageResolutionEligibleCount: 0,
        slaEligibleCount: 0,
        closedWithoutTrustedDateCount: 0,
        highPriorityOpen: 0,
        unclassified: 0,
      },
    ];
    const data = await buildExecutiveBriefData(BASE_FILTERS, kpiResult, makeComparison(), undefined, NOW);
    const row = (data.topDepartments ?? []).find((d) => d.name === "الطوارئ");
    expect(row?.open).toBe(1);
  });

  describe("backlog-only department (spec sections 5-6, 17)", () => {
    // Department أ: registers complaints this period, low open balance.
    // Department ب: registers nothing this period (absent from
    // kpiResult.distributions.byDepartment entirely — not even a total:0
    // row), but carries the highest open balance from before the period.
    function makeBacklogDataset() {
      return [
        snapshotRow({ id: "reg-1", complaintDate: ISO("2026-07-02"), department: "الإدارة أ" }),
        snapshotRow({ id: "reg-2", complaintDate: ISO("2026-07-02"), department: "الإدارة أ" }),
        snapshotRow({ id: "reg-3", complaintDate: ISO("2026-07-02"), department: "الإدارة أ" }),
        snapshotRow({ id: "reg-4", complaintDate: ISO("2026-07-02"), department: "الإدارة أ" }),
        snapshotRow({ id: "reg-5", complaintDate: ISO("2026-07-02"), department: "الإدارة أ" }),
        ...Array.from({ length: 20 }, (_, i) =>
          snapshotRow({ id: `bl-${i}`, complaintDate: ISO("2026-01-01"), department: "إدارة الرصيد" })
        ).map((row, i) =>
          i < 10
            ? {
                ...row,
                statusHistory: [
                  { fromStatus: ComplaintStatus.OPEN, toStatus: ComplaintStatus.CLOSED, changedAt: ISO("2026-01-05") },
                ],
              }
            : row
        ),
      ];
    }

    it("departmentPeriodMetrics contains both departments and topDepartments builds its candidate set from the snapshot (not distributions)", async () => {
      dbMocks.complaintFindMany.mockResolvedValue(makeBacklogDataset());
      const kpiResult = makeKpiResult();
      // "إدارة الرصيد" is entirely absent here — mirrors a department with
      // zero inflow this period, which never appears in distributions.
      kpiResult.distributions.byDepartment = [
        { name: "الإدارة أ", count: 5, total: 5, open: 4, closed: 1, currentlyLate: 0, closedLate: 0, withinDueDate: 1, complianceRate: null, averageResolutionDays: 0, averageResolutionEligibleCount: 0, slaEligibleCount: 0, closedWithoutTrustedDateCount: 0, highPriorityOpen: 0, unclassified: 0 },
      ];
      const data = await buildExecutiveBriefData(BASE_FILTERS, kpiResult, makeComparison(), undefined, NOW);

      const deptMetrics = data.departmentPeriodMetrics ?? [];
      expect(deptMetrics.some((d) => d.departmentName === "الإدارة أ")).toBe(true);
      expect(deptMetrics.some((d) => d.departmentName === "إدارة الرصيد")).toBe(true);

      const backlogRow = (data.topDepartments ?? []).find((d) => d.name === "إدارة الرصيد");
      expect(backlogRow).toBeDefined();
      expect(backlogRow!.total).toBe(0); // receivedDuringPeriod
      expect(backlogRow!.open).toBe(10); // 20 backlog complaints, 10 closed via statusHistory, 10 still open
      expect(backlogRow!.shareOfTotal).toBe(0);

      // Overall receivedDuringPeriod is unaffected by the backlog-only department.
      expect(data.periodMetrics!.current.receivedDuringPeriod).toBe(5);
    });

    it("names the backlog-only department as the highest in open complaints in conclusions", async () => {
      dbMocks.complaintFindMany.mockResolvedValue(makeBacklogDataset());
      const kpiResult = makeKpiResult();
      kpiResult.distributions.byDepartment = [
        { name: "الإدارة أ", count: 5, total: 5, open: 4, closed: 1, currentlyLate: 0, closedLate: 0, withinDueDate: 1, complianceRate: null, averageResolutionDays: 0, averageResolutionEligibleCount: 0, slaEligibleCount: 0, closedWithoutTrustedDateCount: 0, highPriorityOpen: 0, unclassified: 0 },
      ];
      const data = await buildExecutiveBriefData(BASE_FILTERS, kpiResult, makeComparison(), undefined, NOW);
      const conclusionsText = (data.conclusions ?? []).join(" ");
      expect(conclusionsText).toContain("إدارة الرصيد");
      expect(conclusionsText).toContain("10"); // openAtEnd for إدارة الرصيد
    });
  });

  describe("snapshot warnings reach ExecutiveBriefData.warnings (spec section 7, 18)", () => {
    it("surfaces an uncertain-complaint snapshot warning in the report's warnings, without duplicates", async () => {
      // CLOSED, no closedAt, no sourceUpdatedAt, no statusHistory: state at
      // period end cannot be determined reliably.
      dbMocks.complaintFindMany.mockResolvedValue([
        snapshotRow({
          id: "uncertain-1",
          status: ComplaintStatus.CLOSED,
          complaintDate: ISO("2026-07-02"),
        }),
      ]);
      const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);

      expect(data.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("تعذر تحديد حالة الشكوى")])
      );
      expect(new Set(data.warnings).size).toBe((data.warnings ?? []).length);
    });
  });
});

describe("classification + region reconciliation", () => {
  it("keys unclassified by sentinel and joins open/late stock", () => {
    const current: ComplaintGroupMetrics[] = [
      {
        name: UNCLASSIFIED_CLASSIFICATION_LABEL,
        id: null,
        count: 8,
        total: 8,
        open: 5,
        closed: 3,
        currentlyLate: 5,
        closedLate: 0,
        withinDueDate: 0,
        complianceRate: null,
        averageResolutionDays: 0,
        averageResolutionEligibleCount: 0,
        slaEligibleCount: 0,
        closedWithoutTrustedDateCount: 0,
        highPriorityOpen: 0,
        unclassified: 8,
      },
      {
        name: "نقل",
        id: "c-transfer",
        count: 2,
        total: 2,
        open: 1,
        closed: 1,
        currentlyLate: 1,
        closedLate: 0,
        withinDueDate: 1,
        complianceRate: 100,
        averageResolutionDays: 2,
        averageResolutionEligibleCount: 1,
        slaEligibleCount: 1,
        closedWithoutTrustedDateCount: 0,
        highPriorityOpen: 0,
        unclassified: 0,
      },
    ];
    const rows = buildTopClassifications(current, [], 10);
    expect(rows).toHaveLength(2);
    const unclassified = rows.find((r) => r.classificationName === "غير مصنف")!;
    expect(unclassified.classificationId).toBe(UNCLASSIFIED_CLASSIFICATION_KEY);
    expect(unclassified.currentCount).toBe(8);

    const openLate = {
      [UNCLASSIFIED_CLASSIFICATION_KEY]: { openAtEnd: 5, lateAtEnd: 5 },
      "c-transfer": { openAtEnd: 1, lateAtEnd: 1 },
    };
    const enriched = reconcileClassificationOpenLate(rows, openLate);
    expect(enriched.find((r) => r.classificationId === UNCLASSIFIED_CLASSIFICATION_KEY)?.openAtEnd).toBe(5);
    expect(enriched.find((r) => r.classificationId === "c-transfer")?.openAtEnd).toBe(1);
    const totals = sumClassificationOpenLate(enriched);
    expect(totals.openAtEnd).toBe(6);
    expect(totals.lateAtEnd).toBe(6);
    expect(rows.reduce((s, r) => s + r.currentCount, 0)).toBe(10);

    // Regression: Arabic display name must never be the join key.
    const wrongKeyMap: Record<string, { openAtEnd: number; lateAtEnd: number }> = {
      "غير مصنف": { openAtEnd: 163, lateAtEnd: 163 },
    };
    expect(Object.prototype.hasOwnProperty.call(openLate, "غير مصنف")).toBe(false);
    expect(
      reconcileClassificationOpenLate(rows, wrongKeyMap)
        .find((r) => r.classificationId === UNCLASSIFIED_CLASSIFICATION_KEY)?.openAtEnd
    ).toBe(0);
  });

  it("reconciles regional sums with comparison totals after alias collapse", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    const sums = sumRegionReferenceRows(data.allRegions);
    assertRegionalReconciliation({
      currentRows: data.allRegions,
      previousRows: data.allRegions,
      currentTotal: 100,
      previousTotal: 80,
    });
    expect(sums.current).toBe(100);
    expect(sums.previous).toBe(80);
    expect(sums.difference).toBe(20);
  });

  it("keeps open/late classification totals aligned with overall open/late when rows cover all volume", () => {
    const rows = buildTopClassifications(
      [
        {
          name: "غير مصنف",
          id: null,
          count: 9192,
          total: 9192,
          open: 163,
          closed: 0,
          currentlyLate: 163,
          closedLate: 0,
          withinDueDate: 0,
          complianceRate: null,
          averageResolutionDays: 0,
          averageResolutionEligibleCount: 0,
          slaEligibleCount: 0,
          closedWithoutTrustedDateCount: 0,
          highPriorityOpen: 0,
          unclassified: 9192,
        },
        {
          name: "أ",
          id: "a",
          count: 10,
          total: 10,
          open: 1,
          closed: 0,
          currentlyLate: 1,
          closedLate: 0,
          withinDueDate: 0,
          complianceRate: null,
          averageResolutionDays: 0,
          averageResolutionEligibleCount: 0,
          slaEligibleCount: 0,
          closedWithoutTrustedDateCount: 0,
          highPriorityOpen: 0,
          unclassified: 0,
        },
        {
          name: "ب",
          id: "b",
          count: 10,
          total: 10,
          open: 1,
          closed: 0,
          currentlyLate: 1,
          closedLate: 0,
          withinDueDate: 0,
          complianceRate: null,
          averageResolutionDays: 0,
          averageResolutionEligibleCount: 0,
          slaEligibleCount: 0,
          closedWithoutTrustedDateCount: 0,
          highPriorityOpen: 0,
          unclassified: 0,
        },
        {
          name: "ج",
          id: "c",
          count: 10,
          total: 10,
          open: 1,
          closed: 0,
          currentlyLate: 1,
          closedLate: 0,
          withinDueDate: 0,
          complianceRate: null,
          averageResolutionDays: 0,
          averageResolutionEligibleCount: 0,
          slaEligibleCount: 0,
          closedWithoutTrustedDateCount: 0,
          highPriorityOpen: 0,
          unclassified: 0,
        },
      ],
      [],
      9222
    );
    expect(rows.reduce((s, r) => s + r.currentCount, 0)).toBe(9222);
    const enriched = reconcileClassificationOpenLate(rows, {
      [UNCLASSIFIED_CLASSIFICATION_KEY]: { openAtEnd: 163, lateAtEnd: 163 },
      a: { openAtEnd: 1, lateAtEnd: 1 },
      b: { openAtEnd: 1, lateAtEnd: 1 },
      c: { openAtEnd: 1, lateAtEnd: 1 },
    });
    const totals = sumClassificationOpenLate(enriched);
    expect(totals.openAtEnd).toBe(166);
    expect(totals.lateAtEnd).toBe(166);
    expect(enriched.find((r) => r.classificationId === UNCLASSIFIED_CLASSIFICATION_KEY)?.openAtEnd).not.toBe(0);
    expect(enriched.find((r) => r.classificationId === UNCLASSIFIED_CLASSIFICATION_KEY)?.openAtEnd).not.toBe(68);
  });
});

function makeFinding(overrides: Partial<AnalyticalFinding> & { facility?: string }): AnalyticalFinding {
  const { facility, ...rest } = overrides;
  return {
    id: rest.id ?? "f",
    type: "CHRONIC_ISSUE",
    entityType: "CLASSIFICATION",
    entityId: null,
    entityName: "سجن — التغذية",
    currentValue: 10,
    previousValue: 5,
    difference: 5,
    changeRate: 100,
    severity: "MEDIUM",
    priorityScore: 50,
    confidence: "MEDIUM",
    detectionSource: "QUANTITATIVE",
    explanation: "x",
    supportingMetrics: {},
    evidenceComplaintIds: [],
    evidenceSpans: [],
    limitations: [],
    drilldownFilters: facility ? { facility } : {},
    firstDetectedAt: "2026-01-01T00:00:00.000Z",
    lastDetectedAt: "2026-01-01T00:00:00.000Z",
    detectorVersion: "pattern-v1",
    ...rest,
  };
}

describe("buildFacilitiesNeedingFollowUp — V2 only, spec §1/§3/§10/§11 (priority-driven, scope-unified, never volume-driven)", () => {
  it("ranks by the facility's highest priorityScore, not by raw complaint volume", () => {
    const findings = [
      makeFinding({ id: "low-priority-high-volume", facility: "سجن أ", entityName: "سجن أ — الاتصال", priorityScore: 20, currentValue: 200 }),
      makeFinding({ id: "high-priority-low-volume", facility: "سجن ب", entityName: "سجن ب — الرعاية الصحية", priorityScore: 90, currentValue: 8 }),
    ];
    const totals = { "سجن أ": 200, "سجن ب": 8 };
    const rows = buildFacilitiesNeedingFollowUp(findings, totals);
    expect(rows[0].facility).toBe("سجن ب");
  });

  it("takes topIssueLabel/patternLabel/streakPeriods from the facility's highest-ranked classification finding, excluding SUSTAINED_IMPROVEMENT", () => {
    const findings = [
      makeFinding({
        id: "improvement", facility: "سجن أ", entityName: "سجن أ — الاتصال", type: "SUSTAINED_IMPROVEMENT",
        priorityScore: 0, supportingMetrics: { pattern: "SUSTAINED_IMPROVEMENT", streakPeriods: 4 },
      }),
      makeFinding({
        id: "chronic", facility: "سجن أ", entityName: "سجن أ — الرعاية الصحية", priorityScore: 70,
        supportingMetrics: { pattern: "CONTINUED_RISE", streakPeriods: 5 },
      }),
    ];
    const rows = buildFacilitiesNeedingFollowUp(findings, { "سجن أ": 50 });
    expect(rows[0].topIssueLabel).toBe("الرعاية الصحية");
    expect(rows[0].patternLabel).toBe("استمرار مرتفع");
    expect(rows[0].streakPeriods).toBe(5);
  });

  it("surfaces mass/collective complaints and repeat complainants as real numbers, never a vague qualitative label (spec §10)", () => {
    const withMass = buildFacilitiesNeedingFollowUp(
      [
        makeFinding({ id: "c", facility: "سجن أ", priorityScore: 60 }),
        makeFinding({
          id: "mass", facility: "سجن أ", type: "MASS_COMPLAINT", entityType: "FACILITY",
          priorityScore: 40, currentValue: 34, supportingMetrics: { distinctComplainants: 29 },
        }),
      ],
      { "سجن أ": 40 }
    );
    expect(withMass[0].spreadComplainants).toBe(29);
    expect(withMass[0].spreadComplaints).toBe(34);
    expect(withMass[0].repeatComplainants).toBeNull();
    expect(withMass[0].repeatComplaints).toBeNull();

    const withRepeat = buildFacilitiesNeedingFollowUp(
      [
        makeFinding({ id: "c", facility: "سجن ب", priorityScore: 60 }),
        makeFinding({
          id: "repeat", facility: "سجن ب", type: "REPEAT_COMPLAINANT", entityType: "FACILITY",
          priorityScore: 30, currentValue: 21, supportingMetrics: { repeatComplainantCount: 8 },
        }),
      ],
      { "سجن ب": 40 }
    );
    expect(withRepeat[0].repeatComplainants).toBe(8);
    expect(withRepeat[0].repeatComplaints).toBe(21);
    expect(withRepeat[0].spreadComplainants).toBeNull();
    expect(withRepeat[0].spreadComplaints).toBeNull();

    const withNeither = buildFacilitiesNeedingFollowUp(
      [makeFinding({ id: "c", facility: "سجن ج", priorityScore: 60 })],
      { "سجن ج": 40 }
    );
    expect(withNeither[0].repeatComplainants).toBeNull();
    expect(withNeither[0].spreadComplainants).toBeNull();
  });

  it("excludes the unspecified (غير محدد) facility bucket", () => {
    const rows = buildFacilitiesNeedingFollowUp(
      [makeFinding({ id: "c", facility: "غير محدد", priorityScore: 90 })],
      { "غير محدد": 100 }
    );
    expect(rows).toEqual([]);
  });

  it("caps at the requested limit", () => {
    const findings = Array.from({ length: 8 }, (_, i) =>
      makeFinding({ id: `f${i}`, facility: `سجن ${i}`, priorityScore: 100 - i })
    );
    const totals = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`سجن ${i}`, 10]));
    expect(buildFacilitiesNeedingFollowUp(findings, totals, 5)).toHaveLength(5);
  });

  it("reads totalComplaints from facilityCurrentPeriodTotals — the SAME aggregation that produced the finding — never from a separately-computed snapshot or the finding's own currentValue", () => {
    const rows = buildFacilitiesNeedingFollowUp(
      [makeFinding({ id: "c", facility: "سجن أ", currentValue: 9, priorityScore: 60 })],
      { "سجن أ": 142 }
    );
    expect(rows[0].totalComplaints).toBe(142);
  });

  describe("spec §1 regression: totalComplaints=0 must never coexist with a misleading high-priority row", () => {
    it("excludes a facility whose real current-period total is 0 when only a repeat/mass finding (no chronic/relapse) drives it", () => {
      const rows = buildFacilitiesNeedingFollowUp(
        [
          makeFinding({
            id: "mass", facility: "سجن أ", type: "MASS_COMPLAINT", entityType: "FACILITY",
            priorityScore: 90, currentValue: 34, supportingMetrics: { distinctComplainants: 29 },
          }),
        ],
        { "سجن أ": 0 }
      );
      expect(rows).toEqual([]);
    });

    it("keeps a facility whose real current-period total is 0 when a genuine CHRONIC_ISSUE justifies it, flagged isHistoricalOnly with an explicit total of 0", () => {
      const rows = buildFacilitiesNeedingFollowUp(
        [makeFinding({ id: "chronic", facility: "سجن أ", type: "CHRONIC_ISSUE", priorityScore: 80 })],
        { "سجن أ": 0 }
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].totalComplaints).toBe(0);
      expect(rows[0].isHistoricalOnly).toBe(true);
    });

    it("keeps a facility whose real current-period total is 0 when a RELAPSE_AFTER_IMPROVEMENT trend justifies it", () => {
      const rows = buildFacilitiesNeedingFollowUp(
        [
          makeFinding({
            id: "relapse", facility: "سجن أ", type: "TREND_PATTERN", priorityScore: 65,
            supportingMetrics: { pattern: "RELAPSE_AFTER_IMPROVEMENT", streakPeriods: 2 },
          }),
        ],
        { "سجن أ": 0 }
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].isHistoricalOnly).toBe(true);
    });

    it("never marks isHistoricalOnly when the real current-period total is positive", () => {
      const rows = buildFacilitiesNeedingFollowUp(
        [makeFinding({ id: "chronic", facility: "سجن أ", type: "CHRONIC_ISSUE", priorityScore: 80 })],
        { "سجن أ": 12 }
      );
      expect(rows[0].isHistoricalOnly).toBe(false);
      expect(rows[0].totalComplaints).toBe(12);
    });
  });

  describe("spec §11 tie-breakers (priorityScore -> chronic -> streak -> distinct complainants -> volume -> name)", () => {
    it("breaks an exact priorityScore tie in favor of a chronic issue over a non-chronic trend", () => {
      const rows = buildFacilitiesNeedingFollowUp(
        [
          makeFinding({ id: "trend", facility: "سجن ب", type: "TREND_PATTERN", priorityScore: 50, supportingMetrics: { pattern: "ESCALATING", streakPeriods: 3 } }),
          makeFinding({ id: "chronic", facility: "سجن أ", type: "CHRONIC_ISSUE", priorityScore: 50 }),
        ],
        { "سجن أ": 10, "سجن ب": 10 }
      );
      expect(rows.map((r) => r.facility)).toEqual(["سجن أ", "سجن ب"]);
    });

    it("breaks a chronic-vs-chronic tie by longer streak", () => {
      const rows = buildFacilitiesNeedingFollowUp(
        [
          makeFinding({ id: "short", facility: "سجن ب", type: "CHRONIC_ISSUE", priorityScore: 50, supportingMetrics: { streakPeriods: 3 } }),
          makeFinding({ id: "long", facility: "سجن أ", type: "CHRONIC_ISSUE", priorityScore: 50, supportingMetrics: { streakPeriods: 6 } }),
        ],
        { "سجن أ": 10, "سجن ب": 10 }
      );
      expect(rows.map((r) => r.facility)).toEqual(["سجن أ", "سجن ب"]);
    });

    it("falls back to facility name for a fully deterministic order when everything else ties", () => {
      const rows = buildFacilitiesNeedingFollowUp(
        [
          makeFinding({ id: "b", facility: "سجن ب", type: "CHRONIC_ISSUE", priorityScore: 50, currentValue: 10 }),
          makeFinding({ id: "a", facility: "سجن أ", type: "CHRONIC_ISSUE", priorityScore: 50, currentValue: 10 }),
        ],
        { "سجن أ": 10, "سجن ب": 10 }
      );
      expect(rows.map((r) => r.facility)).toEqual(["سجن أ", "سجن ب"]);
    });
  });
});

describe("buildFacilitiesWithSustainedImprovement — V2 only, spec section 4 (real multi-period decline only)", () => {
  it("requires an actual SUSTAINED_IMPROVEMENT finding — a low current value alone is never 'best'", () => {
    const rows = buildFacilitiesWithSustainedImprovement([
      makeFinding({ id: "chronic-but-small", facility: "سجن أ", type: "CHRONIC_ISSUE", currentValue: 2, previousValue: 2 }),
    ]);
    expect(rows).toEqual([]);
  });

  it("picks the classification with the largest decrease when a facility has more than one improving classification", () => {
    const rows = buildFacilitiesWithSustainedImprovement([
      makeFinding({
        id: "small-drop", facility: "سجن أ", entityName: "سجن أ — الاتصال", type: "SUSTAINED_IMPROVEMENT",
        currentValue: 8, previousValue: 10, supportingMetrics: { streakPeriods: 3 },
      }),
      makeFinding({
        id: "big-drop", facility: "سجن أ", entityName: "سجن أ — التغذية", type: "SUSTAINED_IMPROVEMENT",
        currentValue: 5, previousValue: 40, supportingMetrics: { streakPeriods: 4 },
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].classificationLabel).toBe("التغذية");
    expect(rows[0].decrease).toBe(35);
  });

  it("ranks facilities by decrease magnitude, descending", () => {
    const rows = buildFacilitiesWithSustainedImprovement([
      makeFinding({ id: "a", facility: "سجن صغير", type: "SUSTAINED_IMPROVEMENT", currentValue: 8, previousValue: 12 }),
      makeFinding({ id: "b", facility: "سجن كبير", type: "SUSTAINED_IMPROVEMENT", currentValue: 5, previousValue: 40 }),
    ]);
    expect(rows.map((r) => r.facility)).toEqual(["سجن كبير", "سجن صغير"]);
  });

  it("excludes the unspecified (غير محدد) facility bucket", () => {
    const rows = buildFacilitiesWithSustainedImprovement([
      makeFinding({ id: "a", facility: "غير محدد", type: "SUSTAINED_IMPROVEMENT", currentValue: 5, previousValue: 40 }),
    ]);
    expect(rows).toEqual([]);
  });

  it("caps at the requested limit", () => {
    const findings = Array.from({ length: 7 }, (_, i) =>
      makeFinding({ id: `f${i}`, facility: `سجن ${i}`, type: "SUSTAINED_IMPROVEMENT", currentValue: 5, previousValue: 40 - i })
    );
    expect(buildFacilitiesWithSustainedImprovement(findings, 5)).toHaveLength(5);
  });
});

describe("buildRegionOnlyConclusions — V2 only (spec sections 10-15, 17 items 17-21)", () => {
  function regionChange(overrides: Partial<RegionChangeRow> & { regionName: string }): RegionChangeRow {
    return {
      currentCount: 0,
      previousCount: 0,
      difference: 0,
      changeRate: null,
      direction: "دون تغير",
      ...overrides,
    };
  }

  function comparisonWithRegionChanges(
    regionChanges: RegionChangeRow[],
    hasPrevious = true
  ): ComparisonResult {
    return { ...makeComparison(hasPrevious), regionChanges };
  }

  it("17. conclusions never mention departments, facilities, or classifications — only region names and counts", () => {
    const comparison = comparisonWithRegionChanges([
      regionChange({ regionName: "الرياض", currentCount: 140, previousCount: 20, difference: 120, changeRate: 600, direction: "ارتفاع" }),
    ]);
    const conclusions = buildRegionOnlyConclusions(comparison);
    expect(conclusions).toHaveLength(1);
    expect(conclusions[0]).toContain("الرياض");
    expect(conclusions[0]).not.toContain("إدارة");
    expect(conclusions[0]).not.toContain("سجن");
    expect(conclusions[0]).not.toContain("تصنيف");
  });

  it("18-19. builds rise/decline text only from comparison.regionChanges, matching the spec's example phrasing", () => {
    const comparison = comparisonWithRegionChanges([
      regionChange({ regionName: "الرياض", currentCount: 620, previousCount: 500, difference: 120, changeRate: 18, direction: "ارتفاع" }),
      regionChange({ regionName: "تبوك", currentCount: 250, previousCount: 285, difference: -35, changeRate: -12, direction: "انخفاض" }),
    ]);
    const conclusions = buildRegionOnlyConclusions(comparison);
    expect(conclusions).toContain("سجلت الرياض ارتفاعًا قدره 120 شكوى مقارنة بالفترة السابقة، بنسبة تغير 18%.");
    expect(conclusions).toContain("سجلت تبوك انخفاضًا قدره 35 شكوى مقارنة بالفترة السابقة، بنسبة تغير 12%.");
  });

  it("20. previousCount === 0 with currentCount > 0 never fabricates a change rate (no Infinity/NaN/percent)", () => {
    const comparison = comparisonWithRegionChanges([
      regionChange({ regionName: "المنطقة الشرقية", currentCount: 18, previousCount: 0, difference: 18, changeRate: null, direction: "جديد" }),
    ]);
    const conclusions = buildRegionOnlyConclusions(comparison);
    expect(conclusions[0]).toBe("سجلت المنطقة الشرقية 18 شكوى خلال الفترة الحالية بعد عدم تسجيل شكاوى في الفترة السابقة.");
    expect(conclusions[0]).not.toContain("Infinity");
    expect(conclusions[0]).not.toContain("NaN");
    expect(conclusions[0]).not.toContain("%");
  });

  it("21. no valid comparison period returns the dedicated fallback sentence, never a fabricated comparison", () => {
    const comparison = comparisonWithRegionChanges([], false);
    const conclusions = buildRegionOnlyConclusions(comparison);
    expect(conclusions).toEqual(["لا تتوفر فترة سابقة صالحة لاستخراج استنتاجات مقارنة للمناطق."]);
  });

  it("no rises or declines (all regions unchanged) returns the dedicated no-changes sentence", () => {
    const comparison = comparisonWithRegionChanges([
      regionChange({ regionName: "الرياض", currentCount: 40, previousCount: 40, difference: 0, changeRate: 0, direction: "دون تغير" }),
    ]);
    const conclusions = buildRegionOnlyConclusions(comparison);
    expect(conclusions).toEqual(["لم تسجل المناطق تغيرات في أعداد الشكاوى مقارنة بالفترة السابقة."]);
  });

  it("caps at 5 conclusions and represents both directions when both exist (not consumed entirely by one side)", () => {
    const comparison = comparisonWithRegionChanges([
      regionChange({ regionName: "منطقة1", currentCount: 100, previousCount: 10, difference: 90, changeRate: 900, direction: "ارتفاع" }),
      regionChange({ regionName: "منطقة2", currentCount: 90, previousCount: 10, difference: 80, changeRate: 800, direction: "ارتفاع" }),
      regionChange({ regionName: "منطقة3", currentCount: 80, previousCount: 10, difference: 70, changeRate: 700, direction: "ارتفاع" }),
      regionChange({ regionName: "منطقة4", currentCount: 70, previousCount: 10, difference: 60, changeRate: 600, direction: "ارتفاع" }),
      regionChange({ regionName: "منطقة5", currentCount: 10, previousCount: 100, difference: -90, changeRate: -90, direction: "انخفاض" }),
      regionChange({ regionName: "منطقة6", currentCount: 10, previousCount: 90, difference: -80, changeRate: -89, direction: "انخفاض" }),
    ]);
    const conclusions = buildRegionOnlyConclusions(comparison);
    expect(conclusions.length).toBeLessThanOrEqual(5);
    const mentionsRise = conclusions.some((c) => c.includes("ارتفاعًا"));
    const mentionsDecline = conclusions.some((c) => c.includes("انخفاضًا"));
    expect(mentionsRise).toBe(true);
    expect(mentionsDecline).toBe(true);
  });

  it("sorts rising regions by difference desc, then changeRate desc, then Arabic name asc", () => {
    const comparison = comparisonWithRegionChanges([
      regionChange({ regionName: "ب", currentCount: 20, previousCount: 10, difference: 10, changeRate: 100, direction: "ارتفاع" }),
      regionChange({ regionName: "أ", currentCount: 20, previousCount: 10, difference: 10, changeRate: 100, direction: "ارتفاع" }),
      regionChange({ regionName: "ج", currentCount: 30, previousCount: 10, difference: 20, changeRate: 200, direction: "ارتفاع" }),
    ]);
    const conclusions = buildRegionOnlyConclusions(comparison);
    expect(conclusions[0]).toContain("ج");
    expect(conclusions[1]).toContain("أ");
    expect(conclusions[2]).toContain("ب");
  });

  it("never says 'negative performance', 'decline', or 'problem' for a rise, and doesn't editorialize a decline as improvement", () => {
    const comparison = comparisonWithRegionChanges([
      regionChange({ regionName: "الرياض", currentCount: 120, previousCount: 100, difference: 20, changeRate: 20, direction: "ارتفاع" }),
      regionChange({ regionName: "جدة", currentCount: 80, previousCount: 100, difference: -20, changeRate: -20, direction: "انخفاض" }),
    ]);
    const conclusions = buildRegionOnlyConclusions(comparison).join(" ");
    for (const forbidden of ["سلبي", "مشكلة", "تحسن", "تراجع الأداء"]) {
      expect(conclusions).not.toContain(forbidden);
    }
  });
});

describe("buildTopClassifications — unaffected by the V2 classification-trend refactor", () => {
  function classificationGroup(overrides: Partial<ComplaintGroupMetrics> & { id: string | null; name: string; total: number }): ComplaintGroupMetrics {
    return {
      count: overrides.total,
      open: 0,
      closed: 0,
      currentlyLate: 0,
      closedLate: 0,
      withinDueDate: 0,
      complianceRate: null,
      averageResolutionDays: 0,
      averageResolutionEligibleCount: 0,
      slaEligibleCount: 0,
      closedWithoutTrustedDateCount: 0,
      highPriorityOpen: 0,
      unclassified: 0,
      categoryId: `cat-${overrides.id}`,
      categoryName: "فئة اختبار",
      classificationName: overrides.name,
      ...overrides,
    };
  }

  it("output is unaffected by the classificationRowKey/resolveClassificationRowInfo refactor", () => {
    const current = [classificationGroup({ id: "c1", name: "نقل", total: 30, categoryName: "فئة أ" })];
    const previous = [classificationGroup({ id: "c1", name: "نقل", total: 20 })];
    const rows = buildTopClassifications(current, previous, 30);
    expect(rows).toEqual([
      {
        categoryId: "cat-c1",
        categoryName: "فئة أ",
        classificationId: "c1",
        classificationName: "نقل",
        classificationPath: "فئة أ / نقل",
        currentCount: 30,
        previousCount: 20,
        difference: 10,
        changeRate: 50,
        shareOfTotal: 100,
      },
    ]);
  });
});

describe("buildClassificationTrendRows — V2 only, spec sections 1-2 (multi-period, engine-sourced, priority-ranked)", () => {
  it("includes only CLASSIFICATION-scoped chronic/trend/improvement findings", () => {
    const findings = [
      makeFinding({ id: "chronic", entityType: "CLASSIFICATION", type: "CHRONIC_ISSUE", priorityScore: 80 }),
      makeFinding({ id: "trend", entityType: "CLASSIFICATION", type: "TREND_PATTERN", priorityScore: 60 }),
      makeFinding({ id: "improvement", entityType: "CLASSIFICATION", type: "SUSTAINED_IMPROVEMENT", priorityScore: 0 }),
      makeFinding({ id: "facility-level", entityType: "FACILITY", type: "MULTI_ISSUE_FACILITY", priorityScore: 90 }),
    ];
    const rows = buildClassificationTrendRows(findings);
    expect(rows.map((r) => r.priorityScore).sort((a, b) => b - a)).toEqual([80, 60, 0]);
  });

  it("ranks by priorityScore, not by raw difference", () => {
    const findings = [
      makeFinding({ id: "big-jump-low-priority", entityType: "CLASSIFICATION", type: "TREND_PATTERN", currentValue: 3, previousValue: 1, difference: 2, priorityScore: 10 }),
      makeFinding({ id: "small-jump-high-priority", entityType: "CLASSIFICATION", type: "CHRONIC_ISSUE", currentValue: 46, previousValue: 43, difference: 3, priorityScore: 85 }),
    ];
    const rows = buildClassificationTrendRows(findings);
    expect(rows[0]!.priorityScore).toBe(85);
  });

  it("splits the finding's entityName into independent facility/classification columns, and builds the trail from periodCounts (spec §3)", () => {
    const findings = [
      makeFinding({
        id: "f", entityType: "CLASSIFICATION", type: "CHRONIC_ISSUE", entityName: "سجن أ — التغذية", facility: "سجن أ",
        currentValue: 46, difference: 3, supportingMetrics: { streakPeriods: 4, periodCounts: JSON.stringify([38, 42, 43, 46]) },
      }),
    ];
    const rows = buildClassificationTrendRows(findings);
    expect(rows[0].facility).toBe("سجن أ");
    expect(rows[0].classification).toBe("التغذية");
    expect(rows[0].trail).toBe("38، 42، 43، 46");
    expect(rows[0].streakPeriods).toBe(4);
  });

  it.each([
    ["CONTINUED_RISE", "استمرار مرتفع"],
    ["ESCALATING", "تصاعد مستمر"],
    ["SUSTAINED_IMPROVEMENT", "تحسن مستدام"],
    ["RELAPSE_AFTER_IMPROVEMENT", "عودة للارتفاع بعد تحسن"],
    ["EMERGING", "مشكلة ناشئة"],
    ["VOLATILE", "متذبذب"],
  ])("maps the engine pattern %s to the Arabic label %s", (pattern, label) => {
    const rows = buildClassificationTrendRows([
      makeFinding({ id: "f", entityType: "CLASSIFICATION", type: "TREND_PATTERN", supportingMetrics: { pattern } }),
    ]);
    expect(rows[0].patternLabel).toBe(label);
  });

  it("caps at the requested limit", () => {
    const findings = Array.from({ length: 8 }, (_, i) =>
      makeFinding({ id: `f${i}`, entityType: "CLASSIFICATION", type: "CHRONIC_ISSUE", priorityScore: 100 - i })
    );
    expect(buildClassificationTrendRows(findings, 5)).toHaveLength(5);
  });

  it("returns an empty list when there are no relevant findings", () => {
    expect(buildClassificationTrendRows([])).toEqual([]);
  });
});
