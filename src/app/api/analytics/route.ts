import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { average, isComplaintLate, roundToTenth } from "@/lib/complaint-metrics";

// Build where clause from filter params
function buildWhere(req: NextRequest): {
  where: Prisma.ComplaintWhereInput;
  from: string | null;
  to: string | null;
} {
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

  const where: Prisma.ComplaintWhereInput = {};
  if (from && to) {
    where.receivedDate = { gte: new Date(from), lte: new Date(to) };
  } else if (from) {
    where.receivedDate = { gte: new Date(from) };
  } else if (to) {
    where.receivedDate = { lte: new Date(to) };
  }
  if (regionId) where.regionId = regionId;
  if (departmentId) where.departmentId = departmentId;
  if (classificationId) where.classificationId = classificationId;
  if (channel) where.channel = channel;
  if (status) where.status = status;
  if (priority) where.priority = priority;
  if (severity) where.severity = severity;
  return { where, from, to };
}

// Compute previous-period date range of equal length
function getPreviousRange(from?: string | null, to?: string | null) {
  if (!from || !to) return null;
  const start = new Date(from);
  const end = new Date(to);
  const diff = end.getTime() - start.getTime();
  const prevStart = new Date(start.getTime() - diff - 1);
  const prevEnd = new Date(start.getTime() - 1);
  return { gte: prevStart, lte: prevEnd };
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
    const { where, from, to } = buildWhere(req);

    // Fetch current-period complaints with relations
    const complaints = await db.complaint.findMany({
      where,
      include: {
        region: true,
        department: true,
        classification: true,
      },
    });

    const now = new Date();

    // ----- Cross-tabulation: classification × region -----
    const classifications = Array.from(
      new Set(complaints.map(c => c.classification?.name || "غير مصنف"))
    ).sort();
    const regions = Array.from(
      new Set(complaints.map(c => c.region?.name || "غير محدد"))
    ).sort();
    const departments = Array.from(
      new Set(complaints.map(c => c.department?.name || "غير محدد"))
    ).sort();

    const classificationByRegion = classifications.map(cls => {
      const row: Record<string, number | string> = { classification: cls };
      for (const r of regions) {
        row[r] = complaints.filter(
          c => (c.classification?.name || "غير مصنف") === cls &&
               (c.region?.name || "غير محدد") === r
        ).length;
      }
      return row;
    });

    const classificationByDepartment = classifications.map(cls => {
      const row: Record<string, number | string> = { classification: cls };
      for (const d of departments) {
        row[d] = complaints.filter(
          c => (c.classification?.name || "غير مصنف") === cls &&
               (c.department?.name || "غير محدد") === d
        ).length;
      }
      return row;
    });

    // ----- Channel effectiveness -----
    const channels = Array.from(new Set(complaints.map(c => c.channel)));
    const channelEffectiveness = channels.map(ch => {
      const items = complaints.filter(c => c.channel === ch);
      const closed = items.filter(c => c.status === "closed");
      const procTimes = items
        .filter(c => c.firstActionDate && c.closureDate)
        .map(c => (c.closureDate!.getTime() - c.firstActionDate!.getTime()) / (1000 * 60 * 60));
      const avgProc = average(procTimes);
      const late = items.filter(c => isComplaintLate(c, now)).length;
      return {
        channel: ch,
        total: items.length,
        closed: closed.length,
        closureRate: items.length > 0 ? roundToTenth((closed.length / items.length) * 100) : 0,
        lateRate: items.length > 0 ? roundToTenth((late / items.length) * 100) : 0,
        avgProcessingHours: roundToTenth(avgProc),
      };
    }).sort((a, b) => b.total - a.total);

    // ----- Delay reasons -----
    const delayReasons = groupByCount(
      complaints.filter(c => c.delayReason),
      c => c.delayReason!
    ).map(item => ({ name: item.name, count: item.count }));

    // ----- Recurring subjects (top subjects) -----
    const recurringSubjects = groupByCount(
      complaints,
      c => c.subject
    ).slice(0, 10).map(item => ({ name: item.name, count: item.count }));

    // ----- Recurring classifications (themes) -----
    const recurringClassifications = groupByCount(
      complaints,
      c => c.classification?.name || "غير مصنف"
    ).slice(0, 10).map(item => ({ name: item.name, count: item.count }));

    // ----- Anomaly detection: regions/departments with unusual spikes -----
    const byRegion = groupByCount(complaints, c => c.region?.name || "غير محدد");
    const byDepartment = groupByCount(complaints, c => c.department?.name || "غير محدد");
    const byClassification = groupByCount(complaints, c => c.classification?.name || "غير مصنف");

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

    const regionAnomalies = computeAnomalies(byRegion);
    const departmentAnomalies = computeAnomalies(byDepartment);

    // ----- Previous-period distributions for comparison -----
    let previousDistributions: {
      byRegion: { name: string; count: number }[];
      byDepartment: { name: string; count: number }[];
      byClassification: { name: string; count: number }[];
      byChannel: { name: string; count: number }[];
    } | null = null;

    const prevRange = getPreviousRange(from, to);
    if (prevRange) {
      const prevComplaints = await db.complaint.findMany({
        where: { ...where, receivedDate: prevRange },
        include: { region: true, department: true, classification: true },
      });
      previousDistributions = {
        byRegion: groupByCount(prevComplaints, c => c.region?.name || "غير محدد"),
        byDepartment: groupByCount(prevComplaints, c => c.department?.name || "غير محدد"),
        byClassification: groupByCount(prevComplaints, c => c.classification?.name || "غير مصنف"),
        byChannel: groupByCount(prevComplaints, c => c.channel),
      };
    }

    // ----- Priority / severity breakdown per region (for pattern tab) -----
    const regionPriorityBreakdown = regions.map(r => {
      const items = complaints.filter(c => (c.region?.name || "غير محدد") === r);
      const row: Record<string, number | string> = { region: r, total: items.length };
      row["حرجة"] = items.filter(c => c.priority === "critical").length;
      row["عالية"] = items.filter(c => c.priority === "high").length;
      row["متوسطة"] = items.filter(c => c.priority === "medium").length;
      row["منخفضة"] = items.filter(c => c.priority === "low").length;
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
        regions: regionAnomalies,
        departments: departmentAnomalies,
        classifications: byClassification.map(i => ({
          name: i.name,
          count: i.count,
        })),
      },
      previousDistributions,
      regionPriorityBreakdown,
      totalCount: complaints.length,
    });
  } catch (error) {
    console.error("Analytics API error:", error);
    return NextResponse.json({ error: "Failed to fetch analytics data" }, { status: 500 });
  }
}
