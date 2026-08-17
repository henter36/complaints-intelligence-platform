import type { AnalyticalFinding } from "@/lib/analytics/analytical-finding";
import type { PeriodChangeDigest } from "@/lib/analytics/period-change-digest";
import { PATTERN_ANALYSIS_CONFIG, type PatternAnalysisConfig } from "@/lib/analytics/pattern-analysis-config";
import {
  filterFindingsByScope,
  filterPeriodChangeDigestByScope,
  isEmptyScope,
  type PatternAnalysisScope,
} from "@/lib/analytics/finding-scope-filter";
import { loadFacilityOperationalRegistry } from "@/server/facilities/facility-operational-scope-service";
import { loadPatternSeries } from "./pattern-period-series-service";
import {
  computeFacilityCurrentPeriodTotals,
  computePatternFindings,
  computePeriodChangeDigest,
  describePatternSeriesPeriods,
} from "./pattern-findings-service";

export type { PatternAnalysisScope } from "@/lib/analytics/finding-scope-filter";

export type PatternAnalysisReportData = {
  findings: AnalyticalFinding[];
  periodChangeDigest: PeriodChangeDigest;
  periods: { from: string; to: string }[];
  /** Per-facility current-period total, same aggregation that produced `findings` (spec §1). */
  facilityCurrentPeriodTotals: Record<string, number>;
};

async function buildFacilityRegionLookup(): Promise<Map<string, string>> {
  const registry = await loadFacilityOperationalRegistry();
  const lookup = new Map<string, string>();
  for (const facility of registry.facilities) {
    if (facility.region) lookup.set(facility.name, facility.region);
  }
  return lookup;
}

/**
 * THE single entry point for the multi-period pattern-analysis engine used
 * by every consumer — the Analytics API, the brief/full report PDFs, and the
 * XLSX export (spec §11: one source of truth per period+filters). The
 * underlying computation always runs at full organization scope (§12's
 * "comparison baseline" — concentration and cross-facility spread need the
 * whole org to mean anything); `scope` only controls which of the resulting
 * findings are worth showing for this particular page/report.
 */
export async function loadPatternAnalysisForFilters(
  currentFrom: Date,
  currentToExclusive: Date,
  scope: PatternAnalysisScope = {},
  config: PatternAnalysisConfig = PATTERN_ANALYSIS_CONFIG
): Promise<PatternAnalysisReportData> {
  const series = await loadPatternSeries(currentFrom, currentToExclusive, config.analysisWindowPeriods + 1);
  const allFindings = computePatternFindings(series, config);
  const digest = computePeriodChangeDigest(series, config);
  const periods = describePatternSeriesPeriods(series);
  const facilityCurrentPeriodTotals = computeFacilityCurrentPeriodTotals(series, config);

  if (isEmptyScope(scope)) {
    return { findings: allFindings, periodChangeDigest: digest, periods, facilityCurrentPeriodTotals };
  }

  const facilityRegionLookup = scope.region ? await buildFacilityRegionLookup() : new Map<string, string>();
  return {
    findings: filterFindingsByScope(allFindings, scope, facilityRegionLookup),
    periodChangeDigest: filterPeriodChangeDigestByScope(digest, scope, facilityRegionLookup),
    periods,
    facilityCurrentPeriodTotals,
  };
}
