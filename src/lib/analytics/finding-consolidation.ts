import type { AnalyticalFinding } from "./analytical-finding";
import { findingTypeLabel } from "./finding-labels";

/**
 * Presentation-only grouping for the executive brief (spec §15): several
 * findings about the same facility×classification (chronic + wing
 * concentration + repeat, for example) become ONE card instead of three,
 * while every original finding stays reachable via `mergedFindings`. This
 * never recomputes anything — it only re-groups the engine's own output.
 */
export type ConsolidatedFindingCard = {
  primary: AnalyticalFinding;
  mergedFindings: AnalyticalFinding[];
  /** Arabic labels of the OTHER finding types folded into this card (primary excluded). */
  additionalSignalLabels: string[];
};

const GROUPABLE_TYPES = new Set(["CHRONIC_ISSUE", "TREND_PATTERN", "SUSTAINED_IMPROVEMENT", "WING_CONCENTRATION", "CONCENTRATION"]);

function stringField(finding: AnalyticalFinding, key: string): string | null {
  const value = finding.drilldownFilters[key];
  return typeof value === "string" ? value : null;
}

function classificationLabelOf(finding: AnalyticalFinding): string {
  const parts = finding.entityName.split(" — ");
  return parts.length > 1 ? parts[1] : finding.entityName;
}

/** A REPEAT_COMPLAINANT finding is facility-level; folded in only when its top topic matches the group's classification label. */
function repeatMatchesClassification(repeatFinding: AnalyticalFinding, classificationLabel: string): boolean {
  const raw = repeatFinding.supportingMetrics.repeatEntries;
  if (typeof raw !== "string") return false;
  try {
    const entries = JSON.parse(raw) as { topicLabel?: string }[];
    return entries.some((entry) => entry.topicLabel === classificationLabel);
  } catch {
    return false;
  }
}

export function consolidateFindingsForBrief(findings: readonly AnalyticalFinding[]): ConsolidatedFindingCard[] {
  const groups = new Map<string, AnalyticalFinding[]>();
  const ungrouped: AnalyticalFinding[] = [];

  for (const finding of findings) {
    if (!GROUPABLE_TYPES.has(finding.type)) {
      ungrouped.push(finding);
      continue;
    }
    const facility = stringField(finding, "facility");
    const classificationId = stringField(finding, "classificationId");
    if (!facility || !classificationId) {
      ungrouped.push(finding);
      continue;
    }
    const key = `${facility} ${classificationId}`;
    const list = groups.get(key) ?? [];
    list.push(finding);
    groups.set(key, list);
  }

  const cards: ConsolidatedFindingCard[] = [];
  const consumedIds = new Set<string>();

  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => b.priorityScore - a.priorityScore);
    const primary = sorted[0];
    const facility = stringField(primary, "facility");
    const classificationLabel = classificationLabelOf(primary);

    const matchingRepeat = facility
      ? findings.find(
          (f) => f.type === "REPEAT_COMPLAINANT" && f.entityName === facility && repeatMatchesClassification(f, classificationLabel)
        )
      : undefined;

    const mergedFindings = matchingRepeat ? [...sorted, matchingRepeat] : sorted;
    for (const f of mergedFindings) consumedIds.add(f.id);

    const additionalSignalLabels = mergedFindings
      .slice(1)
      .map((f) => findingTypeLabel(f.type))
      .filter((label, index, all) => all.indexOf(label) === index);

    cards.push({ primary, mergedFindings, additionalSignalLabels });
  }

  for (const finding of ungrouped) {
    if (consumedIds.has(finding.id)) continue;
    cards.push({ primary: finding, mergedFindings: [finding], additionalSignalLabels: [] });
  }

  return cards.sort((a, b) => b.primary.priorityScore - a.primary.priorityScore);
}
