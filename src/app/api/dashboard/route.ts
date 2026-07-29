import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { average, isComplaintLate, roundToTenth } from "@/lib/complaint-metrics";

function parseDateRange(req: NextRequest): Prisma.ComplaintWhereInput {
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const regionId = url.searchParams.get("regionId");
  const departmentId = url.searchParams.get("departmentId");
  const classificationId = url.searchParams.get("classificationId");
  const channel = url.searchParams.get("channel");
  const status = url.searchParams.get("status");
  const priority = url.searchParams.get("priority");
  const severity = url.searchParams.get("severity");

  const startDate = from ? new Date(from) : undefined;
  const endDate = to ? new Date(to) : undefined;

  const where: Prisma.ComplaintWhereInput = {};
  if (startDate && endDate) {
    where.receivedDate = { gte: startDate, lte: endDate };
  } else if (startDate) {
    where.receivedDate = { gte: startDate };
  }
  if (regionId) where.regionId = regionId;
  if (departmentId) where.departmentId = departmentId;
  if (classificationId) where.classificationId = classificationId;
  if (channel) where.channel = channel;
  if (status) where.status = status;
  if (priority) where.priority = priority;
  if (severity) where.severity = severity;
  return where;
}

function getPreviousPeriodRange(from?: string, to?: string) {
  if (!from || !to) return null;
  const start = new Date(from);
  const end = new Date(to);
  const diff = end.getTime() - start.getTime();
  const prevStart = new Date(start.getTime() - diff);
  const prevEnd = new Date(start.getTime());
  return { gte: prevStart, lt: start };
}

export async function GET(req: NextRequest) {
  try {
    const where = parseDateRange(req);
    const url = new URL(req.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");

    const complaints = await db.complaint.findMany({
      where,
      include: { region: true, location: true, department: true, classification: true },
    });

    const total = complaints.length;
    const open = complaints.filter(c => c.status === "open").length;
    const inProgress = complaints.filter(c => c.status === "in_progress").length;
    const closed = complaints.filter(c => c.status === "closed").length;
    const reopened = complaints.filter(c => c.status === "reopened").length;
    const rejected = complaints.filter(c => c.status === "rejected").length;

    const now = new Date();
    const late = complaints.filter(c => isComplaintLate(c, now)).length;

    const repeated = complaints.filter(c => c.isRepeated).length;
    const validated = complaints.filter(c => c.isValidated).length;
    const notValidated = complaints.filter(c => !c.isValidated && c.status !== "rejected").length;
    const potentialDuplicates = complaints.filter(c => c.isPotentialDuplicate).length;

    const closureRate = total > 0 ? (closed / total) * 100 : 0;
    const closedOnTime = complaints.filter(c =>
      c.status === "closed" && c.closureDate && c.dueDate && c.closureDate <= c.dueDate
    ).length;
    const onTimeRate = closed > 0 ? (closedOnTime / closed) * 100 : 0;
    const lateRate = total > 0 ? (late / total) * 100 : 0;

    const responseTimes = complaints
      .filter(c => c.referralDate && c.firstActionDate)
      .map(c => (c.firstActionDate!.getTime() - c.referralDate!.getTime()) / (1000 * 60 * 60));
    const avgFirstResponse = average(responseTimes);

    const processingTimes = complaints
      .filter(c => c.firstActionDate && c.closureDate)
      .map(c => (c.closureDate!.getTime() - c.firstActionDate!.getTime()) / (1000 * 60 * 60));
    const avgProcessing = average(processingTimes);

    const openAges = complaints
      .filter(c => c.status === "open" || c.status === "in_progress")
      .map(c => (now.getTime() - c.receivedDate.getTime()) / (1000 * 60 * 60));
    const avgOpenAge = average(openAges);

    const overdueNoAction = complaints.filter(c =>
      c.status !== "closed" && c.status !== "rejected" &&
      c.dueDate && now > c.dueDate && !c.firstActionDate
    ).length;
    const overdueNoActionRate = total > 0 ? (overdueNoAction / total) * 100 : 0;

    const reopenRate = total > 0 ? (reopened / total) * 100 : 0;
    const validityRate = total > 0 ? (validated / total) * 100 : 0;

    const satisfactions = complaints.filter(c => c.beneficiarySatisfaction !== null).map(c => c.beneficiarySatisfaction!);
    const avgSatisfaction = satisfactions.length > 0
      ? satisfactions.reduce((a, b) => a + b, 0) / satisfactions.length : 0;
    const satisfactionRate = satisfactions.filter(s => s >= 4).length;
    const satisfactionPct = satisfactions.length > 0 ? (satisfactionRate / satisfactions.length) * 100 : 0;

    let previousTotal: number | null = null;
    let growthRate: number | null = null;
    if (from && to) {
      const prevRange = getPreviousPeriodRange(from, to);
      if (prevRange) {
        const prevWhere = { ...where, receivedDate: prevRange };
        previousTotal = await db.complaint.count({ where: prevWhere });
        const currentPeriodTotal = await db.complaint.count({ where });
        growthRate = previousTotal > 0
          ? ((currentPeriodTotal - previousTotal) / previousTotal) * 100
          : currentPeriodTotal > 0 ? 100 : 0;
      }
    }

    const byRegion = groupBy(complaints, c => c.region?.name || "غير محدد");
    const byDepartment = groupBy(complaints, c => c.department?.name || "غير محدد");
    const byClassification = groupBy(complaints, c => c.classification?.name || "غير محدد");
    const byChannel = groupBy(complaints, c => c.channel);
    const byStatus = groupBy(complaints, c => c.status);
    const byPriority = groupBy(complaints, c => c.priority);
    const bySeverity = groupBy(complaints, c => c.severity);

    const trendDays = 30;
    const trendStart = new Date(now.getTime() - trendDays * 24 * 60 * 60 * 1000);
    const trendEnd = now;
    const trendComplaints = await db.complaint.findMany({
      where: { receivedDate: { gte: trendStart, lte: trendEnd } },
      select: { receivedDate: true, status: true },
    });
    const trendData: { date: string; total: number; closed: number }[] = [];
    for (let i = trendDays - 1; i >= 0; i--) {
      const day = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dayStr = day.toISOString().slice(0, 10);
      const dayComplaints = trendComplaints.filter(c =>
        c.receivedDate.toISOString().slice(0, 10) === dayStr
      );
      trendData.push({
        date: dayStr,
        total: dayComplaints.length,
        closed: dayComplaints.filter(c => c.status === "closed").length,
      });
    }

    const criticalComplaints = complaints.filter(c => c.severity === "critical" || c.priority === "critical").length;
    const lateCritical = complaints.filter(c =>
      (c.severity === "critical" || c.priority === "critical") &&
      isComplaintLate(c, now)
    ).length;

    const missingFields = complaints.filter(c => !c.regionId || !c.departmentId || !c.classificationId).length;
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
        reopenRate: roundToTenth(reopenRate),
        validityRate: roundToTenth(validityRate),
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
