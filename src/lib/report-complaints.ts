const REPORT_PAGE_SIZE = 100;
const MAX_REPORT_PAGES = 10_000;

type ComplaintPageItem = { id: string };

type ComplaintsPagePayload<T extends ComplaintPageItem> = {
  data?: T[];
  total?: number;
  pageSize?: number;
  totalPages?: number;
};

type PaginationState = {
  total: number | null;
  totalPages: number;
};

export function assertReportPaginationWithinLimit(page: number): void {
  if (page > MAX_REPORT_PAGES) {
    throw new RangeError("Report complaints pagination did not terminate");
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Report complaints request was aborted", "AbortError");
  }
}

function buildReportPageQuery(query: URLSearchParams, page: number): URLSearchParams {
  const pageQuery = new URLSearchParams(query);

  pageQuery.set("page", String(page));
  pageQuery.set("pageSize", String(REPORT_PAGE_SIZE));
  pageQuery.set("sortBy", "receivedDate");
  pageQuery.set("sortOrder", "desc");

  return pageQuery;
}

async function fetchComplaintsPage<T extends ComplaintPageItem>(
  query: URLSearchParams,
  signal?: AbortSignal
): Promise<ComplaintsPagePayload<T>> {
  const response = await fetch(`/api/complaints?${query.toString()}`, { signal });

  if (!response.ok) {
    throw new Error("Failed to load report complaints");
  }

  const payload: unknown = await response.json();

  if (
    typeof payload !== "object"
    || payload === null
    || !Array.isArray((payload as ComplaintsPagePayload<T>).data)
  ) {
    throw new TypeError("Invalid report complaints response");
  }

  return payload as ComplaintsPagePayload<T>;
}

function appendUniqueComplaints<T extends ComplaintPageItem>(
  target: T[],
  seenIds: Set<string>,
  pageItems: T[]
): void {
  for (const complaint of pageItems) {
    if (seenIds.has(complaint.id)) {
      continue;
    }

    seenIds.add(complaint.id);
    target.push(complaint);
  }
}

function resolveEffectivePageSize<T extends ComplaintPageItem>(
  payload: ComplaintsPagePayload<T>
): number {
  if (typeof payload.pageSize === "number" && payload.pageSize > 0) {
    return payload.pageSize;
  }

  return REPORT_PAGE_SIZE;
}

function resolveTotal<T extends ComplaintPageItem>(
  payload: ComplaintsPagePayload<T>,
  previousTotal: number | null
): number | null {
  if (typeof payload.total === "number") {
    return payload.total;
  }

  return previousTotal;
}

function calculateTotalPages<T extends ComplaintPageItem>(
  payload: ComplaintsPagePayload<T>,
  total: number | null,
  page: number
): number {
  if (
    typeof payload.totalPages === "number"
    && Number.isFinite(payload.totalPages)
    && payload.totalPages >= 0
  ) {
    return payload.totalPages;
  }

  if (total === null) {
    return page + 1;
  }

  return Math.ceil(total / resolveEffectivePageSize(payload));
}

function resolvePaginationState<T extends ComplaintPageItem>(
  payload: ComplaintsPagePayload<T>,
  previousTotal: number | null,
  page: number
): PaginationState {
  const total = resolveTotal(payload, previousTotal);

  return {
    total,
    totalPages: calculateTotalPages(payload, total, page),
  };
}

function isPaginationComplete(
  payloadItemCount: number,
  collectedCount: number,
  total: number | null,
  page: number,
  totalPages: number
): boolean {
  if (payloadItemCount === 0) {
    return true;
  }

  if (total !== null && collectedCount >= total) {
    return true;
  }

  return page >= totalPages;
}

export async function fetchAllComplaintsForReport<T extends ComplaintPageItem>(
  query: URLSearchParams,
  signal?: AbortSignal
): Promise<T[]> {
  const complaints: T[] = [];
  const seenIds = new Set<string>();
  let page = 1;
  let totalPages = 1;
  let total: number | null = null;

  while (true) {
    assertReportPaginationWithinLimit(page);
    throwIfAborted(signal);

    const pageQuery = buildReportPageQuery(query, page);
    const payload = await fetchComplaintsPage<T>(pageQuery, signal);
    const pageItems = payload.data ?? [];

    appendUniqueComplaints(complaints, seenIds, pageItems);

    const pagination: PaginationState = resolvePaginationState(payload, total, page);
    total = pagination.total;
    totalPages = pagination.totalPages;

    if (isPaginationComplete(pageItems.length, complaints.length, total, page, totalPages)) {
      break;
    }

    page += 1;
  }

  return complaints;
}
