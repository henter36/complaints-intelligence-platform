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
import { AnalyticalFindingSchema, type AnalyticalFinding } from "./analytical-finding";
import type { PeriodChangeDigest } from "./period-change-digest";

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
  findings: AnalyticalFinding[];
  periodChangeDigest: PeriodChangeDigest | null;
  /** The exact periods behind every finding's per-period series — reused for timelines, never requeried (spec §5). */
  patternAnalysisPeriods: { from: string; to: string }[];
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function hasFiniteNumberFields(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => isFiniteNumber(record[key]));
}

export function isNameCountItem(value: unknown): value is NameCountItem {
  return isRecord(value) && typeof value.name === "string" && isFiniteNumber(value.count);
}

export function isNameCountArray(value: unknown): value is NameCountItem[] {
  return Array.isArray(value) && value.every(isNameCountItem);
}

function isAnalyticsAnomalyItem(value: unknown): value is AnalyticsAnomalyItem {
  return (
    isRecord(value)
    && typeof value.name === "string"
    && isFiniteNumber(value.count)
    && isFiniteNumber(value.average)
    && isFiniteNumber(value.deviation)
    && typeof value.isAnomaly === "boolean"
  );
}

function isAnomalyArray(value: unknown): value is AnalyticsAnomalyItem[] {
  return Array.isArray(value) && value.every(isAnalyticsAnomalyItem);
}

/** A cross-tab / regional-priority row: dynamic column keys, each a number or a label string. */
function isCrossTabRow(value: unknown): value is CrossTabRow {
  return isRecord(value) && Object.values(value).every((cell) => typeof cell === "number" || typeof cell === "string");
}

function isCrossTabRowArray(value: unknown): value is CrossTabRow[] {
  return Array.isArray(value) && value.every(isCrossTabRow);
}

const CORE_DISTRIBUTION_KEYS = ["byRegion", "byDepartment", "byClassification", "byChannel"] as const;
const DASHBOARD_DISTRIBUTION_KEYS = [...CORE_DISTRIBUTION_KEYS, "byStatus", "byPriority", "bySeverity"] as const;

function hasValidDistributionArrays(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => isNameCountArray(record[key]));
}

function isDistributionRecord(value: unknown, keys: readonly string[]): value is CoreDistributions {
  return isRecord(value) && hasValidDistributionArrays(value, keys);
}

// ---------- DashboardData field validators ----------

const DASHBOARD_VOLUME_KEYS = [
  "total", "open", "inProgress", "closed", "reopened", "rejected",
  "late", "repeated", "validated", "notValidated", "potentialDuplicates",
] as const;

function isDashboardVolume(value: unknown): value is DashboardData["volume"] {
  return isRecord(value) && hasFiniteNumberFields(value, DASHBOARD_VOLUME_KEYS);
}

const DASHBOARD_PERFORMANCE_NUMBER_KEYS = [
  "closureRate", "lateRate", "avgFirstResponseHours", "avgProcessingHours", "avgOpenAgeHours",
  "overdueNoAction", "overdueNoActionRate", "reopenRate", "validityRate", "avgSatisfaction", "satisfactionRate",
] as const;

function isDashboardPerformance(value: unknown): value is DashboardData["performance"] {
  return (
    isRecord(value)
    && isNullableFiniteNumber(value.onTimeRate)
    && hasFiniteNumberFields(value, DASHBOARD_PERFORMANCE_NUMBER_KEYS)
  );
}

function isTrendPoint(value: unknown): value is DashboardData["trend"]["trendData"][number] {
  return isRecord(value) && typeof value.date === "string" && isFiniteNumber(value.total) && isFiniteNumber(value.closed);
}

function isDashboardTrend(value: unknown): value is DashboardData["trend"] {
  return (
    isRecord(value)
    && isNullableFiniteNumber(value.previousTotal)
    && isNullableFiniteNumber(value.growthRate)
    && Array.isArray(value.trendData)
    && value.trendData.every(isTrendPoint)
  );
}

const DASHBOARD_ALERTS_KEYS = ["criticalComplaints", "lateCritical", "missingFields", "dataQualityRate"] as const;

function isDashboardAlerts(value: unknown): value is DashboardData["alerts"] {
  return isRecord(value) && hasFiniteNumberFields(value, DASHBOARD_ALERTS_KEYS);
}

export function isDashboardData(value: unknown): value is DashboardData {
  return (
    isRecord(value)
    && isDashboardVolume(value.volume)
    && isDashboardPerformance(value.performance)
    && isDashboardTrend(value.trend)
    && isDistributionRecord(value.distributions, DASHBOARD_DISTRIBUTION_KEYS)
    && isDashboardAlerts(value.alerts)
  );
}

// ---------- AnalyticsData field validators ----------

function isChannelEffectivenessItem(value: unknown): value is AnalyticsData["channelEffectiveness"][number] {
  return (
    isRecord(value)
    && typeof value.channel === "string"
    && isFiniteNumber(value.total)
    && isFiniteNumber(value.closed)
    && isFiniteNumber(value.closureRate)
    && isFiniteNumber(value.lateRate)
    && isFiniteNumber(value.avgProcessingHours)
  );
}

function isChannelEffectivenessArray(value: unknown): value is AnalyticsData["channelEffectiveness"] {
  return Array.isArray(value) && value.every(isChannelEffectivenessItem);
}

function isCrossTabs(value: unknown): value is AnalyticsData["crossTabs"] {
  return (
    isRecord(value)
    && isStringArray(value.classifications)
    && isStringArray(value.regions)
    && isStringArray(value.departments)
    && isCrossTabRowArray(value.classificationByRegion)
    && isCrossTabRowArray(value.classificationByDepartment)
  );
}

function isAnalyticsCollections(value: Record<string, unknown>): boolean {
  return (
    isChannelEffectivenessArray(value.channelEffectiveness)
    && isNameCountArray(value.delayReasons)
    && isNameCountArray(value.recurringSubjects)
    && isNameCountArray(value.recurringClassifications)
  );
}

function isAnomalies(value: unknown): value is AnalyticsData["anomalies"] {
  return (
    isRecord(value)
    && isAnomalyArray(value.regions)
    && isAnomalyArray(value.departments)
    && isNameCountArray(value.classifications)
  );
}

function isPreviousDistributions(value: unknown): value is AnalyticsData["previousDistributions"] {
  return value === null || isDistributionRecord(value, CORE_DISTRIBUTION_KEYS);
}

function isFindingArray(value: unknown): value is AnalyticalFinding[] {
  return Array.isArray(value) && value.every((item) => AnalyticalFindingSchema.safeParse(item).success);
}

function isPatternSnapshotArray(value: unknown): boolean {
  return (
    Array.isArray(value)
    && value.every(
      (item) =>
        isRecord(item)
        && typeof item.key === "string"
        && typeof item.facility === "string"
        && typeof item.classificationLabel === "string"
        && typeof item.pattern === "string"
        && typeof item.priorityBand === "string"
    )
  );
}

function isWorsenedProblemArray(value: unknown): boolean {
  return (
    Array.isArray(value)
    && value.every(
      (item) =>
        isRecord(item)
        && typeof item.key === "string"
        && typeof item.facility === "string"
        && typeof item.classificationLabel === "string"
        && typeof item.from === "string"
        && typeof item.to === "string"
    )
  );
}

function isPeriodChangeDigest(value: unknown): value is AnalyticsData["periodChangeDigest"] {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return (
    isPatternSnapshotArray(value.newProblems)
    && isPatternSnapshotArray(value.continuingProblems)
    && isWorsenedProblemArray(value.worsenedProblems)
    && isPatternSnapshotArray(value.relapsedProblems)
    && isPatternSnapshotArray(value.improvedFacilities)
    && isPatternSnapshotArray(value.exitedPriorityList)
    && isStringArray(value.newlySpreadingClassifications)
  );
}

function isPatternAnalysisPeriodsArray(value: unknown): value is AnalyticsData["patternAnalysisPeriods"] {
  return Array.isArray(value) && value.every((item) => isRecord(item) && typeof item.from === "string" && typeof item.to === "string");
}

export function isAnalyticsData(value: unknown): value is AnalyticsData {
  if (!isRecord(value)) return false;

  return (
    isCrossTabs(value.crossTabs)
    && isAnalyticsCollections(value)
    && isCrossTabRowArray(value.regionPriorityBreakdown)
    && isAnomalies(value.anomalies)
    && isPreviousDistributions(value.previousDistributions)
    && isFiniteNumber(value.totalCount)
    && isFindingArray(value.findings)
    && isPeriodChangeDigest(value.periodChangeDigest)
    && isPatternAnalysisPeriodsArray(value.patternAnalysisPeriods)
  );
}
