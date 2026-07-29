import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAllComplaintsForReport } from "@/lib/report-complaints";

function complaint(id: string) {
  return {
    id,
    complaintNumber: id,
    receivedDate: "2026-07-01T00:00:00.000Z",
    channel: "الهاتف",
    regionId: null,
    locationId: null,
    departmentId: null,
    classificationId: null,
    subject: `شكوى ${id}`,
    description: "",
    status: "open",
    priority: "medium",
    severity: "medium",
    referralDate: null,
    firstActionDate: null,
    closureDate: null,
    dueDate: null,
    resolution: null,
    delayReason: null,
    isRepeated: false,
    isValidated: false,
    beneficiarySatisfaction: null,
    isPotentialDuplicate: false,
  };
}

function mockPagedComplaints(total: number) {
  const records = Array.from({ length: total }, (_, index) => complaint(`cmp-${index + 1}`));
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const page = Number(url.searchParams.get("page"));
    const pageSize = Number(url.searchParams.get("pageSize"));
    const start = (page - 1) * pageSize;
    const data = records.slice(start, start + pageSize);

    return Response.json({
      data,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAllComplaintsForReport", () => {
  it.each([
    [50, 1],
    [100, 1],
    [101, 2],
    [250, 3],
  ])("loads %i report complaints using paged requests", async (total, expectedRequests) => {
    const fetchMock = mockPagedComplaints(total);
    const query = new URLSearchParams("regionId=riyadh&departmentId=er");

    const result = await fetchAllComplaintsForReport(query);

    expect(result).toHaveLength(total);
    expect(fetchMock).toHaveBeenCalledTimes(expectedRequests);
    for (const [input] of fetchMock.mock.calls) {
      const url = new URL(String(input), "http://localhost");
      expect(url.searchParams.get("pageSize")).toBe("100");
      expect(url.searchParams.get("regionId")).toBe("riyadh");
      expect(url.searchParams.get("departmentId")).toBe("er");
      expect(url.searchParams.get("sortBy")).toBe("receivedDate");
      expect(url.searchParams.get("sortOrder")).toBe("desc");
      expect(url.searchParams.get("pageSize")).not.toBe(String(10 ** 3));
    }
  });

  it("preserves page order and removes duplicate records defensively", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const page = Number(url.searchParams.get("page"));

      return Response.json({
        data: page === 1
          ? [complaint("cmp-1"), complaint("cmp-2")]
          : [complaint("cmp-2"), complaint("cmp-3")],
        total: 4,
        page,
        pageSize: 100,
        totalPages: 2,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllComplaintsForReport(new URLSearchParams())).resolves.toEqual([
      complaint("cmp-1"),
      complaint("cmp-2"),
      complaint("cmp-3"),
    ]);
  });

  it("fails the whole report when a later page fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const page = Number(url.searchParams.get("page"));
      if (page === 2) {
        return new Response(null, { status: 500 });
      }

      return Response.json({
        data: Array.from({ length: 100 }, (_, index) => complaint(`cmp-${index + 1}`)),
        total: 101,
        page,
        pageSize: 100,
        totalPages: 2,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllComplaintsForReport(new URLSearchParams())).rejects.toThrow(
      "Failed to load report complaints"
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops before requesting another page when aborted", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      return Response.json({
        data: [complaint("cmp-1")],
        total: 250,
        page: 1,
        pageSize: 100,
        totalPages: 3,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllComplaintsForReport(new URLSearchParams(), controller.signal)).rejects.toThrow(
      "Report complaints request was aborted"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
