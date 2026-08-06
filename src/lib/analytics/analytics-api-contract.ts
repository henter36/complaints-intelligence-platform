/**
 * Response contract for /api/dashboard and /api/analytics as consumed by the
 * Analytics screen. A failed HTTP response (auth error, validation error,
 * unhandled exception) never satisfies these shapes — callers must check
 * `response.ok` and validate the parsed payload before treating it as real
 * dashboard/analytics data, so an `{ error: { code, message } }` body is
 * never mistaken for `DashboardData`/`AnalyticsData`.
 */

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
  distributions: {
    byRegion: { name: string; count: number }[];
    byDepartment: { name: string; count: number }[];
    byClassification: { name: string; count: number }[];
    byChannel: { name: string; count: number }[];
    byStatus: { name: string; count: number }[];
    byPriority: { name: string; count: number }[];
    bySeverity: { name: string; count: number }[];
  };
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
    classificationByRegion: Record<string, number | string>[];
    classificationByDepartment: Record<string, number | string>[];
  };
  channelEffectiveness: {
    channel: string; total: number; closed: number;
    closureRate: number; lateRate: number; avgProcessingHours: number;
  }[];
  delayReasons: { name: string; count: number }[];
  recurringSubjects: { name: string; count: number }[];
  recurringClassifications: { name: string; count: number }[];
  anomalies: {
    regions: { name: string; count: number; average: number; deviation: number; isAnomaly: boolean }[];
    departments: { name: string; count: number; average: number; deviation: number; isAnomaly: boolean }[];
    classifications: { name: string; count: number }[];
  };
  previousDistributions: {
    byRegion: { name: string; count: number }[];
    byDepartment: { name: string; count: number }[];
    byClassification: { name: string; count: number }[];
    byChannel: { name: string; count: number }[];
  } | null;
  regionPriorityBreakdown: Record<string, number | string>[];
  totalCount: number;
}

export type ApiErrorPayload = {
  error?: {
    code?: string;
    message?: string;
  };
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses the response body as JSON without throwing a raw SyntaxError past the caller. */
export async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("أعاد الخادم استجابة غير صالحة.");
  }
}

/** Extracts `error.message` from an API error payload, falling back when the shape doesn't match. */
export function apiErrorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) {
    return fallback;
  }

  const error = (payload as ApiErrorPayload).error;
  if (!isRecord(error)) {
    return fallback;
  }

  if (typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

export function isDashboardData(value: unknown): value is DashboardData {
  if (!isRecord(value)) return false;
  if (!isRecord(value.volume)) return false;
  if (!isRecord(value.performance)) return false;
  if (!isRecord(value.trend)) return false;

  const growthRate = value.trend.growthRate;
  if (typeof growthRate !== "number" && growthRate !== null) return false;
  if (!Array.isArray(value.trend.trendData)) return false;

  if (!isRecord(value.distributions)) return false;
  if (!isRecord(value.alerts)) return false;

  return true;
}

export function isAnalyticsData(value: unknown): value is AnalyticsData {
  if (!isRecord(value)) return false;
  if (!isRecord(value.crossTabs)) return false;
  if (!Array.isArray(value.channelEffectiveness)) return false;
  if (!Array.isArray(value.delayReasons)) return false;
  if (!Array.isArray(value.recurringSubjects)) return false;
  if (!Array.isArray(value.recurringClassifications)) return false;
  if (!isRecord(value.anomalies)) return false;
  if (!Array.isArray(value.regionPriorityBreakdown)) return false;

  return true;
}
