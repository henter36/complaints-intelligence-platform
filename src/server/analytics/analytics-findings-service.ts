import { type ComplaintKpiResult } from "@/server/complaints/complaint-kpi-service";
import {
  AnalyticalFindingSchema,
  type AnalyticalFinding,
} from "@/lib/analytics/analytical-finding";
import { evaluateComparison } from "@/lib/analytics/comparison-evaluation";

const DETECTOR_VERSION = "quantitative-v1";

function nowIso(): string {
  return new Date().toISOString();
}

function clampScore(score: number): number {
  return Math.min(100, Math.max(0, Math.round(score)));
}

function buildFinding(data: AnalyticalFinding): AnalyticalFinding {
  return AnalyticalFindingSchema.parse(data);
}

export function computeAnalyticsFindings(
  result: ComplaintKpiResult,
  fromDate: string | null = null,
  toDate: string | null = null
): AnalyticalFinding[] {
  const detectedAt = nowIso();
  const basePeriod = { from: fromDate, to: toDate };
  const hasPrevious = result.previousDistributions !== null;

  const findings: AnalyticalFinding[] = [
    ...detectVolumeSpike(result, hasPrevious, basePeriod, detectedAt),
    ...detectBacklogGrowth(result, hasPrevious, basePeriod, detectedAt),
    ...detectCurrentlyOverdue(result, basePeriod, detectedAt),
    ...detectConcentration(result, hasPrevious, basePeriod, detectedAt),
    ...detectDataQuality(result, basePeriod, detectedAt),
  ];

  return findings.sort((a, b) => b.priorityScore - a.priorityScore);
}

// ---------- VOLUME_SPIKE ----------

function detectVolumeSpike(
  result: ComplaintKpiResult,
  hasPrevious: boolean,
  period: { from: string | null; to: string | null },
  detectedAt: string
): AnalyticalFinding[] {
  if (!hasPrevious || !result.previousDistributions) return [];

  const findings: AnalyticalFinding[] = [];
  const { byRegion: prevRegions } = result.previousDistributions;

  for (const curr of result.distributions.byRegion) {
    const prev = prevRegions.find((r) => r.name === curr.name);
    const evaluation = evaluateComparison(curr.total, prev?.total ?? null, true);

    if (evaluation.state !== "INCREASE" || evaluation.changeRate === null) continue;
    if (evaluation.changeRate < 50) continue;

    const severity =
      evaluation.changeRate >= 200 ? "CRITICAL" :
      evaluation.changeRate >= 100 ? "HIGH" : "MEDIUM";

    const prevCount = prev?.total ?? 0;
    const confidence =
      prevCount >= 10 ? "HIGH" :
      prevCount >= 3 ? "MEDIUM" : "LOW";

    findings.push(buildFinding({
      id: `volume_spike:region:${curr.name}:${period.from ?? ""}:${period.to ?? ""}`,
      type: "VOLUME_SPIKE",
      entityType: "REGION",
      entityId: null,
      entityName: curr.name,
      currentValue: curr.total,
      previousValue: prevCount,
      difference: evaluation.difference,
      changeRate: evaluation.changeRate,
      severity,
      priorityScore: clampScore(evaluation.changeRate * 0.4 + (severity === "CRITICAL" ? 40 : severity === "HIGH" ? 20 : 0)),
      confidence,
      detectionSource: "QUANTITATIVE",
      explanation: `ارتفع عدد شكاوى ${curr.name} بنسبة ${evaluation.changeRate}% مقارنة بالفترة السابقة (${prevCount} → ${curr.total}).`,
      supportingMetrics: {
        currentCount: curr.total,
        previousCount: prevCount,
        changeRate: evaluation.changeRate,
        openComplaints: curr.open,
        lateComplaints: curr.currentlyLate,
      },
      evidenceComplaintIds: [],
      evidenceSpans: [],
      limitations: ["المقارنة مبنية على الفترة الزمنية المحددة فقط ولا تأخذ في الحسبان التغيرات الموسمية."],
      drilldownFilters: {
        region: curr.name,
        ...(period.from ? { from: period.from } : {}),
        ...(period.to ? { to: period.to } : {}),
      },
      firstDetectedAt: detectedAt,
      lastDetectedAt: detectedAt,
      detectorVersion: DETECTOR_VERSION,
    }));
  }

  return findings.slice(0, 5);
}

// ---------- BACKLOG_GROWTH ----------

function detectBacklogGrowth(
  result: ComplaintKpiResult,
  hasPrevious: boolean,
  period: { from: string | null; to: string | null },
  detectedAt: string
): AnalyticalFinding[] {
  const currentOpen = result.volume.open;
  const previousOpen = result.kpis.openComplaints.previousValue;
  const evaluation = evaluateComparison(currentOpen, previousOpen, hasPrevious);

  if (evaluation.state !== "INCREASE" || evaluation.changeRate === null) return [];
  if (evaluation.changeRate < 20) return [];

  const severity =
    evaluation.changeRate >= 100 ? "HIGH" :
    evaluation.changeRate >= 50 ? "MEDIUM" : "LOW";

  return [buildFinding({
    id: `backlog_growth:global:${period.from ?? ""}:${period.to ?? ""}`,
    type: "BACKLOG_GROWTH",
    entityType: "GLOBAL",
    entityId: null,
    entityName: "إجمالي الشكاوى",
    currentValue: currentOpen,
    previousValue: previousOpen,
    difference: evaluation.difference,
    changeRate: evaluation.changeRate,
    severity,
    priorityScore: clampScore(evaluation.changeRate * 0.5),
    confidence: (previousOpen ?? 0) >= 5 ? "HIGH" : "MEDIUM",
    detectionSource: "QUANTITATIVE",
    explanation: `نمت أعداد الشكاوى المفتوحة بنسبة ${evaluation.changeRate}% مقارنة بالفترة السابقة (${previousOpen ?? 0} → ${currentOpen}).`,
    supportingMetrics: {
      currentOpen,
      previousOpen: previousOpen ?? 0,
      changeRate: evaluation.changeRate,
      totalComplaints: result.volume.total,
      overdueNoAction: result.performance.overdueNoAction,
    },
    evidenceComplaintIds: [],
    evidenceSpans: [],
    limitations: ["قد يعكس الارتفاع ضغطاً موسمياً أو تغيرات في سياسات الإغلاق."],
    drilldownFilters: {
      status: "open",
      ...(period.from ? { from: period.from } : {}),
      ...(period.to ? { to: period.to } : {}),
    },
    firstDetectedAt: detectedAt,
    lastDetectedAt: detectedAt,
    detectorVersion: DETECTOR_VERSION,
  })];
}

// ---------- CURRENTLY_OVERDUE ----------

function detectCurrentlyOverdue(
  result: ComplaintKpiResult,
  period: { from: string | null; to: string | null },
  detectedAt: string
): AnalyticalFinding[] {
  const lateCount = result.volume.late;
  const lateRate = result.performance.lateRate;
  if (lateCount === 0 || lateRate < 10) return [];

  const severity =
    lateRate >= 40 ? "CRITICAL" :
    lateRate >= 25 ? "HIGH" : "MEDIUM";

  return [buildFinding({
    id: `overdue:global:${period.from ?? ""}:${period.to ?? ""}`,
    type: "CURRENTLY_OVERDUE",
    entityType: "GLOBAL",
    entityId: null,
    entityName: "إجمالي الشكاوى",
    currentValue: lateCount,
    previousValue: null,
    difference: null,
    changeRate: null,
    severity,
    priorityScore: clampScore(lateRate + (result.performance.overdueNoAction > 0 ? 20 : 0)),
    confidence: "HIGH",
    detectionSource: "QUANTITATIVE",
    explanation: `${lateCount} شكوى متأخرة حالياً (${lateRate}% من الإجمالي). ${result.performance.overdueNoAction > 0 ? `منها ${result.performance.overdueNoAction} بدون إجراء.` : ""}`,
    supportingMetrics: {
      lateCount,
      lateRate,
      overdueNoAction: result.performance.overdueNoAction,
      overdueNoActionRate: result.performance.overdueNoActionRate,
      totalComplaints: result.volume.total,
    },
    evidenceComplaintIds: [],
    evidenceSpans: [],
    limitations: [],
    drilldownFilters: {
      isLate: true,
      ...(period.from ? { from: period.from } : {}),
      ...(period.to ? { to: period.to } : {}),
    },
    firstDetectedAt: detectedAt,
    lastDetectedAt: detectedAt,
    detectorVersion: DETECTOR_VERSION,
  })];
}

// ---------- CONCENTRATION ----------

function detectConcentration(
  result: ComplaintKpiResult,
  hasPrevious: boolean,
  period: { from: string | null; to: string | null },
  detectedAt: string
): AnalyticalFinding[] {
  const total = result.volume.total;
  if (total === 0) return [];

  const topRegion = result.distributions.byRegion[0];
  if (!topRegion) return [];

  const sharePercent = (topRegion.total / total) * 100;
  if (sharePercent < 40) return [];

  const prevTotal = hasPrevious ? (result.previousDistributions?.byRegion.reduce((s, r) => s + r.total, 0) ?? null) : null;
  const prevTopRegion = result.previousDistributions?.byRegion.find((r) => r.name === topRegion.name);
  const prevSharePercent = (prevTotal && prevTotal > 0 && prevTopRegion)
    ? (prevTopRegion.total / prevTotal) * 100
    : null;

  const severity = sharePercent >= 60 ? "HIGH" : "MEDIUM";

  return [buildFinding({
    id: `concentration:region:${topRegion.name}:${period.from ?? ""}:${period.to ?? ""}`,
    type: "CONCENTRATION",
    entityType: "REGION",
    entityId: null,
    entityName: topRegion.name,
    currentValue: topRegion.total,
    previousValue: prevTopRegion?.total ?? null,
    difference: prevTopRegion ? topRegion.total - prevTopRegion.total : null,
    changeRate: prevSharePercent !== null ? Math.round((sharePercent - prevSharePercent) * 10) / 10 : null,
    severity,
    priorityScore: clampScore(sharePercent - 30),
    confidence: total >= 20 ? "HIGH" : total >= 5 ? "MEDIUM" : "LOW",
    detectionSource: "QUANTITATIVE",
    explanation: `منطقة ${topRegion.name} تمثل ${Math.round(sharePercent)}% من إجمالي الشكاوى (${topRegion.total} من ${total}).`,
    supportingMetrics: {
      regionCount: topRegion.total,
      totalComplaints: total,
      sharePercent: Math.round(sharePercent * 10) / 10,
      previousSharePercent: prevSharePercent !== null ? Math.round(prevSharePercent * 10) / 10 : null,
    },
    evidenceComplaintIds: [],
    evidenceSpans: [],
    limitations: ["التركيز الجغرافي قد يعكس حجم السكان أو معدلات الإبلاغ وليس بالضرورة مشكلة في الخدمة."],
    drilldownFilters: {
      region: topRegion.name,
      ...(period.from ? { from: period.from } : {}),
      ...(period.to ? { to: period.to } : {}),
    },
    firstDetectedAt: detectedAt,
    lastDetectedAt: detectedAt,
    detectorVersion: DETECTOR_VERSION,
  })];
}

// ---------- DATA_QUALITY ----------

function detectDataQuality(
  result: ComplaintKpiResult,
  period: { from: string | null; to: string | null },
  detectedAt: string
): AnalyticalFinding[] {
  const { missingFields, dataQualityRate } = result.alerts;
  if (dataQualityRate >= 80 || missingFields === 0) return [];

  const severity = dataQualityRate < 60 ? "HIGH" : "MEDIUM";

  return [buildFinding({
    id: `data_quality:global:${period.from ?? ""}:${period.to ?? ""}`,
    type: "DATA_QUALITY",
    entityType: "GLOBAL",
    entityId: null,
    entityName: "إجمالي الشكاوى",
    currentValue: missingFields,
    previousValue: null,
    difference: null,
    changeRate: null,
    severity,
    priorityScore: clampScore(100 - dataQualityRate),
    confidence: "HIGH",
    detectionSource: "QUANTITATIVE",
    explanation: `${missingFields} شكوى تفتقد حقولاً أساسية (المنطقة أو الإدارة أو التصنيف). معدل جودة البيانات: ${dataQualityRate}%.`,
    supportingMetrics: {
      missingFields,
      dataQualityRate,
      totalComplaints: result.volume.total,
    },
    evidenceComplaintIds: [],
    evidenceSpans: [],
    limitations: ["الحقول المفقودة قد تعود لاختلافات في نماذج الإدخال أو عمليات الاستيراد."],
    drilldownFilters: {
      hasMissingFields: true,
      ...(period.from ? { from: period.from } : {}),
      ...(period.to ? { to: period.to } : {}),
    },
    firstDetectedAt: detectedAt,
    lastDetectedAt: detectedAt,
    detectorVersion: DETECTOR_VERSION,
  })];
}

