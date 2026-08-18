import { parseComplaintQuery } from "@/server/complaints/complaint-query-service";
import { buildRepeatComplainantDirectory, type RepeatPersonRow } from "@/lib/analytics/repeat-complainant-directory";
import { fetchScopedRecords, parseRepeatDirectoryOptions, toClientPersonRow, type RepeatPersonRowForClient } from "./repeat-complainant-analytics-service";
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
  | "lastComplaintDate"
  | "distinctComplaintTypesCount"
  | "sameTypeRepeatCount";

const SORT_COMPARATORS: Record<PeopleSortKey, (a: RepeatPersonRow, b: RepeatPersonRow) => number> = {
  totalComplaints: (a, b) => b.totalComplaints - a.totalComplaints,
  lastComplaintDate: (a, b) => b.lastComplaintDate.localeCompare(a.lastComplaintDate),
  distinctComplaintTypesCount: (a, b) => b.distinctComplaintTypesCount - a.distinctComplaintTypesCount,
  sameTypeRepeatCount: (a, b) => b.sameTypeRepeatCount - a.sameTypeRepeatCount,
};

/**
 * Lazy, paginated per-facility person list (spec: don't preload every
 * person up front — fetch on expansion/drillthrough only). `params` MUST
 * already carry a `facility` filter from the caller (the client only calls
 * this after expanding one specific facility node in the tree); this
 * function does not widen or narrow that scope itself.
 */
export async function getRepeatComplainantPeoplePage(
  params: URLSearchParams,
  now: Date = new Date()
): Promise<RepeatComplainantPeoplePage> {
  const query = parseComplaintQuery(params);
  const options = parseRepeatDirectoryOptions(params);
  const { records, totalComplaintsInScope } = await fetchScopedRecords(query, now);
  const directory = buildRepeatComplainantDirectory(records, totalComplaintsInScope, undefined, options);

  // Dedicated param names — `sortBy`/`page`/`pageSize` are already reserved
  // by `parseComplaintQuery`'s own complaint-listing vocabulary (and, for
  // page/pageSize, its own STRICT zod validation that throws a 400 on
  // anything malformed — before this function would ever get a chance to
  // apply its own lenient fallback-to-default parsing below). This
  // feature's pagination is over the in-memory aggregated person list, a
  // completely different concept from complaint-row pagination, so it gets
  // its own param names rather than colliding with (and inheriting the
  // strictness of) the shared complaint query schema.
  const sortKey = (params.get("peopleSortBy") as PeopleSortKey | null) ?? "totalComplaints";
  const comparator = SORT_COMPARATORS[sortKey] ?? SORT_COMPARATORS.totalComplaints;
  const sorted = [...directory.people].sort(comparator);

  const page = parsePositiveIntegerParam(params.get("peoplePage"), { min: 1, max: 1_000_000, fallback: 1 })!;
  const pageSize = parsePositiveIntegerParam(params.get("peoplePageSize"), { min: 1, max: MAX_PAGE_SIZE, fallback: DEFAULT_PAGE_SIZE })!;
  const start = (page - 1) * pageSize;
  const people = sorted.slice(start, start + pageSize).map(toClientPersonRow);

  return { people, total: sorted.length, page, pageSize };
}
