import type { AnalyticalFinding, AnalyticalFindingType } from "./analytical-finding";

/**
 * Groups the engine's own findings into the ten categories the full report
 * must present separately (spec §3). Purely a re-grouping of existing
 * output — no detection or scoring happens here.
 */
export type FindingCategoryGroup = {
  id: string;
  label: string;
  findings: AnalyticalFinding[];
};

type CategoryDefinition = {
  id: string;
  label: string;
  matches: (finding: AnalyticalFinding) => boolean;
};

function hasType(types: readonly AnalyticalFindingType[]) {
  return (finding: AnalyticalFinding) => (types as readonly string[]).includes(finding.type);
}

function isTrendPattern(relapseOnly: boolean) {
  return (finding: AnalyticalFinding) => {
    if (finding.type !== "TREND_PATTERN") return false;
    const isRelapse = finding.supportingMetrics.pattern === "RELAPSE_AFTER_IMPROVEMENT";
    return relapseOnly ? isRelapse : !isRelapse;
  };
}

const CATEGORY_DEFINITIONS: CategoryDefinition[] = [
  { id: "chronic", label: "مشكلات مزمنة", matches: hasType(["CHRONIC_ISSUE"]) },
  { id: "escalation", label: "استمرار أو تصاعد", matches: isTrendPattern(false) },
  { id: "repeat_complainant", label: "تكرار من نفس صاحب الشكوى", matches: hasType(["REPEAT_COMPLAINANT"]) },
  { id: "mass_complaint", label: "انتشار جماعي", matches: hasType(["MASS_COMPLAINT"]) },
  { id: "concentration", label: "تركّز داخل موقع", matches: hasType(["CONCENTRATION", "WING_CONCENTRATION"]) },
  { id: "cross_facility_spread", label: "انتشار عبر عدة مواقع", matches: hasType(["CROSS_FACILITY_SPREAD"]) },
  { id: "composition_shift", label: "تغير تركيب الشكاوى", matches: hasType(["COMPOSITION_SHIFT"]) },
  { id: "multi_issue_facility", label: "مواقع متعددة المشكلات", matches: hasType(["MULTI_ISSUE_FACILITY"]) },
  { id: "sustained_improvement", label: "تحسن مستدام", matches: hasType(["SUSTAINED_IMPROVEMENT"]) },
  { id: "relapse", label: "عودة المشكلة بعد تحسن", matches: isTrendPattern(true) },
];

export function groupFindingsByCategory(findings: readonly AnalyticalFinding[]): FindingCategoryGroup[] {
  return CATEGORY_DEFINITIONS.map((def) => ({
    id: def.id,
    label: def.label,
    findings: findings.filter(def.matches),
  })).filter((group) => group.findings.length > 0);
}
