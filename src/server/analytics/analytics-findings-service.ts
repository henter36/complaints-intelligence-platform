import {
  type ComplaintKpiResult,
  type ComplaintGroupMetrics,
} from "@/server/complaints/complaint-kpi-service";
import {
  AnalyticalFindingSchema,
  type AnalyticalFinding,
  type AnalyticalSeverity,
  type AnalyticalConfidence,
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

// ---------- Period helpers ----------

function buildPeriodKey(period: { from: string | null; to: string | null }): string {
  return `${period.from ?? ""}:${period.to ?? ""}`;
}

function buildPeriodFilters(
  period: { from: string | null; to: string | null }
): Record<string, string> {
  const filters: Record<string, string> = {};
  if (period.from) filters.from = period.from;
  if (period.to) filters.to = period.to;
  return filters;
}

// ---------- Volume spike helpers ----------

function resolveVolumeSpikeSeverity(changeRate: number): AnalyticalSeverity {
  if (changeRate >= 200) return "CRITICAL";
  if (changeRate >= 100) return "HIGH";
  return "MEDIUM";
}

function resolveVolumeSpikeConfidence(previousCount: number): AnalyticalConfidence {
  if (previousCount >= 10) return "HIGH";
  if (previousCount >= 3) return "MEDIUM";
  return "LOW";
}

function computeVolumeSpikeSeverityBonus(severity: AnalyticalSeverity): number {
  if (severity === "CRITICAL") return 40;
  if (severity === "HIGH") return 20;
  return 0;
}

function computeVolumeSpikePriority(changeRate: number, severity: AnalyticalSeverity): number {
  return clampScore(changeRate * 0.4 + computeVolumeSpikeSeverityBonus(severity));
}

function buildVolumeSpikeFinding(
  curr: ComplaintGroupMetrics,
  prevCount: number | null,
  period: { from: string | null; to: string | null },
  detectedAt: string
): AnalyticalFinding | null {
  const evaluation = evaluateComparison(curr.total, prevCount, true);
  if (evaluation.state !== "INCREASE" || evaluation.changeRate === null) return null;
  if (evaluation.changeRate < 50) return null;

  const severity = resolveVolumeSpikeSeverity(evaluation.changeRate);
  const previousCount = prevCount ?? 0;
  const confidence = resolveVolumeSpikeConfidence(previousCount);

  return buildFinding({
    id: `volume_spike:region:${curr.name}:${buildPeriodKey(period)}`,
    type: "VOLUME_SPIKE",
    entityType: "REGION",
    entityId: null,
    entityName: curr.name,
    currentValue: curr.total,
    previousValue: previousCount,
    difference: evaluation.difference,
    changeRate: evaluation.changeRate,
    severity,
    priorityScore: computeVolumeSpikePriority(evaluation.changeRate, severity),
    confidence,
    detectionSource: "QUANTITATIVE",
    explanation: `ارتفع عدد شكاوى ${curr.name} بنسبة ${evaluation.changeRate}% مقارنة بالفترة السابقة (${previousCount} → ${curr.total}).`,
    supportingMetrics: {
      currentCount: curr.total,
      previousCount,
      changeRate: evaluation.changeRate,
      openComplaints: curr.open,
      lateComplaints: curr.currentlyLate,
    },
    evidenceComplaintIds: [],
    evidenceSpans: [],
    limitations: ["المقارنة مبنية على الفترة الزمنية المحددة فقط ولا تأخذ في الحسبان التغيرات الموسمية."],
    drilldownFilters: {
      region: curr.name,
      ...buildPeriodFilters(period),
    },
    firstDetectedAt: detectedAt,
    lastDetectedAt: detectedAt,
    detectorVersion: DETECTOR_VERSION,
  });
}

// ---------- Backlog helpers ----------

function resolveBacklogSeverity(changeRate: number): AnalyticalSeverity {
  if (changeRate >= 100) return "HIGH";
  if (changeRate >= 50) return "MEDIUM";
  return "LOW";
}

// ---------- Overdue helpers ----------

function resolveOverdueSeverity(lateRate: number): AnalyticalSeverity {
  if (lateRate >= 40) return "CRITICAL";
  if (lateRate >= 25) return "HIGH";
  return "MEDIUM";
}

function buildOverdueExplanation(
  lateCount: number,
  lateRate: number,
  overdueNoAction: number
): string {
  const summary = `${lateCount} شكوى متأخرة حالياً (${lateRate}% من الإجمالي).`;
  if (overdueNoAction === 0) return summary;
  const noActionSummary = `منها ${overdueNoAction} بدون إجراء.`;
  return `${summary} ${noActionSummary}`;
}

// ---------- Concentration helpers ----------

function resolveConcentrationConfidence(total: number): AnalyticalConfidence {
  if (total >= 20) return "HIGH";
  if (total >= 5) return "MEDIUM";
  return "LOW";
}

// ---------- Public API ----------

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

  const previousByRegion = new Map(
    result.previousDistributions.byRegion.map((r) => [r.name, r.total])
  );

  const findings: AnalyticalFinding[] = [];
  for (const curr of result.distributions.byRegion) {
    const prevCount = previousByRegion.get(curr.name) ?? null;
    const finding = buildVolumeSpikeFinding(curr, prevCount, period, detectedAt);
    if (finding !== null) {
      findings.push(finding);
    }
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

  const severity = resolveBacklogSeverity(evaluation.changeRate);

  return [buildFinding({
    id: `backlog_growth:global:${buildPeriodKey(period)}`,
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
      ...buildPeriodFilters(period),
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

  const { overdueNoAction, overdueNoActionRate } = result.performance;
  const severity = resolveOverdueSeverity(lateRate);

  return [buildFinding({
    id: `overdue:global:${buildPeriodKey(period)}`,
    type: "CURRENTLY_OVERDUE",
    entityType: "GLOBAL",
    entityId: null,
    entityName: "إجمالي الشكاوى",
    currentValue: lateCount,
    previousValue: null,
    difference: null,
    changeRate: null,
    severity,
    priorityScore: clampScore(lateRate + (overdueNoAction > 0 ? 20 : 0)),
    confidence: "HIGH",
    detectionSource: "QUANTITATIVE",
    explanation: buildOverdueExplanation(lateCount, lateRate, overdueNoAction),
    supportingMetrics: {
      lateCount,
      lateRate,
      overdueNoAction,
      overdueNoActionRate,
      totalComplaints: result.volume.total,
    },
    evidenceComplaintIds: [],
    evidenceSpans: [],
    limitations: [],
    drilldownFilters: {
      isLate: true,
      ...buildPeriodFilters(period),
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

  const prevTotal = hasPrevious
    ? (result.previousDistributions?.byRegion.reduce((s, r) => s + r.total, 0) ?? null)
    : null;
  const prevTopRegion = result.previousDistributions?.byRegion.find((r) => r.name === topRegion.name);
  const prevSharePercent =
    prevTotal !== null && prevTotal > 0 && prevTopRegion
      ? (prevTopRegion.total / prevTotal) * 100
      : null;

  const severity = sharePercent >= 60 ? "HIGH" : "MEDIUM";

  return [buildFinding({
    id: `concentration:region:${topRegion.name}:${buildPeriodKey(period)}`,
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
    confidence: resolveConcentrationConfidence(total),
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
      ...buildPeriodFilters(period),
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

  const severity: AnalyticalSeverity = dataQualityRate < 60 ? "HIGH" : "MEDIUM";

  return [buildFinding({
    id: `data_quality:global:${buildPeriodKey(period)}`,
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
      ...buildPeriodFilters(period),
    },
    firstDetectedAt: detectedAt,
    lastDetectedAt: detectedAt,
    detectorVersion: DETECTOR_VERSION,
  })];
}
