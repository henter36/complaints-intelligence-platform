import type { AnalyticalFinding } from "./analytical-finding";
import { evaluateComparison } from "./comparison-evaluation";
import { findingTypeLabel } from "./finding-labels";

/**
 * Flattens an AnalyticalFinding into the tabular row shape shared by the
 * full-report PDF table and the XLSX "الملاحظات التحليلية" sheet (spec §9) —
 * written once so both consumers stay identical instead of building their
 * own column mapping.
 */
export type FindingTableRow = {
  findingId: string;
  facility: string;
  classification: string;
  findingType: string;
  priorityScore: number;
  currentValue: number;
  previousValue: number | null;
  periodsObserved: number | null;
  repeatRate: number | null;
  concentrationRate: number | null;
  affectedComplainants: number | null;
  direction: string;
  reasons: string;
  summary: string;
};

function splitEntityName(finding: AnalyticalFinding): { facility: string; classification: string } {
  if (finding.entityType === "FACILITY") return { facility: finding.entityName, classification: "" };
  const separatorIndex = finding.entityName.indexOf(" — ");
  if (separatorIndex === -1) return { facility: finding.entityName, classification: "" };
  return {
    facility: finding.entityName.slice(0, separatorIndex),
    classification: finding.entityName.slice(separatorIndex + 3),
  };
}

function numberMetric(finding: AnalyticalFinding, key: string): number | null {
  const value = finding.supportingMetrics[key];
  return typeof value === "number" ? value : null;
}

function reasonsOf(finding: AnalyticalFinding): string {
  const raw = finding.supportingMetrics.priorityReasons ?? finding.supportingMetrics.chronicReasons;
  if (typeof raw !== "string") return "";
  try {
    const reasons = JSON.parse(raw);
    if (Array.isArray(reasons)) return reasons.filter((r) => typeof r === "string").join("؛ ");
  } catch {
    // fall through
  }
  return "";
}

function directionOf(finding: AnalyticalFinding): string {
  if (finding.previousValue === null) return "غير متاح";
  return evaluateComparison(finding.currentValue, finding.previousValue, true).label;
}

export function toFindingTableRow(finding: AnalyticalFinding): FindingTableRow {
  const { facility, classification } = splitEntityName(finding);
  return {
    findingId: finding.id,
    facility,
    classification,
    findingType: findingTypeLabel(finding.type),
    priorityScore: finding.priorityScore,
    currentValue: finding.currentValue,
    previousValue: finding.previousValue,
    periodsObserved: numberMetric(finding, "streakPeriods"),
    repeatRate: numberMetric(finding, "repeatRatePercent"),
    concentrationRate: numberMetric(finding, "facilitySharePercent"),
    affectedComplainants: numberMetric(finding, "distinctComplainants"),
    direction: directionOf(finding),
    reasons: reasonsOf(finding),
    summary: finding.explanation,
  };
}

export function toFindingTableRows(findings: readonly AnalyticalFinding[]): FindingTableRow[] {
  return findings.map(toFindingTableRow);
}
