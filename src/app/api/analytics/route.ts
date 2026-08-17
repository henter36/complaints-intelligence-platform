import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { getComplaintKpis } from "@/server/complaints/complaint-kpi-service";
import { isComplaintQueryValidationError } from "@/server/complaints/complaint-query-service";
import { computeAnalyticsFindings } from "@/server/analytics/analytics-findings-service";
import type { AnalyticalFinding } from "@/lib/analytics/analytical-finding";
import type { PeriodChangeDigest } from "@/lib/analytics/period-change-digest";
import { loadPatternAnalysisForFilters } from "@/server/analytics/pattern/pattern-report-integration-service";
import { rankFindingsForExecutiveBrief } from "@/lib/analytics/finding-ranking";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The multi-period pattern engine (chronic issues, repeat complainants,
 * concentration, cross-facility spread, ...) needs an explicit current
 * period to build its trailing analysis window from. Without one there is
 * no reliable way to say "the last N periods" (spec §19: don't produce a
 * definitive conclusion on insufficient/ambiguous data), so it is skipped
 * rather than guessed. Scoped by region when the Analytics page has one
 * selected — department scoping is intentionally not applied here; the
 * engine aggregates by facility×classification, not department, so a
 * department filter cannot be verified against a finding without guessing.
 */
async function loadPatternAnalysis(
  fromDate: string | null,
  toDate: string | null,
  regionId: string | null
): Promise<{ findings: AnalyticalFinding[]; periodChangeDigest: PeriodChangeDigest | null; periods: { from: string; to: string }[] }> {
  if (!fromDate || !toDate) return { findings: [], periodChangeDigest: null, periods: [] };

  const currentFrom = new Date(`${fromDate}T00:00:00.000Z`);
  const currentToExclusive = new Date(new Date(`${toDate}T00:00:00.000Z`).getTime() + DAY_MS);
  if (Number.isNaN(currentFrom.getTime()) || Number.isNaN(currentToExclusive.getTime())) {
    return { findings: [], periodChangeDigest: null, periods: [] };
  }

  return loadPatternAnalysisForFilters(currentFrom, currentToExclusive, { region: regionId });
}

export const compareArabicLabels = (left: string, right: string): number =>
  left.localeCompare(right, "ar");

function toCount(groups: { name: string; total: number }[]): { name: string; count: number }[] {
  return groups.map((group) => ({ name: group.name, count: group.total }));
}

function computeAnomalies(items: { name: string; count: number }[]) {
  if (items.length === 0) return [];
  const total = items.reduce((sum, item) => sum + item.count, 0);
  const average = total / items.length;
  return items.map((item) => ({
    name: item.name,
    count: item.count,
    average: Math.round(average * 10) / 10,
    deviation: average > 0 ? Math.round(((item.count - average) / average) * 1000) / 10 : 0,
    isAnomaly: average > 0 && item.count > average * 1.5,
  }));
}

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const url = new URL(req.url);
    const result = await getComplaintKpis(url.searchParams);
    const classifications = result.distributions.byClassification.map((item) => item.name).sort(compareArabicLabels);
    const regions = result.distributions.byRegion.map((item) => item.name).sort(compareArabicLabels);
    const departments = result.distributions.byDepartment.map((item) => item.name).sort(compareArabicLabels);

    const fromDate = url.searchParams.get("from");
    const toDate = url.searchParams.get("to");
    const regionId = url.searchParams.get("regionId") ?? url.searchParams.get("region");
    const patternAnalysis = await loadPatternAnalysis(fromDate, toDate, regionId);
    const findings = rankFindingsForExecutiveBrief([
      ...computeAnalyticsFindings(result, fromDate, toDate),
      ...patternAnalysis.findings,
    ]);

    return NextResponse.json({
      kpis: result.kpis,
      crossTabs: {
        classifications,
        regions,
        departments,
        classificationByRegion: result.crossTabs.classificationByRegion,
        classificationByDepartment: result.crossTabs.classificationByDepartment,
      },
      channelEffectiveness: result.distributions.byChannel.map((item) => ({
        channel: item.name,
        total: item.total,
        closed: item.closed,
        closureRate: item.total > 0 ? Math.round((item.closed / item.total) * 1000) / 10 : 0,
        lateRate: item.total > 0 ? Math.round((item.currentlyLate / item.total) * 1000) / 10 : 0,
        avgProcessingHours: Math.round(item.averageResolutionDays * 24 * 10) / 10,
      })),
      delayReasons: result.distributions.byDelayReason.slice(0, 10),
      recurringSubjects: result.distributions.bySubject.slice(0, 10),
      recurringClassifications: toCount(result.distributions.byClassification).slice(0, 10),
      anomalies: {
        regions: computeAnomalies(toCount(result.distributions.byRegion)),
        departments: computeAnomalies(toCount(result.distributions.byDepartment)),
        classifications: computeAnomalies(toCount(result.distributions.byClassification)),
      },
      regionPriorityBreakdown: result.distributions.byRegionPriority.map((r) => ({
        region: r.region,
        حرجة: r.critical,
        عالية: r.high,
        متوسطة: r.medium,
        منخفضة: r.low,
        مجهولة: r.unknown,
        total: r.total,
      })),
      previousDistributions: result.previousDistributions
        ? {
          byRegion: result.previousDistributions.byRegion.map((r) => ({ name: r.name, count: r.total })),
          byDepartment: result.previousDistributions.byDepartment.map((r) => ({ name: r.name, count: r.total })),
          byClassification: result.previousDistributions.byClassification.map((r) => ({ name: r.name, count: r.total })),
          byChannel: result.previousDistributions.byChannel.map((r) => ({ name: r.name, count: r.total })),
        }
        : null,
      findings,
      periodChangeDigest: patternAnalysis.periodChangeDigest,
      patternAnalysisPeriods: patternAnalysis.periods,
      totalCount: result.volume.total,
      distributions: result.distributions,
    });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    if (isComplaintQueryValidationError(error)) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: 400 }
      );
    }
    console.error("Analytics API error:", error);
    return NextResponse.json(
      { error: { code: "ANALYTICS_QUERY_FAILED", message: "تعذر جلب التحليلات" } },
      { status: 500 }
    );
  }
}
