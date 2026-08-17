import type { AnalyticalFinding } from "./analytical-finding";

/**
 * Converts a finding's `drilldownFilters` into plain URL query params for
 * the complaints explorer (spec §6). The explorer's FilterState already
 * uses the same key names (`facility`, `classificationId`, `from`, `to`, ...)
 * as the engine's drilldownFilters, so this is just type coercion — no
 * remapping table needed.
 */
export function buildExplorerDrilldownQuery(finding: Pick<AnalyticalFinding, "drilldownFilters">): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(finding.drilldownFilters)) {
    if (value === null) continue;
    query[key] = String(value);
  }
  return query;
}
