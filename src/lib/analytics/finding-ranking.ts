import type { AnalyticalFinding } from "./analytical-finding";

/**
 * Executive-brief ordering (spec §14): priorityScore is always the primary
 * key so a low-value finding can never displace an important one; the
 * category order below is only a tiebreak within equal-ish scores, matching
 * "١. أولوية المتابعة، ٢. المزمنة، ٣. التصاعد، ٤. الانتكاس، ٥. التكرار/الانتشار،
 * ٦. التحسن".
 */
const SPREAD_OR_REPEAT_TYPES = new Set(["REPEAT_COMPLAINANT", "MASS_COMPLAINT", "CROSS_FACILITY_SPREAD"]);

function categoryRank(finding: AnalyticalFinding): number {
  if (finding.type === "CHRONIC_ISSUE") return 0;
  if (finding.type === "SUSTAINED_IMPROVEMENT") return 5;
  if (finding.type === "TREND_PATTERN") {
    const pattern = finding.supportingMetrics.pattern;
    if (pattern === "RELAPSE_AFTER_IMPROVEMENT") return 3;
    return 1; // escalation-family: CONTINUED_RISE / ESCALATING / EMERGING / VOLATILE / NO_MEANINGFUL_IMPROVEMENT
  }
  if (SPREAD_OR_REPEAT_TYPES.has(finding.type)) return 4;
  return 2; // concentration, composition shift, multi-issue, data quality, ...
}

export function rankFindingsForExecutiveBrief(findings: readonly AnalyticalFinding[]): AnalyticalFinding[] {
  return [...findings].sort((a, b) => {
    const scoreDiff = b.priorityScore - a.priorityScore;
    if (scoreDiff !== 0) return scoreDiff;
    return categoryRank(a) - categoryRank(b);
  });
}
