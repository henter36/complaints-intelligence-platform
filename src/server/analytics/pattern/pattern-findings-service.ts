import {
  AnalyticalFindingSchema,
  type AnalyticalFinding,
  type AnalyticalSeverity,
} from "@/lib/analytics/analytical-finding";
import {
  PATTERN_ANALYSIS_CONFIG,
  type PatternAnalysisConfig,
} from "@/lib/analytics/pattern-analysis-config";
import { classifyTrend, isNegativeTrend, type PeriodUnit, type TrendPattern } from "@/lib/analytics/multi-period-trend";
import { evaluateChronicIssue } from "@/lib/analytics/chronic-issue-detection";
import { computePriorityScore, type PriorityBand } from "@/lib/analytics/priority-score";
import {
  analyzeClassificationConcentration,
  analyzeWingConcentration,
  type ClassificationConcentrationResult,
} from "@/lib/analytics/concentration-analysis";
import {
  detectCompositionShift,
  detectCrossFacilitySpread,
  detectMultiIssueFacilities,
  type CompositionShiftInput,
  type CompositionShiftResult,
  type FacilityClassificationChange,
  type FacilityClassificationSignal,
} from "@/lib/analytics/cross-facility-patterns";
import {
  detectMassComplaints,
  detectRepeatComplainants,
  type ComplainantRecord,
} from "@/lib/analytics/repeat-complainant";
import { buildPeriodChangeDigest, type PatternSnapshot, type PeriodChangeDigest } from "@/lib/analytics/period-change-digest";
import type { PatternSeries, PatternSeriesRecord } from "./pattern-period-series-service";

const DETECTOR_VERSION = "pattern-v1";
const UNCLASSIFIED_KEY = "UNCLASSIFIED";
const UNCLASSIFIED_LABEL = "غير مصنف";
const MAX_FINDINGS_PER_TYPE = 10;
const MAX_EVIDENCE_IDS = 20;

function nowIso(): string {
  return new Date().toISOString();
}

function clampScore(score: number): number {
  return Math.min(100, Math.max(0, Math.round(score)));
}

function buildFinding(data: AnalyticalFinding): AnalyticalFinding {
  return AnalyticalFindingSchema.parse(data);
}

function bandToSeverity(band: PriorityBand): AnalyticalSeverity {
  if (band === "HIGH") return "HIGH";
  if (band === "MEDIUM") return "MEDIUM";
  return "LOW";
}

function cellKey(facility: string, classificationKey: string): string {
  return `${facility} ${classificationKey}`;
}

function isTechnicalDuplicate(record: PatternSeriesRecord): boolean {
  return record.isPotentialDuplicate || Boolean(record.duplicateOfId);
}

function classificationKeyOf(record: PatternSeriesRecord): { key: string; label: string } {
  if (record.classificationId) return { key: record.classificationId, label: record.classificationLabel ?? record.classificationId };
  return { key: UNCLASSIFIED_KEY, label: UNCLASSIFIED_LABEL };
}

// ---------------------------------------------------------------------------
// Single-pass aggregation
// ---------------------------------------------------------------------------

type CellAggregate = {
  total: number;
  byWing: Map<string, number>;
  withWingData: number;
  complaintIds: string[];
};

type ComplainantStat = { periods: Set<number>; count: number };

type ClassificationAggregate = {
  label: string;
  /** periodIndex -> per-period aggregate (volume, wing breakdown, evidence ids). */
  periods: Map<number, CellAggregate>;
  /** complainantIdentifier -> stats across the WHOLE fetched window, for this exact facility×classification. */
  complainants: Map<string, ComplainantStat>;
};

type FacilityMap = Map<string, Map<string, ClassificationAggregate>>;

function buildAggregation(records: readonly PatternSeriesRecord[]): FacilityMap {
  const byFacility: FacilityMap = new Map();

  for (const record of records) {
    if (isTechnicalDuplicate(record)) continue;
    const { key: classKey, label } = classificationKeyOf(record);

    const classMap = byFacility.get(record.facility) ?? new Map<string, ClassificationAggregate>();
    byFacility.set(record.facility, classMap);

    const agg = classMap.get(classKey) ?? { label, periods: new Map<number, CellAggregate>(), complainants: new Map<string, ComplainantStat>() };
    classMap.set(classKey, agg);

    const cell = agg.periods.get(record.periodIndex) ?? { total: 0, byWing: new Map<string, number>(), withWingData: 0, complaintIds: [] };
    cell.total += 1;
    if (record.wingCode) {
      cell.byWing.set(record.wingCode, (cell.byWing.get(record.wingCode) ?? 0) + 1);
      cell.withWingData += 1;
    }
    if (cell.complaintIds.length < MAX_EVIDENCE_IDS) cell.complaintIds.push(record.complaintId);
    agg.periods.set(record.periodIndex, cell);

    if (record.complainantIdentifier?.trim()) {
      const stat = agg.complainants.get(record.complainantIdentifier) ?? { periods: new Set<number>(), count: 0 };
      stat.periods.add(record.periodIndex);
      stat.count += 1;
      agg.complainants.set(record.complainantIdentifier, stat);
    }
  }

  return byFacility;
}

function countsFor(agg: ClassificationAggregate, totalPeriods: number): number[] {
  const counts: number[] = [];
  for (let i = 0; i < totalPeriods; i++) counts.push(agg.periods.get(i)?.total ?? 0);
  return counts;
}

function facilityTotalsByPeriod(byFacility: FacilityMap, totalPeriods: number): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const [facility, classMap] of byFacility) {
    const totals = new Array<number>(totalPeriods).fill(0);
    for (const agg of classMap.values()) {
      for (let i = 0; i < totalPeriods; i++) totals[i] += agg.periods.get(i)?.total ?? 0;
    }
    result.set(facility, totals);
  }
  return result;
}

function classificationOrgTotalsByPeriod(byFacility: FacilityMap, totalPeriods: number): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const classMap of byFacility.values()) {
    for (const [classKey, agg] of classMap) {
      const totals = result.get(classKey) ?? new Array<number>(totalPeriods).fill(0);
      for (let i = 0; i < totalPeriods; i++) totals[i] += agg.periods.get(i)?.total ?? 0;
      result.set(classKey, totals);
    }
  }
  return result;
}

function orgTotalsByPeriod(facilityTotals: Map<string, number[]>, totalPeriods: number): number[] {
  const totals = new Array<number>(totalPeriods).fill(0);
  for (const values of facilityTotals.values()) {
    for (let i = 0; i < totalPeriods; i++) totals[i] += values[i];
  }
  return totals;
}

/** Repeat/mass stats scoped to exactly this facility×classification cell, across the whole fetched window. */
function cellComplainantStats(agg: ClassificationAggregate): {
  repeatComplaints: number;
  distinctComplainants: number;
} {
  let repeatComplaints = 0;
  for (const stat of agg.complainants.values()) {
    if (stat.periods.size >= 2) repeatComplaints += stat.count;
  }
  return { repeatComplaints, distinctComplainants: agg.complainants.size };
}

function periodFilters(series: PatternSeries): Record<string, string> {
  const current = series.periods[series.periods.length - 1];
  if (!current) return {};
  return {
    from: current.from.toISOString().slice(0, 10),
    to: new Date(current.toExclusive.getTime() - 1).toISOString().slice(0, 10),
  };
}

/**
 * Describes every period in the fetched window as plain ISO date strings —
 * the exact series that produced every per-cell finding. Exposed once per
 * request (not duplicated per finding) so a UI timeline can zip this against
 * a finding's `periodCounts` without any additional query (spec §5).
 */
export function describePatternSeriesPeriods(series: PatternSeries): { from: string; to: string }[] {
  return series.periods.map((period) => ({
    from: period.from.toISOString().slice(0, 10),
    to: new Date(period.toExclusive.getTime() - 1).toISOString().slice(0, 10),
  }));
}

function trendPatternArabicLabel(pattern: TrendPattern): string {
  switch (pattern) {
    case "ESCALATING": return "تصاعد مستمر";
    case "EMERGING": return "مشكلة ناشئة";
    case "RELAPSE_AFTER_IMPROVEMENT": return "عودة المشكلة بعد تحسن";
    case "VOLATILE": return "نمط متذبذب دون تحسن مستقر";
    case "NO_MEANINGFUL_IMPROVEMENT": return "استمرار دون تحسن ملموس";
    case "CONTINUED_RISE": return "استمرار الارتفاع";
    default: return "نمط ملحوظ";
  }
}

type CellWork = {
  facility: string;
  classKey: string;
  label: string;
  counts: number[];
  trendCurrent: ReturnType<typeof classifyTrend>;
  concentration: ClassificationConcentrationResult | null;
  cell: CellAggregate | undefined;
  currentCount: number;
  facilityTotalCurrent: number;
  repeatRatePercent: number;
  distinctComplainants: number;
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function computePatternFindings(
  series: PatternSeries,
  config: PatternAnalysisConfig = PATTERN_ANALYSIS_CONFIG,
  periodUnit: PeriodUnit = "فترة"
): AnalyticalFinding[] {
  const totalPeriods = series.periods.length;
  // Need minPeriodsForContinuity current periods + 1 extra for the
  // "as of previous period" snapshot used by the change digest.
  if (totalPeriods < config.minPeriodsForContinuity + 1) return [];

  const detectedAt = nowIso();
  const filters = periodFilters(series);
  const byFacility = buildAggregation(series.records);
  const facilityTotals = facilityTotalsByPeriod(byFacility, totalPeriods);
  const classificationOrgTotals = classificationOrgTotalsByPeriod(byFacility, totalPeriods);
  const orgTotals = orgTotalsByPeriod(facilityTotals, totalPeriods);

  const currentIdx = totalPeriods - 1;
  const previousIdx = totalPeriods - 2;

  const cellWork: CellWork[] = [];
  const crossFacilityChangesCurrent: FacilityClassificationChange[] = [];
  const compositionInputsByFacility = new Map<string, { label: string; currentCount: number; previousCount: number }[]>();
  const multiIssueSignals: FacilityClassificationSignal[] = [];

  for (const [facility, classMap] of byFacility) {
    const facilityTotalSeries = facilityTotals.get(facility) ?? new Array<number>(totalPeriods).fill(0);
    const facilityCompositionList: { label: string; currentCount: number; previousCount: number }[] = [];

    for (const [classKey, agg] of classMap) {
      const { label } = agg;
      const counts = countsFor(agg, totalPeriods);
      const trendCurrent = classifyTrend(counts.slice(1), config, periodUnit);
      if (trendCurrent.pattern === "INSUFFICIENT_DATA") continue;

      const facilityTotalCurrent = facilityTotalSeries[currentIdx];
      const currentCount = counts[currentIdx];
      const previousCount = counts[previousIdx] ?? 0;

      const concentration = analyzeClassificationConcentration(
        {
          facility,
          classificationLabel: label,
          facilityClassificationCount: currentCount,
          facilityTotal: facilityTotalCurrent,
          orgWideClassificationCountExcludingFacility:
            (classificationOrgTotals.get(classKey)?.[currentIdx] ?? 0) - currentCount,
          orgWideTotalExcludingFacility: (orgTotals[currentIdx] ?? 0) - facilityTotalCurrent,
        },
        config
      );

      const { repeatComplaints, distinctComplainants } = cellComplainantStats(agg);
      const currentWindowTotal = counts.slice(1).reduce((sum, v) => sum + v, 0);
      const repeatRatePercent = currentWindowTotal > 0 ? (repeatComplaints / currentWindowTotal) * 100 : 0;

      cellWork.push({
        facility,
        classKey,
        label,
        counts,
        trendCurrent,
        concentration,
        cell: agg.periods.get(currentIdx),
        currentCount,
        facilityTotalCurrent,
        repeatRatePercent,
        distinctComplainants,
      });

      crossFacilityChangesCurrent.push({ facility, classificationLabel: label, currentCount, previousCount });
      facilityCompositionList.push({ label, currentCount, previousCount });
      multiIssueSignals.push({
        facility,
        classificationLabel: label,
        isNegativeTrend: isNegativeTrend(trendCurrent.pattern),
        streakPeriods: trendCurrent.streakPeriods,
        sharePercent: concentration?.facilitySharePercent ?? 0,
      });
    }

    compositionInputsByFacility.set(facility, facilityCompositionList);
  }

  // ---- Cross-facility spread, composition shift, multi-issue (need the full cell list first) ----
  const crossFacilitySpread = detectCrossFacilitySpread(crossFacilityChangesCurrent, config);
  const spreadByClassification = new Map(crossFacilitySpread.map((s) => [s.classificationLabel, s]));

  const compositionShifts: CompositionShiftResult[] = [];
  for (const [facility, classifications] of compositionInputsByFacility) {
    const facilityTotalSeries = facilityTotals.get(facility) ?? [];
    const input: CompositionShiftInput = {
      facility,
      facilityTotalCurrent: facilityTotalSeries[currentIdx] ?? 0,
      facilityTotalPrevious: facilityTotalSeries[previousIdx] ?? 0,
      classifications,
    };
    const shift = detectCompositionShift(input, config);
    if (shift) compositionShifts.push(shift);
  }

  const multiIssueFacilities = detectMultiIssueFacilities(multiIssueSignals, config);
  const multiIssueByFacility = new Map(multiIssueFacilities.map((f) => [f.facility, f]));

  // ---- Repeat complainant + mass complaint findings (facility-wide, spec §1/§7) ----
  const complainantRecords: ComplainantRecord[] = series.records
    .filter((r) => !isTechnicalDuplicate(r))
    .map((r) => {
      const { key, label } = classificationKeyOf(r);
      return {
        complaintId: r.complaintId,
        complainantIdentifier: r.complainantIdentifier,
        facility: r.facility,
        classificationId: key === UNCLASSIFIED_KEY ? null : key,
        classificationName: key === UNCLASSIFIED_KEY ? null : label,
        subject: r.subject,
        periodIndex: r.periodIndex,
        isPotentialDuplicate: r.isPotentialDuplicate,
        duplicateOfId: r.duplicateOfId,
      };
    });

  const windowFacilityTotals = new Map<string, number>();
  for (const [facility, totals] of facilityTotals) {
    windowFacilityTotals.set(facility, totals.slice(1).reduce((sum, v) => sum + v, 0));
  }

  const repeatSummaries = detectRepeatComplainants(complainantRecords, windowFacilityTotals, config);
  const massComplaints = detectMassComplaints(complainantRecords, config);

  // ---- Priority score + finding construction per cell ----
  const chronicFindings: AnalyticalFinding[] = [];
  const trendFindings: AnalyticalFinding[] = [];
  const improvementFindings: AnalyticalFinding[] = [];
  const currentSnapshots: PatternSnapshot[] = [];
  const previousSnapshots: PatternSnapshot[] = [];

  for (const work of cellWork) {
    const { facility, classKey, label, counts, trendCurrent, concentration, cell, currentCount, repeatRatePercent, distinctComplainants } = work;
    const key = cellKey(facility, classKey);
    const spread = spreadByClassification.get(label);
    const multiIssue = multiIssueByFacility.get(facility);

    const chronic = evaluateChronicIssue(
      { trend: trendCurrent, repeatRatePercent, distinctComplainants, concentrationDeltaPercent: concentration?.deltaPercent ?? 0 },
      config
    );

    const priority = computePriorityScore(
      {
        currentValue: currentCount,
        changeRatePercent: trendCurrent.overallChangePercent,
        hasSufficientVolume: currentCount >= config.minComplaintsForSignal,
        streakPeriods: trendCurrent.streakPeriods,
        windowPeriods: totalPeriods - 1,
        repeatRatePercent,
        distinctComplainants,
        concentrationDeltaPercent: concentration?.deltaPercent ?? 0,
        affectedClassificationsCount: multiIssue?.affectedClassificationCount ?? 0,
        isRelapse: trendCurrent.pattern === "RELAPSE_AFTER_IMPROVEMENT",
        crossFacilityAffectedCount: spread?.affectedFacilityCount ?? 0,
      },
      config
    );

    const trendPrevious = classifyTrend(counts.slice(0, -1), config, periodUnit);
    const priorityBand = isNegativeTrend(trendCurrent.pattern) ? priority.band : "LOW";
    currentSnapshots.push({ key, facility, classificationLabel: label, pattern: trendCurrent.pattern, priorityBand });
    previousSnapshots.push({
      key,
      facility,
      classificationLabel: label,
      pattern: trendPrevious.pattern,
      priorityBand: isNegativeTrend(trendPrevious.pattern) ? "MEDIUM" : "LOW",
    });

    const evidenceComplaintIds = cell?.complaintIds ?? [];
    const drilldownFilters: Record<string, string> = {
      facility,
      ...(classKey !== UNCLASSIFIED_KEY ? { classificationId: classKey } : {}),
      ...filters,
    };
    const previousCount = counts[previousIdx] ?? 0;

    if (chronic.isChronic) {
      chronicFindings.push(
        buildFinding({
          id: `chronic_issue:${facility}:${classKey}:${filters.from ?? ""}`,
          type: "CHRONIC_ISSUE",
          entityType: "CLASSIFICATION",
          entityId: classKey === UNCLASSIFIED_KEY ? null : classKey,
          entityName: `${facility} — ${label}`,
          currentValue: currentCount,
          previousValue: previousCount,
          difference: currentCount - previousCount,
          changeRate: trendCurrent.overallChangePercent,
          severity: bandToSeverity(priority.band),
          priorityScore: priority.score,
          confidence: currentCount >= config.minComplaintsForSignal * 2 ? "HIGH" : "MEDIUM",
          detectionSource: "QUANTITATIVE",
          explanation: `${chronic.explanation} (${facility} — ${label}، ${trendCurrent.durationLabel}، ${currentCount} شكوى في الفترة الحالية).`,
          supportingMetrics: {
            currentCount,
            pattern: trendCurrent.pattern,
            streakPeriods: trendCurrent.streakPeriods,
            repeatRatePercent: Math.round(repeatRatePercent * 10) / 10,
            distinctComplainants,
            facilitySharePercent: concentration?.facilitySharePercent ?? null,
            orgAverageSharePercent: concentration?.orgAverageSharePercent ?? null,
            periodCounts: JSON.stringify(counts),
            chronicReasons: JSON.stringify(chronic.reasons),
            priorityReasons: JSON.stringify(priority.reasons),
          },
          evidenceComplaintIds,
          evidenceSpans: [],
          limitations: [],
          drilldownFilters,
          firstDetectedAt: detectedAt,
          lastDetectedAt: detectedAt,
          detectorVersion: DETECTOR_VERSION,
        })
      );
    } else if (isNegativeTrend(trendCurrent.pattern)) {
      trendFindings.push(
        buildFinding({
          id: `trend_pattern:${facility}:${classKey}:${filters.from ?? ""}`,
          type: "TREND_PATTERN",
          entityType: "CLASSIFICATION",
          entityId: classKey === UNCLASSIFIED_KEY ? null : classKey,
          entityName: `${facility} — ${label}`,
          currentValue: currentCount,
          previousValue: previousCount,
          difference: currentCount - previousCount,
          changeRate: trendCurrent.overallChangePercent,
          severity: bandToSeverity(priority.band),
          priorityScore: priority.score,
          confidence: currentCount >= config.minComplaintsForSignal ? "MEDIUM" : "LOW",
          detectionSource: "QUANTITATIVE",
          explanation: `${trendPatternArabicLabel(trendCurrent.pattern)} في ${label} بـ${facility}: ${trendCurrent.durationLabel}.`,
          supportingMetrics: {
            currentCount,
            pattern: trendCurrent.pattern,
            streakPeriods: trendCurrent.streakPeriods,
            periodCounts: JSON.stringify(counts),
            priorityReasons: JSON.stringify(priority.reasons),
          },
          evidenceComplaintIds,
          evidenceSpans: [],
          limitations:
            currentCount < config.minComplaintsForSignal
              ? ["الحجم الحالي أقل من الحد الأدنى المعتمد للإشارة؛ يعرض للمتابعة فقط."]
              : [],
          drilldownFilters,
          firstDetectedAt: detectedAt,
          lastDetectedAt: detectedAt,
          detectorVersion: DETECTOR_VERSION,
        })
      );
    } else if (trendCurrent.pattern === "SUSTAINED_IMPROVEMENT") {
      // The verified decline only covers the trailing `streakPeriods`
      // elements of the current window — counts[0] is one period BEFORE that
      // window even starts and isn't part of what was actually classified as
      // declining. Using it as "the start" could understate (or, in the
      // edge case where it happens to equal currentCount, zero out) a real
      // improvement. The genuine peak-before-decline is the first element of
      // the verified streak.
      const improvementStartValue = counts[counts.length - trendCurrent.streakPeriods] ?? counts[0] ?? 0;
      improvementFindings.push(
        buildFinding({
          id: `sustained_improvement:${facility}:${classKey}:${filters.from ?? ""}`,
          type: "SUSTAINED_IMPROVEMENT",
          entityType: "CLASSIFICATION",
          entityId: classKey === UNCLASSIFIED_KEY ? null : classKey,
          entityName: `${facility} — ${label}`,
          currentValue: currentCount,
          previousValue: improvementStartValue,
          difference: currentCount - improvementStartValue,
          changeRate: trendCurrent.overallChangePercent,
          severity: "LOW",
          priorityScore: 0,
          confidence: currentCount >= config.minComplaintsForSignal ? "MEDIUM" : "LOW",
          detectionSource: "QUANTITATIVE",
          explanation: `تحسن مستدام في ${label} بـ${facility}: من ${improvementStartValue} إلى ${currentCount} (${trendCurrent.durationLabel}).`,
          supportingMetrics: {
            startValue: improvementStartValue,
            currentValue: currentCount,
            pattern: trendCurrent.pattern,
            streakPeriods: trendCurrent.streakPeriods,
            periodCounts: JSON.stringify(counts),
          },
          evidenceComplaintIds,
          evidenceSpans: [],
          limitations: [],
          drilldownFilters,
          firstDetectedAt: detectedAt,
          lastDetectedAt: detectedAt,
          detectorVersion: DETECTOR_VERSION,
        })
      );
    }
  }

  const findings: AnalyticalFinding[] = [
    ...chronicFindings.sort((a, b) => b.priorityScore - a.priorityScore).slice(0, MAX_FINDINGS_PER_TYPE),
    ...trendFindings.sort((a, b) => b.priorityScore - a.priorityScore).slice(0, MAX_FINDINGS_PER_TYPE),
    ...improvementFindings.slice(0, MAX_FINDINGS_PER_TYPE),
  ];

  // ---- Wing concentration ----
  for (const work of cellWork) {
    if (!work.cell) continue;
    const wingResult = analyzeWingConcentration(
      {
        facility: work.facility,
        classificationLabel: work.label,
        wingCounts: [...work.cell.byWing.entries()].map(([wingCode, count]) => ({ wingCode, count })),
        totalWithWingData: work.cell.withWingData,
        totalComplaints: work.cell.total,
      },
      config
    );
    if (!wingResult?.isConcentrated) continue;
    findings.push(
      buildFinding({
        id: `wing_concentration:${work.facility}:${work.classKey}:${filters.from ?? ""}`,
        type: "WING_CONCENTRATION",
        entityType: "CLASSIFICATION",
        entityId: work.classKey === UNCLASSIFIED_KEY ? null : work.classKey,
        entityName: `${work.facility} — ${work.label}`,
        currentValue: work.cell.total,
        previousValue: null,
        difference: null,
        changeRate: null,
        severity: "MEDIUM",
        priorityScore: clampScore(wingResult.combinedSharePercent - 40),
        confidence: "MEDIUM",
        detectionSource: "QUANTITATIVE",
        explanation: `تتركز ${Math.round(wingResult.combinedSharePercent)}% من شكاوى ${work.label} في ${work.facility} داخل ${wingResult.topWings.length === 1 ? "جناح واحد" : "جناحين"} (${wingResult.topWings.map((w) => w.wingCode).join("، ")}).`,
        supportingMetrics: {
          combinedSharePercent: wingResult.combinedSharePercent,
          dataCompletenessRate: wingResult.dataCompletenessRate,
        },
        evidenceComplaintIds: work.cell.complaintIds,
        evidenceSpans: [],
        limitations: [],
        drilldownFilters: {
          facility: work.facility,
          ...(work.classKey !== UNCLASSIFIED_KEY ? { classificationId: work.classKey } : {}),
          ...filters,
        },
        firstDetectedAt: detectedAt,
        lastDetectedAt: detectedAt,
        detectorVersion: DETECTOR_VERSION,
      })
    );
  }

  // ---- Repeat complainant + mass complaint ----
  for (const summary of repeatSummaries.slice(0, MAX_FINDINGS_PER_TYPE)) {
    findings.push(
      buildFinding({
        id: `repeat_complainant:${summary.facility}:${filters.from ?? ""}`,
        type: "REPEAT_COMPLAINANT",
        entityType: "FACILITY",
        entityId: null,
        entityName: summary.facility,
        currentValue: summary.totalRepeatedComplaints,
        previousValue: null,
        difference: null,
        changeRate: null,
        severity: summary.repeatSharePercent >= 20 ? "HIGH" : "MEDIUM",
        priorityScore: clampScore(summary.repeatSharePercent * 2),
        confidence: summary.totalRepeatedComplaints >= config.minComplaintsForSignal ? "HIGH" : "MEDIUM",
        detectionSource: "QUANTITATIVE",
        explanation: `رُصد تكرار الشكوى لدى ${summary.repeatComplainantCount} من أصحاب الشكاوى في ${summary.facility}، بإجمالي ${summary.totalRepeatedComplaints} شكوى متكررة عبر حتى ${summary.maxPeriodsSpanned} فترات${summary.topTopics[0] ? `، أبرزها: ${summary.topTopics[0].label}` : ""}.`,
        supportingMetrics: {
          repeatComplainantCount: summary.repeatComplainantCount,
          totalRepeatedComplaints: summary.totalRepeatedComplaints,
          repeatSharePercent: summary.repeatSharePercent,
          maxComplaintsBySinglePerson: summary.maxComplaintsBySinglePerson,
          maxPeriodsSpanned: summary.maxPeriodsSpanned,
          // Anonymized — no raw complainant identifiers, per spec §1/§7's privacy rule.
          repeatEntries: JSON.stringify(
            summary.topEntries.map((e) => ({
              anonymizedComplainant: e.anonymizedComplainant,
              topicLabel: e.topicLabel,
              complaintCount: e.complaintCount,
              periodsSpanned: e.periodsSpanned,
            }))
          ),
        },
        evidenceComplaintIds: summary.topEntries.flatMap((e) => e.complaintIds).slice(0, MAX_EVIDENCE_IDS),
        evidenceSpans: [],
        limitations: ["الشكاوى المكررة تقنياً الناتجة عن الاستيراد مستبعدة من هذا التحليل."],
        drilldownFilters: { facility: summary.facility, ...filters },
        firstDetectedAt: detectedAt,
        lastDetectedAt: detectedAt,
        detectorVersion: DETECTOR_VERSION,
      })
    );
  }

  for (const mass of massComplaints) {
    if (mass.periodIndex !== currentIdx) continue;
    if (findings.filter((f) => f.type === "MASS_COMPLAINT").length >= MAX_FINDINGS_PER_TYPE) break;
    findings.push(
      buildFinding({
        id: `mass_complaint:${mass.facility}:${mass.topicLabel}:${filters.from ?? ""}`,
        type: "MASS_COMPLAINT",
        entityType: "FACILITY",
        entityId: null,
        entityName: `${mass.facility} — ${mass.topicLabel}`,
        currentValue: mass.totalComplaints,
        previousValue: mass.previousPeriodDistinctComplainants,
        difference: null,
        changeRate: null,
        severity: mass.distinctComplainants >= config.massComplaintMinDistinctComplainants * 2 ? "HIGH" : "MEDIUM",
        priorityScore: clampScore(mass.distinctComplainants * 5),
        confidence: "HIGH",
        detectionSource: "QUANTITATIVE",
        explanation: `تقدّم ${mass.distinctComplainants} من أصحاب الشكاوى المختلفين بشكوى حول "${mass.topicLabel}" في ${mass.facility} خلال الفترة الحالية (إجمالي ${mass.totalComplaints} شكوى).`,
        supportingMetrics: {
          distinctComplainants: mass.distinctComplainants,
          totalComplaints: mass.totalComplaints,
          previousPeriodDistinctComplainants: mass.previousPeriodDistinctComplainants,
        },
        evidenceComplaintIds: [],
        evidenceSpans: [],
        limitations: [],
        drilldownFilters: { facility: mass.facility, ...filters },
        firstDetectedAt: detectedAt,
        lastDetectedAt: detectedAt,
        detectorVersion: DETECTOR_VERSION,
      })
    );
  }

  // ---- Cross-facility spread ----
  for (const spread of crossFacilitySpread.slice(0, MAX_FINDINGS_PER_TYPE)) {
    findings.push(
      buildFinding({
        id: `cross_facility_spread:${spread.classificationLabel}:${filters.from ?? ""}`,
        type: "CROSS_FACILITY_SPREAD",
        entityType: "CLASSIFICATION",
        entityId: null,
        entityName: spread.classificationLabel,
        currentValue: spread.totalComplaints,
        previousValue: spread.totalComplaints - spread.changeFromPrevious,
        difference: spread.changeFromPrevious,
        changeRate: spread.changeRatePercent,
        severity: spread.affectedFacilityCount >= config.crossFacilityMinAffectedFacilities * 2 ? "HIGH" : "MEDIUM",
        priorityScore: clampScore(spread.affectedFacilityCount * 15),
        confidence: "HIGH",
        detectionSource: "QUANTITATIVE",
        explanation: `ارتفعت شكاوى "${spread.classificationLabel}" في ${spread.affectedFacilityCount} مواقع في آن واحد، بإجمالي ${spread.totalComplaints} شكوى؛ أبرز المواقع المساهمة: ${spread.topContributingFacilities.map((f) => f.facility).join("، ")}.`,
        supportingMetrics: {
          affectedFacilityCount: spread.affectedFacilityCount,
          totalComplaints: spread.totalComplaints,
          changeFromPrevious: spread.changeFromPrevious,
          topContributingFacilities: JSON.stringify(spread.topContributingFacilities.map((f) => f.facility)),
        },
        evidenceComplaintIds: [],
        evidenceSpans: [],
        limitations: [],
        drilldownFilters: { ...filters },
        firstDetectedAt: detectedAt,
        lastDetectedAt: detectedAt,
        detectorVersion: DETECTOR_VERSION,
      })
    );
  }

  // ---- Composition shift ----
  for (const shift of compositionShifts) {
    findings.push(
      buildFinding({
        id: `composition_shift:${shift.facility}:${filters.from ?? ""}`,
        type: "COMPOSITION_SHIFT",
        entityType: "FACILITY",
        entityId: null,
        entityName: shift.facility,
        currentValue: shift.risingChange,
        previousValue: null,
        difference: shift.risingChange,
        changeRate: null,
        severity: shift.becameTopClassification ? "HIGH" : "MEDIUM",
        priorityScore: clampScore(Math.abs(shift.risingChange) * 3),
        confidence: "MEDIUM",
        detectionSource: "QUANTITATIVE",
        explanation: `في ${shift.facility}، ارتفعت شكاوى "${shift.risingClassification}" بينما انخفضت شكاوى "${shift.fallingClassification}" رغم استقرار إجمالي الشكاوى${shift.becameTopClassification ? "، وأصبح التصنيف الأول في الموقع" : ""}.`,
        supportingMetrics: {
          risingClassification: shift.risingClassification,
          risingChange: shift.risingChange,
          fallingClassification: shift.fallingClassification,
          fallingChange: shift.fallingChange,
          becameTopClassification: shift.becameTopClassification,
        },
        evidenceComplaintIds: [],
        evidenceSpans: [],
        limitations: [],
        drilldownFilters: { facility: shift.facility, ...filters },
        firstDetectedAt: detectedAt,
        lastDetectedAt: detectedAt,
        detectorVersion: DETECTOR_VERSION,
      })
    );
  }

  // ---- Multi-issue facility ----
  for (const multi of multiIssueFacilities.slice(0, MAX_FINDINGS_PER_TYPE)) {
    findings.push(
      buildFinding({
        id: `multi_issue_facility:${multi.facility}:${filters.from ?? ""}`,
        type: "MULTI_ISSUE_FACILITY",
        entityType: "FACILITY",
        entityId: null,
        entityName: multi.facility,
        currentValue: multi.affectedClassificationCount,
        previousValue: null,
        difference: null,
        changeRate: null,
        severity: multi.affectedClassificationCount >= config.minAffectedClassificationsForMultiIssue * 2 ? "HIGH" : "MEDIUM",
        priorityScore: clampScore(multi.affectedClassificationCount * 20),
        confidence: "HIGH",
        detectionSource: "QUANTITATIVE",
        explanation: `يواجه ${multi.facility} ${multi.affectedClassificationCount} تصنيفات مرتفعة في آن واحد: ${multi.classifications.map((c) => c.label).join("، ")}.`,
        supportingMetrics: {
          affectedClassificationCount: multi.affectedClassificationCount,
          affectedClassifications: JSON.stringify(multi.classifications.map((c) => c.label)),
        },
        evidenceComplaintIds: [],
        evidenceSpans: [],
        limitations: [],
        drilldownFilters: { facility: multi.facility, ...filters },
        firstDetectedAt: detectedAt,
        lastDetectedAt: detectedAt,
        detectorVersion: DETECTOR_VERSION,
      })
    );
  }

  return findings.sort((a, b) => b.priorityScore - a.priorityScore);
}

/**
 * Per-facility total complaints in the CURRENT period, using the exact same
 * aggregation (`buildAggregation` + `facilityTotalsByPeriod`) that
 * `computePatternFindings` already runs internally to build every
 * facility-scoped and classification-scoped finding. Exposed as its own
 * entry point (spec §1) so report/UI consumers never fall back to a
 * separately-computed snapshot number that can legitimately disagree with
 * the scope that actually produced a finding (different facility-name
 * normalization, eligibility, or duplicate handling) — the exact
 * "شكاوى الفترة = 0 مع أولوية مرتفعة" contradiction the spec calls out.
 */
export function computeFacilityCurrentPeriodTotals(
  series: PatternSeries,
  config: PatternAnalysisConfig = PATTERN_ANALYSIS_CONFIG
): Record<string, number> {
  const totalPeriods = series.periods.length;
  if (totalPeriods < config.minPeriodsForContinuity + 1) return {};
  const byFacility = buildAggregation(series.records);
  const facilityTotals = facilityTotalsByPeriod(byFacility, totalPeriods);
  const currentIdx = totalPeriods - 1;
  const result: Record<string, number> = {};
  for (const [facility, totals] of facilityTotals) {
    result[facility] = totals[currentIdx] ?? 0;
  }
  return result;
}

/** "What changed since the previous period?" (spec §13). */
export function computePeriodChangeDigest(
  series: PatternSeries,
  config: PatternAnalysisConfig = PATTERN_ANALYSIS_CONFIG,
  periodUnit: PeriodUnit = "فترة"
): PeriodChangeDigest {
  const totalPeriods = series.periods.length;
  if (totalPeriods < config.minPeriodsForContinuity + 1) {
    return buildPeriodChangeDigest([], []);
  }
  const byFacility = buildAggregation(series.records);
  const current: PatternSnapshot[] = [];
  const previous: PatternSnapshot[] = [];

  for (const [facility, classMap] of byFacility) {
    for (const [classKey, agg] of classMap) {
      const counts = countsFor(agg, totalPeriods);
      const trendCurrent = classifyTrend(counts.slice(1), config, periodUnit);
      const trendPrevious = classifyTrend(counts.slice(0, -1), config, periodUnit);
      const key = cellKey(facility, classKey);
      current.push({
        key,
        facility,
        classificationLabel: agg.label,
        pattern: trendCurrent.pattern,
        priorityBand: isNegativeTrend(trendCurrent.pattern) ? "MEDIUM" : "LOW",
      });
      previous.push({
        key,
        facility,
        classificationLabel: agg.label,
        pattern: trendPrevious.pattern,
        priorityBand: isNegativeTrend(trendPrevious.pattern) ? "MEDIUM" : "LOW",
      });
    }
  }

  return buildPeriodChangeDigest(current, previous);
}
