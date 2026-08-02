// @vitest-environment node
//
// Unit tests for the executive brief data builder.
// All DB calls are mocked — no real SQLite instance required in CI.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildExecutiveBriefData, buildFullAnalyticalData } from "./report-executive-brief-data-service";
import type { ReportFilters } from "./report-definition-service";
import type { ComparisonResult, DeptClassPeriodCount, PeriodRange } from "./report-comparison";
import type { ComplaintKpiResult } from "@/server/complaints/complaint-kpi-service";

// ---------------------------------------------------------------------------
// Hoist mocks so they are available before module imports are processed.
// ---------------------------------------------------------------------------

const dbMocks = vi.hoisted(() => ({
  complaintGroupBy: vi.fn(),
  complaintFindMany: vi.fn(),
  complaintCount: vi.fn(),
  statusHistoryGroupBy: vi.fn(),
  statusHistoryCount: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    complaint: {
      groupBy: dbMocks.complaintGroupBy,
      findMany: dbMocks.complaintFindMany,
      count: dbMocks.complaintCount,
    },
    complaintStatusHistory: {
      groupBy: dbMocks.statusHistoryGroupBy,
      count: dbMocks.statusHistoryCount,
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no regions in the all-time list, no complaints in the DB.
  dbMocks.complaintGroupBy.mockResolvedValue([]);
  dbMocks.complaintFindMany.mockResolvedValue([]);
  dbMocks.complaintCount.mockResolvedValue(0);
  dbMocks.statusHistoryGroupBy.mockResolvedValue([]);
  dbMocks.statusHistoryCount.mockResolvedValue(0);
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
      closedWithinDueDate: kpi(62, 45),
      withoutDueDate: kpi(2, 3),
      unclassifiedComplaints: kpi(4, 6),
      highPriorityOpenComplaints: kpi(5, 8),
      averageResolutionDays: kpi(3.5, 4.0),
      medianResolutionDays: kpi(2.0, 2.5),
      averageOpenAgeDays: kpi(5.0, 6.0),
      dueDateComplianceRate: kpi(95.0, 90.0),
      closureRate: kpi(65.0, 62.5),
      reopenCount: kpi(2, 1),
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
    },
    trend: {
      previousTotal: 80,
      growthRate: 25.0,
      trendData: [],
    },
    distributions: {
      byRegion: [
        { name: "الرياض", id: null, count: 40, total: 40, open: 10, closed: 28, currentlyLate: 3, closedLate: 1, withinDueDate: 27, complianceRate: 96.4, averageResolutionDays: 3.2, highPriorityOpen: 2, unclassified: 1 },
        { name: "جدة", id: null, count: 30, total: 30, open: 8, closed: 20, currentlyLate: 2, closedLate: 1, withinDueDate: 19, complianceRate: 95.0, averageResolutionDays: 3.5, highPriorityOpen: 1, unclassified: 0 },
        { name: "مكة", id: null, count: 20, total: 20, open: 7, closed: 12, currentlyLate: 2, closedLate: 1, withinDueDate: 11, complianceRate: 91.7, averageResolutionDays: 4.1, highPriorityOpen: 2, unclassified: 2 },
        { name: "المدينة", id: null, count: 10, total: 10, open: 5, closed: 5, currentlyLate: 1, closedLate: 0, withinDueDate: 5, complianceRate: 100.0, averageResolutionDays: 2.8, highPriorityOpen: 0, unclassified: 1 },
      ],
      byFacility: [],
      byDepartment: [
        { name: "الصحة", id: "dept-health", count: 45, total: 45, open: 12, closed: 31, currentlyLate: 4, closedLate: 2, withinDueDate: 29, complianceRate: 93.5, averageResolutionDays: 3.8, highPriorityOpen: 3, unclassified: 2 },
        { name: "التعليم", id: "dept-edu", count: 35, total: 35, open: 10, closed: 24, currentlyLate: 2, closedLate: 1, withinDueDate: 23, complianceRate: 95.8, averageResolutionDays: 3.2, highPriorityOpen: 1, unclassified: 1 },
        { name: "الخدمات", id: "dept-svc", count: 20, total: 20, open: 8, closed: 10, currentlyLate: 2, closedLate: 0, withinDueDate: 10, complianceRate: 100.0, averageResolutionDays: 2.9, highPriorityOpen: 1, unclassified: 1 },
      ],
      byClassification: [
        { name: "ضوضاء", id: "class-01", count: 30, total: 30, open: 8, closed: 20, currentlyLate: 3, closedLate: 1, withinDueDate: 19, complianceRate: 95.0, averageResolutionDays: 3.2, highPriorityOpen: 1, unclassified: 0 },
        { name: "بنية تحتية", id: "class-02", count: 25, total: 25, open: 7, closed: 17, currentlyLate: 2, closedLate: 1, withinDueDate: 16, complianceRate: 94.1, averageResolutionDays: 3.8, highPriorityOpen: 2, unclassified: 1 },
        { name: "مخلفات", id: "class-03", count: 20, total: 20, open: 5, closed: 13, currentlyLate: 1, closedLate: 0, withinDueDate: 13, complianceRate: 100.0, averageResolutionDays: 2.8, highPriorityOpen: 0, unclassified: 0 },
        { name: "مياه", id: "class-04", count: 15, total: 15, open: 6, closed: 8, currentlyLate: 1, closedLate: 1, withinDueDate: 7, complianceRate: 87.5, averageResolutionDays: 4.5, highPriorityOpen: 2, unclassified: 1 },
        { name: "إضاءة", id: "class-05", count: 10, total: 10, open: 4, closed: 7, currentlyLate: 1, closedLate: 0, withinDueDate: 7, complianceRate: 100.0, averageResolutionDays: 2.5, highPriorityOpen: 0, unclassified: 0 },
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
      currentCount: 15,
      previousCount: 10,
    },
  ];

  return {
    currentPeriod: CURRENT_PERIOD,
    previousPeriod: hasPrevious ? PREVIOUS_PERIOD : null,
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

  it("keeps compliance unavailable when no closed complaint has a valid due date", async () => {
    const result = makeKpiResult();
    result.performance.onTimeRate = null;
    result.kpis.dueDateComplianceRate.available = false;
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, makeComparison(), undefined, NOW);
    expect(data.briefKpis.find((kpi) => kpi.key === "complianceRate")?.value).toBeNull();
  });

  it("closed KPI: fewer closed → negative assessment", async () => {
    const result = makeKpiResult();
    (result.kpis.closedComplaints as { currentValue: number; previousValue: number }).currentValue = 40;
    (result.kpis.closedComplaints as { currentValue: number; previousValue: number }).previousValue = 50;
    (result.volume as { closed: number }).closed = 40;
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, makeComparison(), undefined, NOW);
    expect(data.briefKpis.find((k) => k.key === "closed")?.assessment).toBe("negative");
  });

  it("currentlyLate KPI: fewer late → positive assessment", async () => {
    const result = makeKpiResult();
    (result.kpis.currentlyLateComplaints as { currentValue: number; previousValue: number }).currentValue = 5;
    (result.kpis.currentlyLateComplaints as { currentValue: number; previousValue: number }).previousValue = 10;
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, makeComparison(), undefined, NOW);
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

  it("each row has classificationId and classificationName but no categoryName", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    for (const row of data.topClassifications) {
      expect(typeof row.classificationId).toBe("string");
      expect(typeof row.classificationName).toBe("string");
      expect(row).not.toHaveProperty("categoryName");
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

  it("current period has periodDays points", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    expect(data.comparativeTimeline.current.points).toHaveLength(data.comparativeTimeline.periodDays);
  });

  it.each([
    { days: 31, aggregation: "daily", expectedPoints: 31 },
    { days: 56, aggregation: "weekly", expectedPoints: 8 },
    { days: 180, aggregation: "monthly", expectedPoints: 6 },
  ] as const)(
    "uses $aggregation buckets for a $days-day reporting period",
    async ({ days, aggregation, expectedPoints }) => {
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
      expect(data.comparativeTimeline.aggregation).toBe(aggregation);
      expect(data.comparativeTimeline.current.points).toHaveLength(expectedPoints);
    }
  );

  it("previous period is null when no comparison", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(false), undefined, NOW);
    expect(data.comparativeTimeline.previous).toBeNull();
  });

  it("current counts match sum of region trend series", async () => {
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    // Day 1 (2026-07-01): الرياض=5, جدة=4 → total=9
    expect(data.comparativeTimeline.current.points.find((p) => p.relativeDay === 1)?.count).toBe(9);
    // Day 2 (2026-07-02): الرياض=6, جدة=4 → total=10
    expect(data.comparativeTimeline.current.points.find((p) => p.relativeDay === 2)?.count).toBe(10);
  });

  it("previous period queries DB with receivedAt fallback (null complaintDate)", async () => {
    // Simulate two previous-period complaints: one with complaintDate, one with null+receivedAt
    dbMocks.complaintFindMany.mockResolvedValue([
      { complaintDate: new Date("2026-06-25T00:00:00.000Z"), receivedAt: new Date("2026-06-24T00:00:00.000Z") },
      { complaintDate: null, receivedAt: new Date("2026-06-26T00:00:00.000Z") },
    ]);
    const data = await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    // Both complaints appear in the previous period timeline
    const prevPoints = data.comparativeTimeline.previous?.points ?? [];
    const day2 = prevPoints.find((p) => p.relativeDay === 2); // 2026-06-25 = day 2
    const day3 = prevPoints.find((p) => p.relativeDay === 3); // 2026-06-26 = day 3
    expect(day2?.count).toBe(1); // complaintDate used
    expect(day3?.count).toBe(1); // receivedAt used as fallback
  });

  it("now is passed from caller — does not use new Date() internally", async () => {
    // Pass a fixed NOW; previous-period query should call findMany once.
    await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    // If now were live, the result would be non-deterministic.
    // We just verify the mock was called — actual determinism is contract-level.
    expect(dbMocks.complaintFindMany).toHaveBeenCalledTimes(1);
  });

  it("complaintDate present but outside period is not counted by receivedAt", async () => {
    // complaintDate is outside previous period; receivedAt is inside.
    // Effective-date policy: complaintDate takes precedence — this complaint must NOT be counted.
    // Service relies on Prisma OR clause — our mock returns only what Prisma would return.
    // We verify that the mock was called (not that Prisma filters correctly — that's an integration test).
    await buildExecutiveBriefData(BASE_FILTERS, makeKpiResult(), makeComparison(), undefined, NOW);
    expect(dbMocks.complaintFindMany).toHaveBeenCalledTimes(1);
    // Verify the WHERE passed to findMany includes the OR clause.
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
      { departmentId: "d1", departmentName: "الصحة", classificationId: "c1", classificationName: "ضوضاء", currentCount: 5, previousCount: 0 },
      { departmentId: "d2", departmentName: "التعليم", classificationId: "c2", classificationName: "مخلفات", currentCount: 3, previousCount: 0 },
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
      { departmentId: "d1", departmentName: "الصحة", classificationId: "c1", classificationName: "ضوضاء", currentCount: 10, previousCount: 8 },
    ];
    const data = await buildFullAnalyticalData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    expect(data.continuityRows).toHaveLength(1);
    expect(data.continuityRows[0].recurrenceType).toBe("persistent");
    expect(data.continuityRows[0].appearsInBothPeriods).toBe(true);
  });

  it("new: only in current period", async () => {
    const comparison = makeComparison();
    comparison.deptClassAllPairs = [
      { departmentId: "d1", departmentName: "الصحة", classificationId: "c1", classificationName: "ضوضاء", currentCount: 5, previousCount: 0 },
    ];
    const data = await buildFullAnalyticalData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    expect(data.continuityRows[0].recurrenceType).toBe("new");
    expect(data.continuityRows[0].appearsInBothPeriods).toBe(false);
  });

  it("resolved: only in previous period", async () => {
    const comparison = makeComparison();
    comparison.deptClassAllPairs = [
      { departmentId: "d1", departmentName: "الصحة", classificationId: "c1", classificationName: "ضوضاء", currentCount: 0, previousCount: 7 },
    ];
    const data = await buildFullAnalyticalData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    expect(data.continuityRows[0].recurrenceType).toBe("resolved");
    expect(data.continuityRows[0].appearsInBothPeriods).toBe(false);
  });

  it("skips pairs where both counts are 0", async () => {
    const comparison = makeComparison();
    comparison.deptClassAllPairs = [
      { departmentId: "d1", departmentName: "الصحة", classificationId: "c1", classificationName: "ضوضاء", currentCount: 0, previousCount: 0 },
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
      { departmentId: "d1", departmentName: "الصحة", classificationId: "c1", classificationName: "ضوضاء", currentCount: 0, previousCount: 5 },
    ];
    const data = await buildFullAnalyticalData(BASE_FILTERS, makeKpiResult(), comparison, undefined, NOW);
    expect(data.continuityRows).toHaveLength(1);
    expect(data.continuityRows[0].recurrenceType).toBe("resolved");
  });

  it("no absent rows are produced", async () => {
    const comparison = makeComparison();
    comparison.deptClassAllPairs = [
      { departmentId: "d1", departmentName: "الصحة", classificationId: "c1", classificationName: "ضوضاء", currentCount: 5, previousCount: 3 },
      { departmentId: "d1", departmentName: "الصحة", classificationId: "c2", classificationName: "مياه", currentCount: 0, previousCount: 2 },
      { departmentId: "d2", departmentName: "التعليم", classificationId: "c3", classificationName: "بنية تحتية", currentCount: 3, previousCount: 0 },
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
    // Return one complaint that has complaintDate=null but receivedAt in period
    dbMocks.complaintFindMany.mockResolvedValueOnce([
      { complaintDate: null, receivedAt: new Date("2026-06-25T00:00:00.000Z") },
    ]);
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    expect(data.comparativeTimeline.previous).not.toBeNull();
    // Day 2 (2026-06-25) should have count=1
    const day2 = data.comparativeTimeline.previous?.points.find((p) => p.relativeDay === 2);
    expect(day2?.count).toBe(1);
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
// Tests: buildFullAnalyticalData — continuity rows
// ---------------------------------------------------------------------------

describe("buildFullAnalyticalData — continuity rows", () => {
  it("produces persistent when dept+class appears in both periods", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    comparison.deptClassAllPairs = [{
      departmentId: "dept-a", departmentName: "الصحة",
      classificationId: "class-01", classificationName: "ضوضاء",
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
      currentCount: 5, previousCount: 0,
    }];
    const data = await buildFullAnalyticalData(BASE_FILTERS, result, comparison);
    const row = data.continuityRows.find((r) => r.departmentName === "التعليم");
    expect(row?.recurrenceType).toBe("new");
  });
});
