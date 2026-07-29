import { NextRequest, NextResponse } from "next/server";
import { ComplaintStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { average, isComplaintLate, roundToTenth } from "@/lib/complaint-metrics";
import {
  buildComplaintWhereFromParams,
  isInvalidComplaintQueryError,
  toLegacyPriority,
} from "@/server/api/complaint-query";

export const compareArabicLabels = (left: string, right: string): number =>
  left.localeCompare(right, "ar");

function getPreviousRange(from?: string | null, to?: string | null) {
  if (!from || !to) return null;
  const start = new Date(from);
  const end = new Date(to);
  const diff = end.getTime() - start.getTime();
  return { gte: new Date(start.getTime() - diff - 1), lte: new Date(start.getTime() - 1) };
}

function groupByCount<T>(arr: T[], fn: (item: T) => string) {
  const map = new Map<string, number>();
  for (const item of arr) {
    const key = fn(item);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const where = buildComplaintWhereFromParams(url.searchParams);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");

    const complaints = await db.complaint.findMany({
      where,
      select: {
        status: true,
        priority: true,
        complaintDate: true,
        receivedAt: true,
        dueDate: true,
        closedAt: true,
        processingStartedAt: true,
        delayReason: true,
        subject: true,
        channel: true,
        region: true,
        department: true,
        classification: { select: { nameAr: true } },
      },
    });

    const now = new Date();
    const classifications = Array.from(
      new Set(complaints.map(c => c.classification?.nameAr || "غير مصنف"))
    ).sort(compareArabicLabels);
    const regions = Array.from(new Set(complaints.map(c => c.region || "غير محدد"))).sort(compareArabicLabels);
    const departments = Array.from(new Set(complaints.map(c => c.department || "غير محدد"))).sort(compareArabicLabels);

    const classificationByRegion = classifications.map(cls => {
      const row: Record<string, number | string> = { classification: cls };
      for (const r of regions) {
        row[r] = complaints.filter(
          c => (c.classification?.nameAr || "غير مصنف") === cls &&
               (c.region || "غير محدد") === r
        ).length;
      }
      return row;
    });

    const classificationByDepartment = classifications.map(cls => {
      const row: Record<string, number | string> = { classification: cls };
      for (const d of departments) {
        row[d] = complaints.filter(
          c => (c.classification?.nameAr || "غير مصنف") === cls &&
               (c.department || "غير محدد") === d
        ).length;
      }
      return row;
    });

    const channels = Array.from(new Set(complaints.map(c => c.channel || "غير محدد")));
    const channelEffectiveness = channels.map(ch => {
      const items = complaints.filter(c => (c.channel || "غير محدد") === ch);
      const closed = items.filter(c => c.status === ComplaintStatus.CLOSED);
      const procTimes = items
        .filter(c => c.processingStartedAt && c.closedAt)
        .map(c => (c.closedAt!.getTime() - c.processingStartedAt!.getTime()) / (1000 * 60 * 60));
      const late = items.filter(c => isComplaintLate(c, now)).length;
      return {
        channel: ch,
        total: items.length,
        closed: closed.length,
        closureRate: items.length > 0 ? roundToTenth((closed.length / items.length) * 100) : 0,
        lateRate: items.length > 0 ? roundToTenth((late / items.length) * 100) : 0,
        avgProcessingHours: roundToTenth(average(procTimes)),
      };
    }).sort((a, b) => b.total - a.total);

    const delayReasons = groupByCount(
      complaints.filter(c => c.delayReason),
      c => c.delayReason!
    );

    const recurringSubjects = groupByCount(complaints, c => c.subject).slice(0, 10);
    const recurringClassifications = groupByCount(
      complaints,
      c => c.classification?.nameAr || "غير مصنف"
    ).slice(0, 10);

    const byRegion = groupByCount(complaints, c => c.region || "غير محدد");
    const byDepartment = groupByCount(complaints, c => c.department || "غير محدد");
    const byClassification = groupByCount(complaints, c => c.classification?.nameAr || "غير مصنف");

    function computeAnomalies(items: { name: string; count: number }[]) {
      if (items.length === 0) return [];
      const total = items.reduce((s, i) => s + i.count, 0);
      const avg = total / items.length;
      return items.map(i => {
        const deviation = avg > 0 ? (i.count - avg) / avg : 0;
        return {
          name: i.name,
          count: i.count,
          average: roundToTenth(avg),
          deviation: roundToTenth(deviation * 100),
          isAnomaly: avg > 0 && i.count > avg * 1.5,
        };
      });
    }

    let previousDistributions: {
      byRegion: { name: string; count: number }[];
      byDepartment: { name: string; count: number }[];
      byClassification: { name: string; count: number }[];
      byChannel: { name: string; count: number }[];
    } | null = null;

    const prevRange = getPreviousRange(from, to);
    if (prevRange) {
      const prevComplaints = await db.complaint.findMany({
        where: { ...where, complaintDate: prevRange },
        select: {
          region: true,
          department: true,
          channel: true,
          classification: { select: { nameAr: true } },
        },
      });
      previousDistributions = {
        byRegion: groupByCount(prevComplaints, c => c.region || "غير محدد"),
        byDepartment: groupByCount(prevComplaints, c => c.department || "غير محدد"),
        byClassification: groupByCount(prevComplaints, c => c.classification?.nameAr || "غير مصنف"),
        byChannel: groupByCount(prevComplaints, c => c.channel || "غير محدد"),
      };
    }

    const regionPriorityBreakdown = regions.map(r => {
      const items = complaints.filter(c => (c.region || "غير محدد") === r);
      const row: Record<string, number | string> = { region: r, total: items.length };
      row["حرجة"] = items.filter(c => toLegacyPriority(c.priority) === "critical").length;
      row["عالية"] = items.filter(c => toLegacyPriority(c.priority) === "high").length;
      row["متوسطة"] = items.filter(c => toLegacyPriority(c.priority) === "medium").length;
      row["منخفضة"] = items.filter(c => toLegacyPriority(c.priority) === "low").length;
      return row;
    });

    return NextResponse.json({
      crossTabs: {
        classifications,
        regions,
        departments,
        classificationByRegion,
        classificationByDepartment,
      },
      channelEffectiveness,
      delayReasons,
      recurringSubjects,
      recurringClassifications,
      anomalies: {
        regions: computeAnomalies(byRegion),
        departments: computeAnomalies(byDepartment),
        classifications: byClassification,
      },
      previousDistributions,
      regionPriorityBreakdown,
      totalCount: complaints.length,
    });
  } catch (error) {
    if (isInvalidComplaintQueryError(error)) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: 400 }
      );
    }
    console.error("Analytics API error:", error);
    return NextResponse.json({ error: "Failed to fetch analytics data" }, { status: 500 });
  }
}
