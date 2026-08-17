import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  buildComplaintQuery,
  ComplaintsExplorer,
  countActiveFilters,
  downloadComplaintExport,
  extractFileName,
  normalizeApiComplaintStatus,
  STATUS_OPTIONS,
  type FilterState,
} from "./complaints-explorer";

const baseFilters: FilterState = {
  search: "موعد",
  regionId: "الرياض",
  departmentId: "الدعم",
  facility: "سجن الحائر",
  classificationId: "cls_1",
  complainantIdentifier: "9988776655",
  channel: "الهاتف",
  status: "OPEN",
  priority: "HIGH",
  severity: "MEDIUM",
  from: "2026-07-01",
  to: "2026-07-31",
  sourceOrigin: "الجهاز الرئيسي",
  sourceStatus: "مغلقة",
  sourceActionStatus: "جديد",
  wingCode: "3",
  dataFreshnessBucket: "fresh_1d",
  isLate: true,
  isRepeated: true,
  isValidated: true,
  aiAnalyzed: true,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

describe("complaints explorer helpers", () => {
  it("uses API complaint status vocabulary", () => {
    const statusValues = STATUS_OPTIONS.map((option) => option.value);

    expect(statusValues).toEqual([
      "NEW",
      "OPEN",
      "IN_PROGRESS",
      "AWAITING_RESPONSE",
      "RESOLVED",
      "CLOSED",
      "CANCELLED",
    ]);
    expect(statusValues).not.toContain(["re", "opened"].join(""));
    expect(STATUS_OPTIONS.find((option) => option.value === "OPEN")?.label).toBe("مفتوحة");
  });

  it("normalizes legacy API statuses only at the response boundary", () => {
    expect(normalizeApiComplaintStatus("CLOSED")).toBe("CLOSED");
    expect(normalizeApiComplaintStatus("closed")).toBe("CLOSED");
    expect(normalizeApiComplaintStatus(["in", "progress"].join("_"))).toBe("IN_PROGRESS");
    expect(normalizeApiComplaintStatus(["re", "opened"].join(""))).toBe("OPEN");
    expect(normalizeApiComplaintStatus(["re", "jected"].join(""))).toBe("CANCELLED");
    expect(normalizeApiComplaintStatus("CANCELLED")).toBe("CANCELLED");
  });

  it("builds list and export queries from the same helper", () => {
    const listQuery = buildComplaintQuery(baseFilters, "receivedDate", "desc", 3);
    const exportQuery = buildComplaintQuery(baseFilters, "receivedDate", "desc");

    listQuery.delete("page");

    expect(listQuery.toString()).toBe(exportQuery.toString());
    expect(exportQuery.get("status")).toBe("OPEN");
    expect(exportQuery.get("sourceOrigin")).toBe("الجهاز الرئيسي");
    expect(exportQuery.get("sourceStatus")).toBe("مغلقة");
    expect(exportQuery.get("wingCode")).toBe("3");
    expect(exportQuery.get("dataFreshnessBucket")).toBe("fresh_1d");
    expect(exportQuery.get("channel")).toBe("الهاتف");
    expect(exportQuery.get("sortBy")).toBe("receivedDate");
    expect(exportQuery.get("sortOrder")).toBe("desc");
    expect(exportQuery.get("aiAnalyzed")).toBe("true");
  });

  it("carries the raw complainantIdentifier through the URL query (repeat-complainant drillthrough)", () => {
    const listQuery = buildComplaintQuery(baseFilters, "receivedDate", "desc");
    expect(listQuery.get("complainantIdentifier")).toBe("9988776655");
  });

  it("counts complainantIdentifier as an active filter and allows clearing it alone", () => {
    const withId = { ...baseFilters };
    const withoutId = { ...baseFilters, complainantIdentifier: "" };
    expect(countActiveFilters(withId)).toBe(countActiveFilters(withoutId) + 1);
    const cleared = buildComplaintQuery(withoutId, "receivedDate", "desc");
    expect(cleared.get("complainantIdentifier")).toBeNull();
  });

  it("counts dataFreshnessBucket in active filters and allows clearing it alone", () => {
    const withFreshness = { ...baseFilters };
    const withoutFreshness = { ...baseFilters, dataFreshnessBucket: "" };
    expect(countActiveFilters(withFreshness)).toBe(countActiveFilters(withoutFreshness) + 1);

    const cleared = buildComplaintQuery(withoutFreshness, "receivedDate", "desc");
    expect(cleared.get("dataFreshnessBucket")).toBeNull();
  });

  it("extracts attachment file names", () => {
    expect(extractFileName('attachment; filename="complaints-2026-07-30.csv"')).toBe(
      "complaints-2026-07-30.csv"
    );
    expect(extractFileName(null)).toBeNull();
  });

  it("downloads successful exports as blobs without navigating away", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("id\n1\n", {
        status: 200,
        headers: { "content-disposition": 'attachment; filename="complaints.csv"' },
      })
    );
    const createObjectURL = vi.fn().mockReturnValue("blob:test");
    const revokeObjectURL = vi.fn();
    const click = vi.fn();
    const originalLocation = window.location.href;

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const element = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        tagName
      ) as HTMLAnchorElement;
      if (tagName === "a") element.click = click;
      return element;
    });

    await downloadComplaintExport(baseFilters, "receivedDate", "desc");

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/complaints/export?"));
    expect(click).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
    expect(window.location.href).toBe(originalLocation);
  });

  it("surfaces export failures without changing window location", async () => {
    const originalLocation = window.location.href;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          { error: { message: "عدد نتائج التصدير يتجاوز الحد المسموح" } },
          { status: 422 }
        )
      )
    );

    await expect(downloadComplaintExport(baseFilters, "receivedDate", "desc")).rejects.toThrow(
      "عدد نتائج التصدير يتجاوز الحد المسموح"
    );
    expect(window.location.href).toBe(originalLocation);
  });

  it("uses a generic message for server export failures without JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    await expect(downloadComplaintExport(baseFilters, "receivedDate", "desc")).rejects.toThrow(
      "تعذر تصدير الشكاوى"
    );
  });
});

describe("complaints explorer dataFreshnessBucket UI", () => {
  it("shows dataFreshnessBucket from URL in advanced filters", async () => {
    window.history.replaceState(null, "", "/?dataFreshnessBucket=stale_3_7d");
    const user = userEvent.setup();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes("/api/filters")) {
          return Response.json({
            regions: [],
            departments: [],
            facilities: [],
            locations: [],
            categories: [],
            classifications: [],
            statuses: [],
            priorities: [],
            channels: [],
            sourceOrigins: [],
            sourceStatuses: [],
            sourceActionStatuses: [],
            wingCodes: [],
            dataFreshnessBuckets: [
              { id: "fresh_1d", name: "خلال يوم" },
              { id: "stale_1_3d", name: "1–3 أيام" },
              { id: "stale_3_7d", name: "3–7 أيام" },
              { id: "stale_7d_plus", name: "أكثر من 7 أيام" },
              { id: "missing", name: "بلا تاريخ تحديث" },
            ],
          });
        }
        return Response.json({
          items: [],
          pagination: { total: 0, totalPages: 0, page: 1, pageSize: 25 },
        });
      })
    );

    render(<ComplaintsExplorer />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /فلاتر متقدمة/ })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /فلاتر متقدمة/ }));
    expect(screen.getByText("حداثة البيانات")).toBeInTheDocument();

    const freshnessLabel = screen.getByText("حداثة البيانات");
    const freshnessField = freshnessLabel.closest("div");
    const freshnessTrigger = freshnessField?.querySelector('[role="combobox"]');
    expect(freshnessTrigger).toHaveTextContent("3–7 أيام");
    expect(screen.getByRole("button", { name: /فلاتر متقدمة/ })).toHaveTextContent("1");
  });

  it("shows facility from URL in advanced filters (drilldown-safe on reload)", async () => {
    window.history.replaceState(null, "", "/?facility=سجن+الحائر");
    const user = userEvent.setup();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes("/api/filters")) {
          return Response.json({
            regions: [],
            departments: [],
            facilities: [],
            locations: [
              { id: "سجن الحائر", name: "سجن الحائر" },
              { id: "سجن الملز", name: "سجن الملز" },
            ],
            categories: [],
            classifications: [],
            statuses: [],
            priorities: [],
            channels: [],
            sourceOrigins: [],
            sourceStatuses: [],
            sourceActionStatuses: [],
            wingCodes: [],
            dataFreshnessBuckets: [],
          });
        }
        return Response.json({
          items: [],
          pagination: { total: 0, totalPages: 0, page: 1, pageSize: 25 },
        });
      })
    );

    render(<ComplaintsExplorer />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /فلاتر متقدمة/ })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /فلاتر متقدمة/ }));
    const facilityLabel = screen.getByText("الموقع");
    const facilityField = facilityLabel.closest("div");
    const facilityTrigger = facilityField?.querySelector('[role="combobox"]');
    expect(facilityTrigger).toHaveTextContent("سجن الحائر");
  });

  it("reads complainantIdentifier from the URL on mount and sends it on every list fetch (reload-safe drillthrough)", async () => {
    window.history.replaceState(null, "", "/?complainantIdentifier=9988776655&facility=سجن+الحائر");

    const fetchSpy = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("/api/filters")) {
        return Response.json({
          regions: [], departments: [], facilities: [], locations: [], categories: [],
          classifications: [], statuses: [], priorities: [], channels: [],
          sourceOrigins: [], sourceStatuses: [], sourceActionStatuses: [], wingCodes: [], dataFreshnessBuckets: [],
        });
      }
      return Response.json({ items: [], pagination: { total: 0, totalPages: 0, page: 1, pageSize: 25 } });
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<ComplaintsExplorer />);
    await waitFor(() => {
      const listCall = fetchSpy.mock.calls.find(([input]) => String(input).includes("/api/complaints") && !String(input).includes("/api/complaints/export"));
      expect(listCall).toBeDefined();
      expect(String(listCall![0])).toContain("complainantIdentifier=9988776655");
    });
  });

  it("includes facility in the built complaint query", () => {
    const query = buildComplaintQuery(baseFilters, "receivedDate", "desc", 1);
    expect(query.get("facility")).toBe("سجن الحائر");
  });

  it("updates and clears dataFreshnessBucket in query helpers without resetting other filters", () => {
    const updated = buildComplaintQuery(
      { ...baseFilters, dataFreshnessBucket: "stale_7d_plus" },
      "receivedDate",
      "desc"
    );
    expect(updated.get("dataFreshnessBucket")).toBe("stale_7d_plus");
    expect(updated.get("sourceOrigin")).toBe("الجهاز الرئيسي");

    const cleared = buildComplaintQuery(
      { ...baseFilters, dataFreshnessBucket: "" },
      "receivedDate",
      "desc"
    );
    expect(cleared.get("dataFreshnessBucket")).toBeNull();
    expect(cleared.get("wingCode")).toBe("3");
    expect(countActiveFilters({ ...baseFilters, dataFreshnessBucket: "" })).toBe(
      countActiveFilters(baseFilters) - 1
    );
  });
});
