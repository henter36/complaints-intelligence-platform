import { parseComplaintQuery } from "@/server/complaints/complaint-query-service";
import { buildRepeatComplainantDirectory, type RepeatComplainantDirectoryOptions, type RepeatPersonRow } from "@/lib/analytics/repeat-complainant-directory";
import { fetchScopedRecords, toClientPersonRow, type RepeatPersonRowForClient } from "./repeat-complainant-analytics-service";

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

function parseDirectoryOptions(params: URLSearchParams): RepeatComplainantDirectoryOptions {
  const minComplaints = params.get("minComplaints");
  const minDistinctTypes = params.get("minDistinctTypes");
  return {
    minComplaintsPerPerson: minComplaints ? Number(minComplaints) : undefined,
    sameTypeOnly: params.get("sameTypeOnly") === "true",
    minDistinctTypes: minDistinctTypes ? Number(minDistinctTypes) : undefined,
  };
}

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
  const options = parseDirectoryOptions(params);
  const { records, totalComplaintsInScope } = await fetchScopedRecords(query, now);
  const directory = buildRepeatComplainantDirectory(records, totalComplaintsInScope, undefined, options);

  // A dedicated param name — `sortBy` itself is already reserved by
  // `parseComplaintQuery`'s own complaint-sort vocabulary (receivedDate,
  // status, ...) and would otherwise throw a validation error here.
  const sortKey = (params.get("peopleSortBy") as PeopleSortKey | null) ?? "totalComplaints";
  const comparator = SORT_COMPARATORS[sortKey] ?? SORT_COMPARATORS.totalComplaints;
  const sorted = [...directory.people].sort(comparator);

  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(params.get("pageSize") ?? String(DEFAULT_PAGE_SIZE)) || DEFAULT_PAGE_SIZE));
  const start = (page - 1) * pageSize;
  const people = sorted.slice(start, start + pageSize).map(toClientPersonRow);

  return { people, total: sorted.length, page, pageSize };
}
