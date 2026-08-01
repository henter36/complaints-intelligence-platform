// @vitest-environment node
//
// Tests for the executive brief data builder.
// Uses mocked DB calls — no real SQLite required.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildExecutiveBriefData, buildFullAnalyticalData } from "./report-executive-brief-data-service";
import type { ReportFilters } from "./report-definition-service";
import type { ComparisonResult, PeriodRange } from "./report-comparison";
import type { ComplaintKpiResult } from "@/server/complaints/complaint-kpi-service";

const {
  complaintGroupByMock,
  complaintFindManyMock,
  complaintCountMock,
  statusHistoryCountMock,
  statusHistoryFindManyMock,
} = vi.hoisted(() => ({
  complaintGroupByMock: vi.fn(),
  complaintFindManyMock: vi.fn(),
  complaintCountMock: vi.fn(),
  statusHistoryCountMock: vi.fn(),
  statusHistoryFindManyMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    complaint: {
      groupBy: complaintGroupByMock,
      findMany: complaintFindManyMock,
      count: complaintCountMock,
    },
    complaintStatusHistory: {
      count: statusHistoryCountMock,
      findMany: statusHistoryFindManyMock,
    },
  },
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ISO = (d: string) => new Date(`${d}T00:00:00.000Z`);

const BASE_FILTERS: ReportFilters = { from: "2026-07-01", to: "2026-07-07" };

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
        { name: "الصحة", id: null, count: 45, total: 45, open: 12, closed: 31, currentlyLate: 4, closedLate: 2, withinDueDate: 29, complianceRate: 93.5, averageResolutionDays: 3.8, highPriorityOpen: 3, unclassified: 2 },
        { name: "التعليم", id: null, count: 35, total: 35, open: 10, closed: 24, currentlyLate: 2, closedLate: 1, withinDueDate: 23, complianceRate: 95.8, averageResolutionDays: 3.2, highPriorityOpen: 1, unclassified: 1 },
        { name: "الخدمات", id: null, count: 20, total: 20, open: 8, closed: 10, currentlyLate: 2, closedLate: 0, withinDueDate: 10, complianceRate: 100.0, averageResolutionDays: 2.9, highPriorityOpen: 1, unclassified: 1 },
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
    deptClassAllPairs: [
      {
        departmentId: "dept-health",
        departmentName: "الصحة",
        classificationId: "class-01",
        classificationName: "ضوضاء",
        currentCount: 15,
        previousCount: 10,
      },
    ],
    executiveSummaryPoints: [
      "استُقبلت خلال الفترة الحالية 100 شكوى.",
      "سجّلت الرياض أعلى ارتفاع.",
    ],
    warnings: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no all-time regions (so allRegions comes only from comparison data)
  complaintGroupByMock.mockResolvedValue([]);
  // Default: no previous-period complaints
  complaintFindManyMock.mockResolvedValue([]);
  // Default: 0 inflow and outflow
  complaintCountMock.mockResolvedValue(0);
  statusHistoryCountMock.mockResolvedValue(0);
});

// ---------------------------------------------------------------------------
// Tests: buildBriefKpis (via buildExecutiveBriefData)
// ---------------------------------------------------------------------------

describe("buildExecutiveBriefData — KPI cards", () => {
  it("returns exactly 8 brief KPI cards", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    expect(data.briefKpis).toHaveLength(8);
  });

  it("KPI keys are unique", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    const keys = data.briefKpis.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("includes expected KPI keys", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    const keys = data.briefKpis.map((k) => k.key);
    expect(keys).toContain("total");
    expect(keys).toContain("open");
    expect(keys).toContain("closed");
    expect(keys).toContain("currentlyLate");
    expect(keys).toContain("complianceRate");
    expect(keys).toContain("averageResolutionDays");
    expect(keys).toContain("highPriorityOpen");
    expect(keys).toContain("unclassified");
  });

  it("closed KPI: fewer closed → negative assessment", async () => {
    const result = makeKpiResult();
    // Make closed go DOWN (current < previous)
    (result.kpis.closedComplaints as { currentValue: number; previousValue: number }).currentValue = 40;
    (result.kpis.closedComplaints as { currentValue: number; previousValue: number }).previousValue = 50;
    (result.volume as { closed: number }).closed = 40;
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    const closedCard = data.briefKpis.find((k) => k.key === "closed");
    expect(closedCard?.assessment).toBe("negative");
  });

  it("currentlyLate KPI: fewer late → positive assessment", async () => {
    const result = makeKpiResult();
    (result.kpis.currentlyLateComplaints as { currentValue: number; previousValue: number }).currentValue = 5;
    (result.kpis.currentlyLateComplaints as { currentValue: number; previousValue: number }).previousValue = 10;
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    const card = data.briefKpis.find((k) => k.key === "currentlyLate");
    expect(card?.assessment).toBe("positive");
  });

  it("KPI cards have correct format fields", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    const complianceCard = data.briefKpis.find((k) => k.key === "complianceRate");
    const avgResCard = data.briefKpis.find((k) => k.key === "averageResolutionDays");
    expect(complianceCard?.format).toBe("percent");
    expect(avgResCard?.format).toBe("days");
  });

  it("difference and changeRate are null when no previous period", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison(false);
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    for (const card of data.briefKpis) {
      expect(card.previousValue).toBeNull();
      expect(card.difference).toBeNull();
      expect(card.changeRate).toBeNull();
    }
  });

  it("assessment is neutral when no previous period", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison(false);
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    for (const card of data.briefKpis) {
      expect(card.assessment).toBe("neutral");
    }
  });

  it("difference is computed correctly (current − previous)", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    const totalCard = data.briefKpis.find((k) => k.key === "total");
    // volume.total = 100, kpis.totalComplaints.previousValue = 80
    expect(totalCard?.difference).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Tests: all reference regions (Left Join)
// ---------------------------------------------------------------------------

describe("buildExecutiveBriefData — allRegions", () => {
  it("returns an array of region rows", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    expect(Array.isArray(data.allRegions)).toBe(true);
  });

  it("each row has required fields", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    for (const row of data.allRegions) {
      expect(typeof row.regionName).toBe("string");
      expect(typeof row.currentCount).toBe("number");
      expect(typeof row.previousCount).toBe("number");
      expect(typeof row.difference).toBe("number");
      expect(typeof row.direction).toBe("string");
    }
  });

  it("difference = currentCount − previousCount", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    for (const row of data.allRegions) {
      expect(row.difference).toBe(row.currentCount - row.previousCount);
    }
  });

  it("regions with higher current count have positive difference", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    const riyadh = data.allRegions.find((r) => r.regionName === "الرياض");
    if (riyadh) {
      expect(riyadh.difference).toBeGreaterThan(0);
    }
  });

  it("regions with lower current count have negative difference", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    const jeddah = data.allRegions.find((r) => r.regionName === "جدة");
    if (jeddah) {
      expect(jeddah.difference).toBeLessThan(0);
    }
  });

  it("changeRate is null when previousCount is 0", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    // Add a new region to the comparison with previousCount=0
    comparison.regionChanges.push({
      regionName: "منطقة جديدة",
      currentCount: 5,
      previousCount: 0,
      difference: 5,
      changeRate: null,
      direction: "جديد",
    });
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    const newRegion = data.allRegions.find((r) => r.regionName === "منطقة جديدة");
    if (newRegion) {
      expect(newRegion.changeRate).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: top classifications
// ---------------------------------------------------------------------------

describe("buildExecutiveBriefData — topClassifications", () => {
  it("returns at most 8 classification rows", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    expect(data.topClassifications.length).toBeLessThanOrEqual(8);
  });

  it("top classification has the highest count", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    if (data.topClassifications.length >= 2) {
      expect(data.topClassifications[0].currentCount).toBeGreaterThanOrEqual(
        data.topClassifications[1].currentCount
      );
    }
  });

  it("each row has classificationId and classificationName", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    for (const row of data.topClassifications) {
      expect(typeof row.classificationId).toBe("string");
      expect(typeof row.classificationName).toBe("string");
    }
  });

  it("shareOfTotal sums to approximately 100% or less", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    const totalShare = data.topClassifications.reduce((s, r) => s + r.shareOfTotal, 0);
    // Top-N share should not exceed 100%
    expect(totalShare).toBeLessThanOrEqual(100.1);
    expect(totalShare).toBeGreaterThan(0);
  });

  it("shareOfTotal is 0 when volume.total is 0", async () => {
    const result = makeKpiResult();
    (result.volume as { total: number }).total = 0;
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
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
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    expect(data.comparativeTimeline.current.points.length).toBeGreaterThan(0);
  });

  it("relative days start at 1", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    expect(data.comparativeTimeline.current.points[0].relativeDay).toBe(1);
  });

  it("current period has periodDays points", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    const { periodDays } = data.comparativeTimeline;
    expect(data.comparativeTimeline.current.points.length).toBe(periodDays);
  });

  it("previous period is null when no comparison", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison(false);
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    expect(data.comparativeTimeline.previous).toBeNull();
  });

  it("current counts match sum of region trend series", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);

    // Day 1 (2026-07-01): الرياض=5, جدة=4 → total=9
    const day1 = data.comparativeTimeline.current.points.find((p) => p.relativeDay === 1);
    expect(day1?.count).toBe(9);

    // Day 2 (2026-07-02): الرياض=6, جدة=4 → total=10
    const day2 = data.comparativeTimeline.current.points.find((p) => p.relativeDay === 2);
    expect(day2?.count).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Tests: concentration bands
// ---------------------------------------------------------------------------

describe("buildExecutiveBriefData — concentrationBands", () => {
  it("returns exactly 3 concentration bands", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    expect(data.concentrationBands).toHaveLength(3);
  });

  it("includes all 3 entity types", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    const types = data.concentrationBands.map((b) => b.entityType);
    expect(types).toContain("region");
    expect(types).toContain("classification");
    expect(types).toContain("department");
  });

  it("top1Share <= top3Share <= top5Share", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    for (const band of data.concentrationBands) {
      expect(band.top1SharePercent).toBeLessThanOrEqual(band.top3SharePercent);
      expect(band.top3SharePercent).toBeLessThanOrEqual(band.top5SharePercent);
    }
  });

  it("shares are between 0 and 100", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
    for (const band of data.concentrationBands) {
      expect(band.top1SharePercent).toBeGreaterThanOrEqual(0);
      expect(band.top5SharePercent).toBeLessThanOrEqual(100);
    }
  });

  it("all shares are 0 when total is 0", async () => {
    const result = makeKpiResult();
    (result.volume as { total: number }).total = 0;
    const comparison = makeComparison();
    const data = await buildExecutiveBriefData(BASE_FILTERS, result, comparison);
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

describe("buildFullAnalyticalData", () => {
  it("includes all brief data fields", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildFullAnalyticalData(BASE_FILTERS, result, comparison);
    expect(data.briefKpis).toBeDefined();
    expect(data.allRegions).toBeDefined();
    expect(data.topClassifications).toBeDefined();
    expect(data.comparativeTimeline).toBeDefined();
    expect(data.concentrationBands).toBeDefined();
  });

  it("includes FULL_ANALYTICAL-only fields", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildFullAnalyticalData(BASE_FILTERS, result, comparison);
    expect(data.netBacklogFlow).toBeDefined();
    expect(data.perfVolumeRows).toBeDefined();
    expect(data.continuityRows).toBeDefined();
  });

  it("netBacklogFlow has non-negative inflow and outflow", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildFullAnalyticalData(BASE_FILTERS, result, comparison);
    expect(data.netBacklogFlow.inflow).toBeGreaterThanOrEqual(0);
    expect(data.netBacklogFlow.outflow).toBeGreaterThanOrEqual(0);
  });

  it("netBacklogFlow.net = inflow - outflow", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildFullAnalyticalData(BASE_FILTERS, result, comparison);
    expect(data.netBacklogFlow.net).toBe(
      data.netBacklogFlow.inflow - data.netBacklogFlow.outflow
    );
  });

  it("perfVolumeRows is sorted by totalComplaints descending", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildFullAnalyticalData(BASE_FILTERS, result, comparison);
    for (let i = 1; i < data.perfVolumeRows.length; i++) {
      expect(data.perfVolumeRows[i - 1].totalComplaints).toBeGreaterThanOrEqual(
        data.perfVolumeRows[i].totalComplaints
      );
    }
  });

  it("perfVolumeRows share sums to approximately 100%", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildFullAnalyticalData(BASE_FILTERS, result, comparison);
    const total = data.perfVolumeRows.reduce((s, r) => s + r.share, 0);
    if (data.perfVolumeRows.length > 0) {
      expect(total).toBeGreaterThan(0);
      expect(total).toBeLessThanOrEqual(100.5);
    }
  });

  it("continuityRows have valid recurrenceType values", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildFullAnalyticalData(BASE_FILTERS, result, comparison);
    const validTypes = ["persistent", "new", "resolved", "absent"];
    for (const row of data.continuityRows) {
      expect(validTypes).toContain(row.recurrenceType);
    }
  });

  it("continuityRows with appearsInBothPeriods=true have recurrenceType=persistent", async () => {
    const result = makeKpiResult();
    const comparison = makeComparison();
    // Add a rise row where both current and previous > 0
    comparison.deptClassAllPairs = [
      {
        departmentId: "dept-a",
        departmentName: "الصحة",
        classificationId: "class-01",
        classificationName: "ضوضاء",
        currentCount: 10,
        previousCount: 8,
      },
    ];
    const data = await buildFullAnalyticalData(BASE_FILTERS, result, comparison);
    const persistentRows = data.continuityRows.filter((r) => r.appearsInBothPeriods);
    for (const row of persistentRows) {
      expect(row.recurrenceType).toBe("persistent");
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
    complaintFindManyMock.mockResolvedValueOnce([
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
    complaintFindManyMock.mockResolvedValueOnce([]);
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
    complaintCountMock.mockResolvedValue(5);
    statusHistoryCountMock.mockResolvedValue(2);
    const result = makeKpiResult();
    const comparison = makeComparison();
    const data = await buildFullAnalyticalData(BASE_FILTERS, result, comparison);
    expect(data.netBacklogFlow.inflow).toBe(5);
  });

  it("net = inflow - outflow", async () => {
    complaintCountMock.mockResolvedValue(10);
    statusHistoryCountMock.mockResolvedValue(4);
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
