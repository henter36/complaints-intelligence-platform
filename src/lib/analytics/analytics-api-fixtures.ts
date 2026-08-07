/**
 * Test-only fixture builders for the /api/dashboard and /api/analytics
 * response contract. Shared between analytics-api-contract.test.ts and
 * analytics.test.tsx so both suites build well-formed payloads from one
 * definition instead of maintaining two copies of the same shape.
 *
 * Not imported by any production module — safe to keep test-focused
 * ergonomics here (Partial<> overrides, permissive defaults) without
 * affecting the runtime bundle.
 */

import type {
  AnalyticsAnomalyItem,
  AnalyticsData,
  CoreDistributions,
  DashboardData,
  DashboardDistributions,
  NameCountItem,
} from "./analytics-api-contract";

function nameCountItem(name: string, count: number): NameCountItem {
  return { name, count };
}

export function makeCoreDistributions(overrides: Partial<CoreDistributions> = {}): CoreDistributions {
  return {
    byRegion: [nameCountItem("الرياض", 10)],
    byDepartment: [nameCountItem("الطوارئ", 10)],
    byClassification: [nameCountItem("الخدمة", 10)],
    byChannel: [nameCountItem("هاتف", 10)],
    ...overrides,
  };
}

export function makeDashboardDistributions(
  overrides: Partial<DashboardDistributions> = {}
): DashboardDistributions {
  return {
    ...makeCoreDistributions(),
    byStatus: [nameCountItem("open", 3)],
    byPriority: [nameCountItem("critical", 1)],
    bySeverity: [nameCountItem("critical", 1)],
    ...overrides,
  };
}

export function makeAnomalyItem(overrides: Partial<AnalyticsAnomalyItem> = {}): AnalyticsAnomalyItem {
  return {
    name: "الرياض",
    count: 10,
    average: 5,
    deviation: 20,
    isAnomaly: false,
    ...overrides,
  };
}

export function makeDashboardData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    volume: {
      total: 10, open: 3, inProgress: 2, closed: 5,
      reopened: 0, rejected: 0, late: 1, repeated: 0,
      validated: 8, notValidated: 2, potentialDuplicates: 0,
    },
    performance: {
      closureRate: 50, onTimeRate: 75, lateRate: 10,
      avgFirstResponseHours: 2, avgProcessingHours: 4, avgOpenAgeHours: 6,
      overdueNoAction: 0, overdueNoActionRate: 0, reopenRate: 0,
      validityRate: 100, avgSatisfaction: 4, satisfactionRate: 80,
    },
    trend: {
      previousTotal: 8,
      growthRate: 5,
      trendData: [{ date: "2026-07-29", total: 10, closed: 5 }],
    },
    distributions: makeDashboardDistributions(),
    alerts: {
      criticalComplaints: 0, lateCritical: 0, missingFields: 0, dataQualityRate: 100,
    },
    ...overrides,
  };
}

export function makeAnalyticsData(overrides: Partial<AnalyticsData> = {}): AnalyticsData {
  return {
    crossTabs: {
      classifications: [], regions: [], departments: [],
      classificationByRegion: [], classificationByDepartment: [],
    },
    channelEffectiveness: [],
    delayReasons: [],
    recurringSubjects: [],
    recurringClassifications: [],
    anomalies: { regions: [], departments: [], classifications: [] },
    previousDistributions: null,
    regionPriorityBreakdown: [],
    totalCount: 10,
    ...overrides,
  };
}
