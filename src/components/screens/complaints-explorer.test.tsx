import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildComplaintQuery,
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
  classificationId: "cls_1",
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
    expect(exportQuery.get("channel")).toBe("الهاتف");
    expect(exportQuery.get("sortBy")).toBe("receivedDate");
    expect(exportQuery.get("sortOrder")).toBe("desc");
    expect(exportQuery.get("aiAnalyzed")).toBe("true");
  });

  it("extracts attachment file names", () => {
    expect(extractFileName('attachment; filename="complaints-2026-07-30.csv"')).toBe("complaints-2026-07-30.csv");
    expect(extractFileName(null)).toBeNull();
  });

  it("downloads successful exports as blobs without navigating away", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("id\n1\n", {
      status: 200,
      headers: { "content-disposition": 'attachment; filename="complaints.csv"' },
    }));
    const createObjectURL = vi.fn().mockReturnValue("blob:test");
    const revokeObjectURL = vi.fn();
    const click = vi.fn();
    const originalLocation = window.location.href;

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const element = document.createElementNS("http://www.w3.org/1999/xhtml", tagName) as HTMLAnchorElement;
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      { error: { message: "عدد نتائج التصدير يتجاوز الحد المسموح" } },
      { status: 422 }
    )));

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
