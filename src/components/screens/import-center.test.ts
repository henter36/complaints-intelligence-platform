import { describe, expect, it } from "vitest";
import {
  defaultPeriodRange,
  formatLocalDate,
  mappingContainsComplaintNumber,
  normalizeUploadResultPayload,
} from "./import-center";

describe("import center date ranges", () => {
  it("formats local calendar dates without UTC conversion", () => {
    expect(formatLocalDate(new Date(2026, 0, 1, 0, 30))).toBe("2026-01-01");
  });

  it("keeps daily range on the selected local day", () => {
    expect(defaultPeriodRange("daily", new Date(2026, 2, 15))).toEqual({
      start: "2026-03-15",
      end: "2026-03-15",
    });
  });

  it("uses today plus the previous six days for weekly ranges", () => {
    expect(defaultPeriodRange("weekly", new Date(2026, 0, 1))).toEqual({
      start: "2025-12-26",
      end: "2026-01-01",
    });
  });

  it.each([
    [new Date(2026, 2, 31), "2026-03-01", "2026-03-31"],
    [new Date(2026, 2, 30), "2026-03-01", "2026-03-30"],
    [new Date(2024, 2, 29), "2024-03-01", "2024-03-29"],
    [new Date(2023, 2, 29), "2023-03-01", "2023-03-29"],
    [new Date(2026, 0, 1), "2025-12-02", "2026-01-01"],
  ])("computes monthly ranges without month overflow for %s", (today, start, end) => {
    const range = defaultPeriodRange("monthly", today);

    expect(range).toEqual({ start, end });
    expect(range.start <= range.end).toBe(true);
  });
});

describe("import center mapping helpers", () => {
  it.each([
    [{ "رقم الشكوى": "externalId" }, true],
    [{ "معرف الشكوى": "externalId" }, true],
    [{ "Header C": "externalId" }, true],
    [{ "الرقم المرجعي": "sourceReference" }, false],
    [undefined, false],
  ])("detects complaint number mapping %#", (mapping, expected) => {
    expect(mappingContainsComplaintNumber(mapping)).toBe(expected);
  });

  it("preserves unmapped columns from upload payload", () => {
    const result = normalizeUploadResultPayload({
      batchId: "batch_1",
      fileName: "complaints.xlsx",
      totalRecords: 1,
      validRecords: 1,
      newRecords: 1,
      updatedRecords: 0,
      duplicateRecords: 0,
      rejectedRecords: 0,
      incompleteRecords: 0,
      warningRecords: 0,
      noChangeRecords: 0,
      selectedSheet: "الشكاوى",
      hasComplaintNumber: false,
      unmappedColumns: ["عمود غير معروف"],
      columnMapping: { "معرف الشكوى": "externalId" },
      errors: [],
      preview: [],
      canApprove: false,
    });

    expect(result.hasComplaintNumber).toBe(true);
    expect(result.unmappedColumns).toEqual(["عمود غير معروف"]);
  });
});
