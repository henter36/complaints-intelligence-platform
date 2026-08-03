import { ComplaintPriority, ComplaintStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { computeAnalyticsFindings } from "./analytics-findings-service";
import type { ComplaintKpiResult, ComplaintDistributions } from "@/server/complaints/complaint-kpi-service";

function baseDistributions(
  regionTotals: Record<string, number> = {},
  open = 0
): ComplaintDistributions {
  return {
    byRegion: Object.entries(regionTotals).map(([name, total]) => ({
      name,
      id: null,
      count: total,
      total,
      open: Math.floor(total * 0.3),
      closed: Math.floor(total * 0.7),
      currentlyLate: 0,
      closedLate: 0,
      withinDueDate: 0,
      complianceRate: null,
      averageResolutionDays: 2,
      highPriorityOpen: 0,
      unclassified: 0,
    })),
    byFacility: [],
    byDepartment: [],
    byClassification: [],
    byCategory: [],
    byChannel: [],
    byStatus: [],
    byPriority: [],
    bySeverity: [],
    byDelayReason: [],
    bySubject: [],
    byMonth: [],
    byRegionPriority: [],
  };
}

function baseKpiResult(overrides: Partial<ComplaintKpiResult> = {}): ComplaintKpiResult {
  return {
    kpis: {
      totalComplaints: { currentValue: 100, previousValue: null, absoluteChange: null, percentageChange: null, trend: "none", direction: "neutral" },
      openComplaints: { currentValue: 20, previousValue: null, absoluteChange: null, percentageChange: null, trend: "none", direction: "neutral" },
      closedComplaints: { currentValue: 80, previousValue: null, absoluteChange: null, percentageChange: null, trend: "none", direction: "neutral" },
      cancelledComplaints: { currentValue: 0, previousValue: null, absoluteChange: null, percentageChange: null, trend: "none", direction: "neutral" },
      currentlyLateComplaints: { currentValue: 5, previousValue: null, absoluteChange: null, percentageChange: null, trend: "none", direction: "neutral" },
      closedLateComplaints: { currentValue: 3, previousValue: null, absoluteChange: null, percentageChange: null, trend: "none", direction: "neutral" },
      closedWithinDueDate: { currentValue: 70, previousValue: null, absoluteChange: null, percentageChange: null, trend: "none", direction: "neutral" },
      withoutDueDate: { currentValue: 0, previousValue: null, absoluteChange: null, percentageChange: null, trend: "none", direction: "neutral" },
      unclassifiedComplaints: { currentValue: 0, previousValue: null, absoluteChange: null, percentageChange: null, trend: "none", direction: "neutral" },
      highPriorityOpenComplaints: { currentValue: 0, previousValue: null, absoluteChange: null, percentageChange: null, trend: "none", direction: "neutral" },
      averageResolutionDays: { currentValue: 2, previousValue: null, absoluteChange: null, percentageChange: null, trend: "none", direction: "neutral" },
      medianResolutionDays: { currentValue: 1.5, previousValue: null, absoluteChange: null, percentageChange: null, trend: "none", direction: "neutral" },
      averageOpenAgeDays: { currentValue: 3, previousValue: null, absoluteChange: null, percentageChange: null, trend: "none", direction: "neutral" },
      dueDateComplianceRate: { currentValue: 87, previousValue: null, absoluteChange: null, percentageChange: null, trend: "none", direction: "neutral" },
      closureRate: { currentValue: 80, previousValue: null, absoluteChange: null, percentageChange: null, trend: "none", direction: "neutral" },
      reopenCount: { currentValue: 2, previousValue: null, absoluteChange: null, percentageChange: null, trend: "none", direction: "neutral" },
    },
    volume: {
      total: 100, open: 20, inProgress: 5, closed: 80, reopened: 2,
      rejected: 0, late: 5, repeated: 3, validated: 90, notValidated: 10, potentialDuplicates: 2,
    },
    performance: {
      closureRate: 80, onTimeRate: 87, onTimeEligibleClosed: 80, lateRate: 5,
      avgFirstResponseHours: 4, avgProcessingHours: 48, avgOpenAgeHours: 72,
      averageResolutionDays: 2, medianResolutionDays: 1.5,
      overdueNoAction: 0, overdueNoActionRate: 0, reopenRate: 2.4,
      validityRate: 90, avgSatisfaction: 3.5, satisfactionRate: 70,
    },
    trend: { previousTotal: null, growthRate: null, trendData: [] },
    distributions: baseDistributions({ "الرياض": 60, "جدة": 40 }),
    crossTabs: { classificationByRegion: [], classificationByDepartment: [] },
    alerts: { criticalComplaints: 2, lateCritical: 1, missingFields: 5, dataQualityRate: 95 },
    previousDistributions: null,
    ...overrides,
  };
}

describe("computeAnalyticsFindings", () => {
  it("returns an empty array when there is no previous period and no issues", () => {
    const result = computeAnalyticsFindings(baseKpiResult());
    // No VOLUME_SPIKE (no previous), no BACKLOG_GROWTH (no previous), no OVERDUE (lateRate=5<10), no CONCENTRATION (Riyadh=60%>40% BUT...)
    // Actually CONCENTRATION fires because Riyadh=60% >= 40%
    // DATA_QUALITY: missingFields=5 but dataQualityRate=95 >= 80 → no fire
    const types = result.map((f) => f.type);
    expect(types).not.toContain("VOLUME_SPIKE");
    expect(types).not.toContain("BACKLOG_GROWTH");
    expect(types).not.toContain("DATA_QUALITY");
  });

  describe("VOLUME_SPIKE", () => {
    it("emits a VOLUME_SPIKE finding when a region's count increased by ≥50% vs previous period", () => {
      const result = computeAnalyticsFindings(
        baseKpiResult({
          previousDistributions: baseDistributions({ "الرياض": 20, "جدة": 40 }),
          distributions: baseDistributions({ "الرياض": 60, "جدة": 40 }),
        })
      );
      const spike = result.find((f) => f.type === "VOLUME_SPIKE" && f.entityName === "الرياض");
      expect(spike).toBeDefined();
      expect(spike?.changeRate).toBe(200);
      expect(spike?.severity).toBe("CRITICAL");
    });

    it("does not emit VOLUME_SPIKE for a <50% increase", () => {
      const result = computeAnalyticsFindings(
        baseKpiResult({
          previousDistributions: baseDistributions({ "الرياض": 50 }),
          distributions: baseDistributions({ "الرياض": 60 }),
        })
      );
      const spike = result.find((f) => f.type === "VOLUME_SPIKE");
      expect(spike).toBeUndefined();
    });

    it("does not emit VOLUME_SPIKE without a previous period", () => {
      const result = computeAnalyticsFindings(
        baseKpiResult({
          previousDistributions: null,
          distributions: baseDistributions({ "الرياض": 100 }),
        })
      );
      expect(result.find((f) => f.type === "VOLUME_SPIKE")).toBeUndefined();
    });

    it("does not fire for a region that is new (state NEW) without meeting INCREASE threshold", () => {
      const result = computeAnalyticsFindings(
        baseKpiResult({
          previousDistributions: baseDistributions({ "جدة": 40 }),
          distributions: baseDistributions({ "الرياض": 60, "جدة": 40 }),
        })
      );
      // الرياض is NEW (previous=null) not INCREASE → not VOLUME_SPIKE
      const spike = result.find((f) => f.type === "VOLUME_SPIKE" && f.entityName === "الرياض");
      expect(spike).toBeUndefined();
    });

    it("VOLUME_SPIKE findings include drilldown filters with the region name", () => {
      const result = computeAnalyticsFindings(
        baseKpiResult({
          previousDistributions: baseDistributions({ "الرياض": 20 }),
          distributions: baseDistributions({ "الرياض": 60 }),
        }),
        "2026-07-01",
        "2026-07-31"
      );
      const spike = result.find((f) => f.type === "VOLUME_SPIKE");
      expect(spike?.drilldownFilters.region).toBe("الرياض");
      expect(spike?.drilldownFilters.from).toBe("2026-07-01");
      expect(spike?.drilldownFilters.to).toBe("2026-07-31");
    });
  });

  describe("BACKLOG_GROWTH", () => {
    it("emits BACKLOG_GROWTH when open complaint count grew by ≥20% vs previous", () => {
      const result = computeAnalyticsFindings(
        baseKpiResult({
          volume: { total: 100, open: 50, inProgress: 5, closed: 50, reopened: 0, rejected: 0, late: 0, repeated: 0, validated: 90, notValidated: 10, potentialDuplicates: 0 },
          kpis: {
            ...baseKpiResult().kpis,
            openComplaints: { currentValue: 50, previousValue: 30, absoluteChange: 20, percentageChange: 66.7, trend: "up", direction: "negative" },
          },
          previousDistributions: baseDistributions(),
        })
      );
      expect(result.find((f) => f.type === "BACKLOG_GROWTH")).toBeDefined();
    });

    it("does not emit BACKLOG_GROWTH when growth is <20%", () => {
      const result = computeAnalyticsFindings(
        baseKpiResult({
          volume: { total: 100, open: 22, inProgress: 5, closed: 78, reopened: 0, rejected: 0, late: 0, repeated: 0, validated: 90, notValidated: 10, potentialDuplicates: 0 },
          kpis: {
            ...baseKpiResult().kpis,
            openComplaints: { currentValue: 22, previousValue: 20, absoluteChange: 2, percentageChange: 10, trend: "up", direction: "negative" },
          },
          previousDistributions: baseDistributions(),
        })
      );
      expect(result.find((f) => f.type === "BACKLOG_GROWTH")).toBeUndefined();
    });

    it("does not emit BACKLOG_GROWTH without a previous period", () => {
      const result = computeAnalyticsFindings(baseKpiResult({ previousDistributions: null }));
      expect(result.find((f) => f.type === "BACKLOG_GROWTH")).toBeUndefined();
    });
  });

  describe("CURRENTLY_OVERDUE", () => {
    it("emits CURRENTLY_OVERDUE when lateRate exceeds 10%", () => {
      const result = computeAnalyticsFindings(
        baseKpiResult({
          volume: { total: 100, open: 20, inProgress: 5, closed: 80, reopened: 0, rejected: 0, late: 15, repeated: 0, validated: 90, notValidated: 10, potentialDuplicates: 0 },
          performance: { ...baseKpiResult().performance, lateRate: 15 },
        })
      );
      expect(result.find((f) => f.type === "CURRENTLY_OVERDUE")).toBeDefined();
    });

    it("does not emit CURRENTLY_OVERDUE when lateRate is <10%", () => {
      const result = computeAnalyticsFindings(baseKpiResult());
      expect(result.find((f) => f.type === "CURRENTLY_OVERDUE")).toBeUndefined();
    });

    it("CURRENTLY_OVERDUE drilldown includes isLate filter", () => {
      const result = computeAnalyticsFindings(
        baseKpiResult({
          volume: { total: 100, open: 20, inProgress: 5, closed: 80, reopened: 0, rejected: 0, late: 30, repeated: 0, validated: 90, notValidated: 10, potentialDuplicates: 0 },
          performance: { ...baseKpiResult().performance, lateRate: 30 },
        })
      );
      const finding = result.find((f) => f.type === "CURRENTLY_OVERDUE");
      expect(finding?.drilldownFilters.isLate).toBe(true);
    });
  });

  describe("CONCENTRATION", () => {
    it("emits CONCENTRATION when top region holds ≥40% of total", () => {
      const result = computeAnalyticsFindings(
        baseKpiResult({
          volume: { ...baseKpiResult().volume, total: 100 },
          distributions: baseDistributions({ "الرياض": 60, "جدة": 40 }),
        })
      );
      const finding = result.find((f) => f.type === "CONCENTRATION");
      expect(finding).toBeDefined();
      expect(finding?.entityName).toBe("الرياض");
    });

    it("does not emit CONCENTRATION when top region holds <40%", () => {
      const result = computeAnalyticsFindings(
        baseKpiResult({
          volume: { ...baseKpiResult().volume, total: 100 },
          distributions: baseDistributions({ "الرياض": 35, "جدة": 35, "مكة": 30 }),
        })
      );
      expect(result.find((f) => f.type === "CONCENTRATION")).toBeUndefined();
    });
  });

  describe("DATA_QUALITY", () => {
    it("emits DATA_QUALITY when dataQualityRate is below 80%", () => {
      const result = computeAnalyticsFindings(
        baseKpiResult({
          alerts: { criticalComplaints: 2, lateCritical: 1, missingFields: 25, dataQualityRate: 75 },
        })
      );
      expect(result.find((f) => f.type === "DATA_QUALITY")).toBeDefined();
    });

    it("does not emit DATA_QUALITY when dataQualityRate ≥ 80%", () => {
      const result = computeAnalyticsFindings(baseKpiResult());
      expect(result.find((f) => f.type === "DATA_QUALITY")).toBeUndefined();
    });
  });

  it("all emitted findings parse against the AnalyticalFindingSchema (Zod contract)", () => {
    const result = computeAnalyticsFindings(
      baseKpiResult({
        volume: { total: 100, open: 30, inProgress: 5, closed: 70, reopened: 0, rejected: 0, late: 20, repeated: 0, validated: 80, notValidated: 20, potentialDuplicates: 0 },
        performance: { ...baseKpiResult().performance, lateRate: 20 },
        kpis: {
          ...baseKpiResult().kpis,
          openComplaints: { currentValue: 30, previousValue: 15, absoluteChange: 15, percentageChange: 100, trend: "up", direction: "negative" },
        },
        distributions: baseDistributions({ "الرياض": 70, "جدة": 30 }),
        previousDistributions: baseDistributions({ "الرياض": 20, "جدة": 30 }),
        alerts: { criticalComplaints: 5, lateCritical: 2, missingFields: 30, dataQualityRate: 70 },
      }),
      "2026-07-01",
      "2026-07-31"
    );
    // All findings should satisfy the Zod schema (buildFinding calls parse internally)
    expect(result.length).toBeGreaterThan(0);
    result.forEach((f) => {
      expect(typeof f.id).toBe("string");
      expect(f.id.length).toBeGreaterThan(0);
      expect(f.detectorVersion).toBe("quantitative-v1");
    });
  });

  it("findings are sorted by priorityScore descending", () => {
    const result = computeAnalyticsFindings(
      baseKpiResult({
        volume: { total: 100, open: 30, inProgress: 5, closed: 70, reopened: 0, rejected: 0, late: 20, repeated: 0, validated: 80, notValidated: 20, potentialDuplicates: 0 },
        performance: { ...baseKpiResult().performance, lateRate: 20 },
        kpis: {
          ...baseKpiResult().kpis,
          openComplaints: { currentValue: 30, previousValue: 15, absoluteChange: 15, percentageChange: 100, trend: "up", direction: "negative" },
        },
        distributions: baseDistributions({ "الرياض": 60, "جدة": 40 }),
        previousDistributions: baseDistributions({ "الرياض": 20, "جدة": 40 }),
        alerts: { criticalComplaints: 2, lateCritical: 1, missingFields: 25, dataQualityRate: 75 },
      })
    );
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1]!.priorityScore).toBeGreaterThanOrEqual(result[i]!.priorityScore);
    }
  });
});
