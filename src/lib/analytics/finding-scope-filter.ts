import type { AnalyticalFinding } from "./analytical-finding";
import type { PatternSnapshot, PeriodChangeDigest } from "./period-change-digest";

/**
 * Report/page-level scope for the pattern-analysis engine's OUTPUT — never
 * the computation itself. Concentration and cross-facility spread need the
 * full organization as their comparison baseline even when a report is
 * scoped to one facility (spec §12: "analysis scope" vs "comparison
 * baseline" must never be conflated). Scoping here only decides which
 * already-computed findings are worth showing for this report/page.
 */
export type PatternAnalysisScope = {
  facility?: string | null;
  region?: string | null;
  classificationId?: string | null;
};

export function isEmptyScope(scope: PatternAnalysisScope): boolean {
  return !scope.facility && !scope.region && !scope.classificationId;
}

function stringField(record: Record<string, string | number | boolean | null>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function facilityMatchesScope(
  facility: string | null,
  scope: PatternAnalysisScope,
  facilityRegionLookup: ReadonlyMap<string, string>
): boolean {
  if (scope.facility) {
    return facility === scope.facility;
  }
  if (scope.region) {
    if (!facility) return false;
    return facilityRegionLookup.get(facility) === scope.region;
  }
  return true;
}

/**
 * A CROSS_FACILITY_SPREAD finding has no single `facility` in its
 * drilldownFilters by design (it spans several) — it carries a
 * `topContributingFacilities` list (JSON-encoded) in supportingMetrics
 * instead. It matches a facility/region scope when that facility is among
 * the ones actually listed.
 */
function crossFacilitySpreadMatchesScope(
  finding: AnalyticalFinding,
  scope: PatternAnalysisScope,
  facilityRegionLookup: ReadonlyMap<string, string>
): boolean {
  if (!scope.facility && !scope.region) return true;
  const raw = finding.supportingMetrics.topContributingFacilities;
  if (typeof raw !== "string") return true; // can't verify — don't hide a real org-wide signal
  let facilities: string[];
  try {
    facilities = JSON.parse(raw);
  } catch {
    return true;
  }
  if (!Array.isArray(facilities)) return true;
  return facilities.some((facility) => facilityMatchesScope(facility, scope, facilityRegionLookup));
}

export function filterFindingsByScope(
  findings: readonly AnalyticalFinding[],
  scope: PatternAnalysisScope,
  facilityRegionLookup: ReadonlyMap<string, string> = new Map()
): AnalyticalFinding[] {
  if (isEmptyScope(scope)) return [...findings];

  return findings.filter((finding) => {
    if (scope.classificationId) {
      const classificationId = stringField(finding.drilldownFilters, "classificationId");
      // Findings with no classification dimension at all (e.g. REPEAT_COMPLAINANT
      // rolls up a whole facility) are excluded once a classification scope is set —
      // they can't be verified against it.
      if (classificationId !== scope.classificationId) return false;
    }

    if (finding.type === "CROSS_FACILITY_SPREAD") {
      return crossFacilitySpreadMatchesScope(finding, scope, facilityRegionLookup);
    }

    const facility = stringField(finding.drilldownFilters, "facility");
    return facilityMatchesScope(facility, scope, facilityRegionLookup);
  });
}

/**
 * Same scoping applied to the period-change digest's snapshots. Classification
 * scoping is not applied here — PatternSnapshot only carries a display label,
 * not a classificationId, so a classification-scoped report keeps the full
 * digest rather than risk a wrong label match.
 */
/** Generic facility/region scoping for any digest row shaped `{ facility: string }` (e.g. WorsenedProblem). */
export function filterByFacilityField<T extends { facility: string }>(
  items: readonly T[],
  scope: PatternAnalysisScope,
  facilityRegionLookup: ReadonlyMap<string, string> = new Map()
): T[] {
  if (!scope.facility && !scope.region) return [...items];
  return items.filter((item) => facilityMatchesScope(item.facility, scope, facilityRegionLookup));
}

export function filterDigestSnapshotsByScope(
  snapshots: readonly PatternSnapshot[],
  scope: PatternAnalysisScope,
  facilityRegionLookup: ReadonlyMap<string, string> = new Map()
): PatternSnapshot[] {
  if (!scope.facility && !scope.region) return [...snapshots];
  return snapshots.filter((snapshot) => facilityMatchesScope(snapshot.facility, scope, facilityRegionLookup));
}

/**
 * Scopes every list in the digest by facility/region. `newlySpreadingClassifications`
 * is left untouched — spread is inherently an org-wide fact (spec §12's
 * "comparison baseline"), so a single-facility report still surfaces it as context.
 */
export function filterPeriodChangeDigestByScope(
  digest: PeriodChangeDigest,
  scope: PatternAnalysisScope,
  facilityRegionLookup: ReadonlyMap<string, string> = new Map()
): PeriodChangeDigest {
  if (isEmptyScope(scope)) return digest;
  return {
    newProblems: filterDigestSnapshotsByScope(digest.newProblems, scope, facilityRegionLookup),
    continuingProblems: filterDigestSnapshotsByScope(digest.continuingProblems, scope, facilityRegionLookup),
    worsenedProblems: filterByFacilityField(digest.worsenedProblems, scope, facilityRegionLookup),
    relapsedProblems: filterDigestSnapshotsByScope(digest.relapsedProblems, scope, facilityRegionLookup),
    improvedFacilities: filterDigestSnapshotsByScope(digest.improvedFacilities, scope, facilityRegionLookup),
    exitedPriorityList: filterDigestSnapshotsByScope(digest.exitedPriorityList, scope, facilityRegionLookup),
    newlySpreadingClassifications: digest.newlySpreadingClassifications,
  };
}
