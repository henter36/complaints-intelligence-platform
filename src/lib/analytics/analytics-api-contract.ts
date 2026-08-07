/**
 * Response contract for /api/dashboard and /api/analytics as consumed by the
 * Analytics screen. A failed HTTP response (auth error, validation error,
 * unhandled exception) never satisfies these shapes — callers must check
 * `response.ok` and validate the parsed payload before treating it as real
 * dashboard/analytics data, so an `{ error: { code, message } }` body is
 * never mistaken for `DashboardData`/`AnalyticsData`, and a well-formed 200
 * body that is missing fields the UI relies on is never mistaken for it
 * either.
 */

import { isAbortError } from "@/lib/abort";

export type NameCountItem = {
  name: string;
  count: number;
};

export type CoreDistributions = {
  byRegion: NameCountItem[];
  byDepartment: NameCountItem[];
  byClassification: NameCountItem[];
  byChannel: NameCountItem[];
};

export type DashboardDistributions = CoreDistributions & {
  byStatus: NameCountItem[];
  byPriority: NameCountItem[];
  bySeverity: NameCountItem[];
};

export type AnalyticsAnomalyItem = NameCountItem & {
  average: number;
  deviation: number;
  isAnomaly: boolean;
};

export type CrossTabRow = Record<string, number | string>;

export interface DashboardData {
  volume: {
    total: number; open: number; inProgress: number; closed: number;
    reopened: number; rejected: number; late: number; repeated: number;
    validated: number; notValidated: number; potentialDuplicates: number;
  };
  performance: {
    closureRate: number; onTimeRate: number | null; lateRate: number;
    avgFirstResponseHours: number; avgProcessingHours: number; avgOpenAgeHours: number;
    overdueNoAction: number; overdueNoActionRate: number; reopenRate: number;
    validityRate: number; avgSatisfaction: number; satisfactionRate: number;
  };
  trend: {
    previousTotal: number | null; growthRate: number | null;
    trendData: { date: string; total: number; closed: number }[];
  };
  distributions: DashboardDistributions;
  alerts: {
    criticalComplaints: number; lateCritical: number;
    missingFields: number; dataQualityRate: number;
  };
}

export interface AnalyticsData {
  crossTabs: {
    classifications: string[];
    regions: string[];
    departments: string[];
    classificationByRegion: CrossTabRow[];
    classificationByDepartment: CrossTabRow[];
  };
  channelEffectiveness: {
    channel: string; total: number; closed: number;
    closureRate: number; lateRate: number; avgProcessingHours: number;
  }[];
  delayReasons: NameCountItem[];
  recurringSubjects: NameCountItem[];
  recurringClassifications: NameCountItem[];
  anomalies: {
    regions: AnalyticsAnomalyItem[];
    departments: AnalyticsAnomalyItem[];
    classifications: NameCountItem[];
  };
  previousDistributions: CoreDistributions | null;
  regionPriorityBreakdown: CrossTabRow[];
  totalCount: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses the response body as JSON without throwing a raw SyntaxError past
 * the caller. An AbortError thrown while the body is still being read (the
 * request was cancelled after headers arrived) is rethrown as-is — it must
 * keep failing `isAbortError` checks upstream so a cancelled request is
 * treated as a cancellation, not as a user-facing load failure.
 */
export async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new Error("أعاد الخادم استجابة غير صالحة.", { cause: error });
  }
}

/** Extracts `error.message` from an API error payload, falling back when the shape doesn't match. */
export function apiErrorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) {
    return fallback;
  }

  const error = payload.error;
  if (!isRecord(error)) {
    return fallback;
  }

  if (typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

export function isNameCountItem(value: unknown): value is NameCountItem {
  return (
    isRecord(value)
    && typeof value.name === "string"
    && typeof value.count === "number"
    && Number.isFinite(value.count)
  );
}

export function isNameCountArray(value: unknown): value is NameCountItem[] {
  return Array.isArray(value) && value.every(isNameCountItem);
}

function isAnalyticsAnomalyItem(value: unknown): value is AnalyticsAnomalyItem {
  return (
    isRecord(value)
    && typeof value.name === "string"
    && typeof value.count === "number"
    && Number.isFinite(value.count)
    && typeof value.average === "number"
    && typeof value.deviation === "number"
    && typeof value.isAnomaly === "boolean"
  );
}

function isAnomalyArray(value: unknown): value is AnalyticsAnomalyItem[] {
  return Array.isArray(value) && value.every(isAnalyticsAnomalyItem);
}

const CORE_DISTRIBUTION_KEYS = ["byRegion", "byDepartment", "byClassification", "byChannel"] as const;
const DASHBOARD_DISTRIBUTION_KEYS = [...CORE_DISTRIBUTION_KEYS, "byStatus", "byPriority", "bySeverity"] as const;

function hasValidDistributionArrays(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => isNameCountArray(record[key]));
}

function isDistributionRecord(value: unknown, keys: readonly string[]): value is CoreDistributions {
  return isRecord(value) && hasValidDistributionArrays(value, keys);
}

export function isDashboardData(value: unknown): value is DashboardData {
  if (!isRecord(value)) return false;
  if (!isRecord(value.volume)) return false;
  if (!isRecord(value.performance)) return false;
  if (!isRecord(value.trend)) return false;

  const growthRate = value.trend.growthRate;
  if (typeof growthRate !== "number" && growthRate !== null) return false;
  if (!Array.isArray(value.trend.trendData)) return false;

  if (!isDistributionRecord(value.distributions, DASHBOARD_DISTRIBUTION_KEYS)) return false;
  if (!isRecord(value.alerts)) return false;

  return true;
}

export function isAnalyticsData(value: unknown): value is AnalyticsData {
  if (!isRecord(value)) return false;

  if (!isRecord(value.crossTabs)) return false;
  if (!isStringArray(value.crossTabs.classifications)) return false;
  if (!isStringArray(value.crossTabs.regions)) return false;
  if (!isStringArray(value.crossTabs.departments)) return false;
  if (!Array.isArray(value.crossTabs.classificationByRegion)) return false;
  if (!Array.isArray(value.crossTabs.classificationByDepartment)) return false;

  if (!Array.isArray(value.channelEffectiveness)) return false;
  if (!Array.isArray(value.delayReasons)) return false;
  if (!Array.isArray(value.recurringSubjects)) return false;
  if (!Array.isArray(value.recurringClassifications)) return false;
  if (!Array.isArray(value.regionPriorityBreakdown)) return false;

  if (!isRecord(value.anomalies)) return false;
  if (!isAnomalyArray(value.anomalies.regions)) return false;
  if (!isAnomalyArray(value.anomalies.departments)) return false;
  if (!isNameCountArray(value.anomalies.classifications)) return false;

  if (
    value.previousDistributions !== null
    && !isDistributionRecord(value.previousDistributions, CORE_DISTRIBUTION_KEYS)
  ) {
    return false;
  }

  return true;
}
