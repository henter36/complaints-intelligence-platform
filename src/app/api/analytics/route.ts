import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { getComplaintKpis } from "@/server/complaints/complaint-kpi-service";
import { isComplaintQueryValidationError } from "@/server/complaints/complaint-query-service";

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
      regionPriorityBreakdown: result.distributions.byRegion.map((item) => ({ region: item.name, total: item.total })),
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
