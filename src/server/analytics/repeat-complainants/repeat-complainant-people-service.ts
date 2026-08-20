import { parseComplaintQuery } from "@/server/complaints/complaint-query-service";
import { buildRepeatComplainantDirectory, type RepeatPersonRow } from "@/lib/analytics/repeat-complainant-directory";
import {
  fetchOrgFacilityPresenceCounts,
  fetchScopedRecords,
  parseRepeatDirectoryOptions,
  toClientPersonRow,
  type RepeatPersonRowForClient,
} from "./repeat-complainant-analytics-service";
import { parsePositiveIntegerParam } from "./query-params";

export type RepeatComplainantPeoplePage = {
  people: RepeatPersonRowForClient[];
  total: number;
  page: number;
  pageSize: number;
};

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export type PeopleSortKey =
  | "totalComplaints"
  /** Alias of totalComplaints — repeatCount = totalComplaints - 1, a strictly
   * monotonic transform, so sorting by one always produces the same order
   * as sorting by the other. Kept as its own key purely so the UI's "عدد
   * التكرارات" sort option doesn't have to silently mean "عدد الشكاوى". */
  | "repeatCount"
  | "lastComplaintDate"
  | "distinctComplaintTypesCount"
  | "sameTypeRepeatCount"
  | "name";
export type PeopleSortOrder = "asc" | "desc";

/** Deterministic tie-break by the masked identifier (stable, always present) — never by the raw identifier. */
function compareByName(a: RepeatPersonRow, b: RepeatPersonRow): number {
  if (a.complainantName === null && b.complainantName === null) {
    return a.complainantIdentifierMasked.localeCompare(b.complainantIdentifierMasked);
  }
  if (a.complainantName === null) return 1; // people with no recorded name sort last
  if (b.complainantName === null) return -1;
  const cmp = a.complainantName.localeCompare(b.complainantName, "ar");
  return cmp !== 0 ? cmp : a.complainantIdentifierMasked.localeCompare(b.complainantIdentifierMasked);
}

/** Every comparator here is written ASCENDING; getRepeatComplainantPeoplePage negates it for "desc". */
const ASCENDING_COMPARATORS: Record<PeopleSortKey, (a: RepeatPersonRow, b: RepeatPersonRow) => number> = {
  totalComplaints: (a, b) => a.totalComplaints - b.totalComplaints,
  repeatCount: (a, b) => a.totalComplaints - b.totalComplaints,
  lastComplaintDate: (a, b) => a.lastComplaintDate.localeCompare(b.lastComplaintDate),
  distinctComplaintTypesCount: (a, b) => a.distinctComplaintTypesCount - b.distinctComplaintTypesCount,
  sameTypeRepeatCount: (a, b) => a.sameTypeRepeatCount - b.sameTypeRepeatCount,
  name: compareByName,
};

/** The direction a caller most likely means by "sort people" for each key, when they don't say otherwise — "most complaints first", but "A to Z" for name. */
const DEFAULT_SORT_ORDER: Record<PeopleSortKey, PeopleSortOrder> = {
  totalComplaints: "desc",
  repeatCount: "desc",
  lastComplaintDate: "desc",
  distinctComplaintTypesCount: "desc",
  sameTypeRepeatCount: "desc",
  name: "asc",
};

function resolveComparator(sortKey: PeopleSortKey, sortOrder: PeopleSortOrder | null): (a: RepeatPersonRow, b: RepeatPersonRow) => number {
  const ascending = ASCENDING_COMPARATORS[sortKey] ?? ASCENDING_COMPARATORS.totalComplaints;
  const order = sortOrder ?? DEFAULT_SORT_ORDER[sortKey] ?? "desc";
  return order === "asc" ? ascending : (a, b) => -ascending(a, b);
}

/**
 * Lazy, paginated person list, reusing the SAME `buildRepeatComplainantDirectory`
 * aggregation as every other repeat-complainant endpoint (spec: never a
 * second engine). Two modes, both org-wide-identity-correct (spec §7 — a
 * transferred person is still one person):
 *
 * - `params` carries a `facility` filter: the underlying complaint query
 *   itself is scoped to that ONE facility (spec: "حسب السجن" view), so every
 *   number on each returned row (totalComplaints, distinctComplaintTypesCount,
 *   topComplaintTypes, sameTypeRepeatCount, ...) is ALREADY facility-scoped —
 *   there is no other facility's data mixed into this call's `records` to
 *   begin with. `orgFacilitiesCount` is additionally attached (one extra,
 *   bounded batch query — never N+1) so the UI can show "ظهر في N سجون"
 *   without pulling in the person's other facilities' full detail.
 * - `params` carries no `facility`: org-wide "قائمة موحدة" view — every
 *   number is already the person's true org-wide total, and
 *   `facilitiesCount`/`facilities` (always present on the row) already say
 *   how many facilities they appear at, so no extra lookup is needed.
 */
export async function getRepeatComplainantPeoplePage(
  params: URLSearchParams,
  now: Date = new Date()
): Promise<RepeatComplainantPeoplePage> {
  const query = parseComplaintQuery(params);
  const options = parseRepeatDirectoryOptions(params);
  const { records, totalComplaintsInScope } = await fetchScopedRecords(query, now);
  const directory = buildRepeatComplainantDirectory(records, totalComplaintsInScope, undefined, options);

  // Dedicated param names — see repeat-complainant-analytics-service.ts's
  // parseRepeatDirectoryOptions for why (collision with parseComplaintQuery's
  // own reserved page/pageSize/sortBy vocabulary).
  const sortKey = (params.get("peopleSortBy") as PeopleSortKey | null) ?? "totalComplaints";
  const sortOrderParam = params.get("peopleSortOrder");
  const sortOrder: PeopleSortOrder | null = sortOrderParam === "asc" || sortOrderParam === "desc" ? sortOrderParam : null;
  const comparator = resolveComparator(sortKey, sortOrder);
  const sorted = [...directory.people].sort(comparator);

  const page = parsePositiveIntegerParam(params.get("peoplePage"), { min: 1, max: 1_000_000, fallback: 1 })!;
  const pageSize = parsePositiveIntegerParam(params.get("peoplePageSize"), { min: 1, max: MAX_PAGE_SIZE, fallback: DEFAULT_PAGE_SIZE })!;
  const start = (page - 1) * pageSize;
  const pageRows = sorted.slice(start, start + pageSize);

  const isFacilityScoped = Boolean(query.facility ?? query.facilityId);
  const orgFacilityCounts = isFacilityScoped
    ? await fetchOrgFacilityPresenceCounts(pageRows.map((p) => p.complainantIdentifierRaw), query, now)
    : null;

  const people = pageRows.map((p) => {
    const clientRow = toClientPersonRow(p);
    return orgFacilityCounts ? { ...clientRow, orgFacilitiesCount: orgFacilityCounts.get(p.complainantIdentifierRaw) ?? 1 } : clientRow;
  });

  return { people, total: sorted.length, page, pageSize };
}
