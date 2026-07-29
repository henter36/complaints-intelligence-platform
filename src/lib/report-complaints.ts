const REPORT_PAGE_SIZE = 100;
const MAX_REPORT_PAGES = 10_000;

type ComplaintPageItem = { id: string };

type ComplaintsPagePayload<T extends ComplaintPageItem> = {
  data?: T[];
  total?: number;
  pageSize?: number;
  totalPages?: number;
};

export async function fetchAllComplaintsForReport<T extends ComplaintPageItem>(
  query: URLSearchParams,
  signal?: AbortSignal
): Promise<T[]> {
  const complaints: T[] = [];
  const seenIds = new Set<string>();
  let page = 1;
  let totalPages = 1;
  let total: number | null = null;

  do {
    if (page > MAX_REPORT_PAGES) {
      throw new Error("Report complaints pagination did not terminate");
    }
    if (signal?.aborted) {
      throw new DOMException("Report complaints request was aborted", "AbortError");
    }

    const pageQuery = new URLSearchParams(query);
    pageQuery.set("page", String(page));
    pageQuery.set("pageSize", String(REPORT_PAGE_SIZE));
    pageQuery.set("sortBy", "receivedDate");
    pageQuery.set("sortOrder", "desc");

    const response = await fetch(`/api/complaints?${pageQuery.toString()}`, { signal });
    if (!response.ok) {
      throw new Error("Failed to load report complaints");
    }

    const payload = await response.json() as ComplaintsPagePayload<T>;
    if (!Array.isArray(payload.data)) {
      throw new Error("Invalid report complaints response");
    }

    for (const complaint of payload.data) {
      if (!seenIds.has(complaint.id)) {
        seenIds.add(complaint.id);
        complaints.push(complaint);
      }
    }

    total = typeof payload.total === "number" ? payload.total : total;
    const effectivePageSize = typeof payload.pageSize === "number" && payload.pageSize > 0
      ? payload.pageSize
      : REPORT_PAGE_SIZE;
    totalPages = typeof payload.totalPages === "number"
      ? payload.totalPages
      : total === null ? page : Math.ceil(total / effectivePageSize);

    if (total !== null && complaints.length >= total) break;
    if (payload.data.length === 0) break;
    page += 1;
  } while (page <= totalPages);

  return complaints;
}
