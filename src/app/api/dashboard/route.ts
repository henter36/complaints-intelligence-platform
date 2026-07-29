import { NextRequest, NextResponse } from "next/server";
import { ComplaintStatus, type Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { average, isComplaintLate, roundToTenth } from "@/lib/complaint-metrics";
import {
  addComplaintRequestFilters,
  buildComplaintWhereFromParams,
  isInvalidComplaintQueryError,
  parseOptionalDateFilter,
  toLegacyPriority,
} from "@/server/api/complaint-query";
import { toLegacyStatus } from "@/server/complaints/status";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getPreviousPeriodRange(from?: string | null, to?: string | null) {
  if (!from || !to) return null;
  const start = new Date(from);
  const end = new Date(to);
  const diff = end.getTime() - start.getTime();
  return { gte: new Date(start.getTime() - diff), lt: start };
}

const OPEN_STATUSES = new Set<ComplaintStatus>([
  ComplaintStatus.NEW,
  ComplaintStatus.OPEN,
  ComplaintStatus.IN_PROGRESS,
  ComplaintStatus.AWAITING_RESPONSE,
  ComplaintStatus.RESOLVED,
]);

function buildTrendDateRange(params: URLSearchParams, now: Date): { gte: Date; lte: Date } | null {
  const trendDays = 30;
  const trendStart = new Date(now.getTime() - trendDays * 24 * 60 * 60 * 1000);
  const requestFrom = parseOptionalDateFilter(params.get("from"), "from");
  const requestTo = parseOptionalDateFilter(params.get("to"), "to");
  const gte = requestFrom && requestFrom > trendStart ? requestFrom : trendStart;
  const lte = requestTo && requestTo < now ? requestTo : now;

  if (gte > lte) return null;
  return { gte, lte };
}

function withComplaintDate(
  where: Prisma.ComplaintWhereInput,
  complaintDate: { gte: Date; lte: Date }
): Prisma.ComplaintWhereInput {
  const { complaintDate: _ignoredComplaintDate, ...nonDateFilters } = where;
  return {
    ...nonDateFilters,
    complaintDate,
  };
}

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const url = new URL(req.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const now = new Date();
    const where = addComplaintRequestFilters(
      buildComplaintWhereFromParams(url.searchParams),
      url.searchParams,
      now
    );

    const complaints = await db.complaint.findMany({
      where,
      select: {
        id: true,
        status: true,
        priority: true,
        severity: true,
        complaintDate: true,
        receivedAt: true,
        dueDate: true,
        closedAt: true,
        firstActionAt: true,
        processingStartedAt: true,
        isRepeated: true,
        isValidated: true,
        isPotentialDuplicate: true,
        beneficiarySatisfaction: true,
        region: true,
        department: true,
        classificationId: true,
        channel: true,
        classification: { select: { nameAr: true } },
      },
    });

    const total = complaints.length;
    const open = complaints.filter(c => c.status === ComplaintStatus.OPEN || c.status === ComplaintStatus.NEW).length;
    const inProgress = complaints.filter(c => c.status === ComplaintStatus.IN_PROGRESS || c.status === ComplaintStatus.AWAITING_RESPONSE).length;
    const closed = complaints.filter(c => c.status === ComplaintStatus.CLOSED).length;
    const reopened = 0;
    const rejected = complaints.filter(c => c.status === ComplaintStatus.CANCELLED).length;

    const late = complaints.filter(c => isComplaintLate(c, now)).length;

    const repeated = complaints.filter(c => c.isRepeated).length;
    const validated = complaints.filter(c => c.isValidated).length;
    const notValidated = complaints.filter(c => !c.isValidated && c.status !== ComplaintStatus.CANCELLED).length;
    const potentialDuplicates = complaints.filter(c => c.isPotentialDuplicate).length;

    const closureRate = total > 0 ? (closed / total) * 100 : 0;
    const closedOnTime = complaints.filter(c =>
      c.status === ComplaintStatus.CLOSED && c.closedAt && c.dueDate && c.closedAt <= c.dueDate
    ).length;
    const onTimeRate = closed > 0 ? (closedOnTime / closed) * 100 : 0;
    const lateRate = total > 0 ? (late / total) * 100 : 0;

    const responseTimes = complaints
      .filter(c => c.firstActionAt && (c.complaintDate ?? c.receivedAt))
      .map(c => (c.firstActionAt!.getTime() - (c.complaintDate ?? c.receivedAt).getTime()) / (1000 * 60 * 60));
    const avgFirstResponse = average(responseTimes);

    const processingTimes = complaints
      .filter(c => c.processingStartedAt && c.closedAt)
      .map(c => (c.closedAt!.getTime() - c.processingStartedAt!.getTime()) / (1000 * 60 * 60));
    const avgProcessing = average(processingTimes);

    const openAges = complaints
      .filter(c => OPEN_STATUSES.has(c.status))
      .map(c => (now.getTime() - (c.complaintDate ?? c.receivedAt).getTime()) / (1000 * 60 * 60));
    const avgOpenAge = average(openAges);

    const overdueNoAction = complaints.filter(c =>
      OPEN_STATUSES.has(c.status) && c.dueDate && now > c.dueDate && !c.firstActionAt
    ).length;
    const overdueNoActionRate = total > 0 ? (overdueNoAction / total) * 100 : 0;

    const satisfactions = complaints.filter(c => c.beneficiarySatisfaction !== null).map(c => c.beneficiarySatisfaction!);
    const avgSatisfaction = average(satisfactions);
    const satisfactionRate = satisfactions.filter(s => s >= 4).length;
    const satisfactionPct = satisfactions.length > 0 ? (satisfactionRate / satisfactions.length) * 100 : 0;

    let previousTotal: number | null = null;
    let growthRate: number | null = null;
    const prevRange = getPreviousPeriodRange(from, to);
    if (prevRange) {
      const prevWhere = { ...where, complaintDate: prevRange };
      previousTotal = await db.complaint.count({ where: prevWhere });
      const currentPeriodTotal = await db.complaint.count({ where });
      growthRate = previousTotal > 0
        ? ((currentPeriodTotal - previousTotal) / previousTotal) * 100
        : currentPeriodTotal > 0 ? 100 : 0;
    }

    const byRegion = groupBy(complaints, c => c.region || "غير محدد");
    const byDepartment = groupBy(complaints, c => c.department || "غير محدد");
    const byClassification = groupBy(complaints, c => c.classification?.nameAr || "غير محدد");
    const byChannel = groupBy(complaints, c => c.channel || "غير محدد");
    const byStatus = groupBy(complaints, c => toLegacyStatus(c.status));
    const byPriority = groupBy(complaints, c => toLegacyPriority(c.priority));
    const bySeverity = groupBy(complaints, c => toLegacyPriority(c.severity));

    const trendDays = 30;
    const trendRange = buildTrendDateRange(url.searchParams, now);
    const trendComplaints = trendRange
      ? await db.complaint.findMany({
        where: withComplaintDate(where, trendRange),
        select: { complaintDate: true, status: true },
      })
      : [];
    const trendData: { date: string; total: number; closed: number }[] = [];
    const trendStartDay = trendRange ? formatLocalDate(trendRange.gte) : null;
    const trendEndDay = trendRange ? formatLocalDate(trendRange.lte) : null;
    for (let i = trendRange ? trendDays - 1 : -1; i >= 0; i--) {
      const day = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dayStr = formatLocalDate(day);
      if (trendStartDay && trendEndDay && (dayStr < trendStartDay || dayStr > trendEndDay)) {
        continue;
      }
      const dayComplaints = trendComplaints.filter(c =>
        c.complaintDate ? formatLocalDate(c.complaintDate) === dayStr : false
      );
      trendData.push({
        date: dayStr,
        total: dayComplaints.length,
        closed: dayComplaints.filter(c => c.status === ComplaintStatus.CLOSED).length,
      });
    }

    const criticalComplaints = complaints.filter(c => c.severity === "CRITICAL" || c.priority === "CRITICAL").length;
    const lateCritical = complaints.filter(c =>
      (c.severity === "CRITICAL" || c.priority === "CRITICAL") && isComplaintLate(c, now)
    ).length;

    const missingFields = complaints.filter(c => !c.region || !c.department || !c.classificationId).length;
    const dataQualityRate = total > 0 ? ((total - missingFields) / total) * 100 : 100;

    return NextResponse.json({
      volume: {
        total, open, inProgress, closed, reopened, rejected, late,
        repeated, validated, notValidated, potentialDuplicates,
      },
      performance: {
        closureRate: roundToTenth(closureRate),
        onTimeRate: roundToTenth(onTimeRate),
        lateRate: roundToTenth(lateRate),
        avgFirstResponseHours: roundToTenth(avgFirstResponse),
        avgProcessingHours: roundToTenth(avgProcessing),
        avgOpenAgeHours: roundToTenth(avgOpenAge),
        overdueNoAction,
        overdueNoActionRate: roundToTenth(overdueNoActionRate),
        reopenRate: 0,
        validityRate: total > 0 ? roundToTenth((validated / total) * 100) : 0,
        avgSatisfaction: roundToTenth(avgSatisfaction),
        satisfactionRate: roundToTenth(satisfactionPct),
      },
      trend: {
        previousTotal,
        growthRate: growthRate !== null ? roundToTenth(growthRate) : null,
        trendData,
      },
      distributions: {
        byRegion: byRegion.sort((a, b) => b.count - a.count),
        byDepartment: byDepartment.sort((a, b) => b.count - a.count),
        byClassification: byClassification.sort((a, b) => b.count - a.count),
        byChannel: byChannel.sort((a, b) => b.count - a.count),
        byStatus,
        byPriority,
        bySeverity,
      },
      alerts: {
        criticalComplaints,
        lateCritical,
        missingFields,
        dataQualityRate: roundToTenth(dataQualityRate),
      },
    });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;

    if (isInvalidComplaintQueryError(error)) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: 400 }
      );
    }
    console.error("Dashboard API error:", error);
    return NextResponse.json({ error: "Failed to fetch dashboard data" }, { status: 500 });
  }
}

function groupBy<T>(arr: T[], fn: (item: T) => string) {
  const map = new Map<string, number>();
  for (const item of arr) {
    const key = fn(item);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return Array.from(map.entries()).map(([name, count]) => ({ name, count }));
}
