import { describe, expect, it } from "vitest";
import {
  buildImportMessageKey,
  buildImportQualitySummary,
  defaultPeriodRange,
  displayPreviewCell,
  formatLocalDate,
  getImportResultLabel,
  mappingContainsComplaintNumber,
  normalizeUploadResultPayload,
  resolveBlockingRowCount,
  resolveWarningRowCount,
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

describe("import result display helpers", () => {
  it.each([
    ["REJECTED", "مرفوض"],
    ["IMPORTED_WITH_WARNINGS", "مستورد مع تحذيرات"],
    ["IMPORTED", "مستورد"],
    [undefined, "غير محدد"],
    ["UNKNOWN", "غير محدد"],
  ] as const)("maps %s to %s", (result, label) => {
    expect(getImportResultLabel(result)).toBe(label);
  });

  it("builds stable keys that distinguish errors from warnings", () => {
    const message = {
      code: "DESCRIPTION_MISSING",
      field: "description",
      level: "warning",
      message: "الوصف غير موجود",
    };

    expect(buildImportMessageKey("error", 3, message)).toBe(
      "error:3:DESCRIPTION_MISSING:description:warning:الوصف غير موجود"
    );
    expect(buildImportMessageKey("warning", 3, message)).toBe(
      "warning:3:DESCRIPTION_MISSING:description:warning:الوصف غير موجود"
    );
    expect(buildImportMessageKey("error", 3, message)).not.toBe(
      buildImportMessageKey("warning", 3, message)
    );
  });

  it("keeps blocking and warning counts independent of the displayed slice", () => {
    const result = {
      batchId: "b1",
      fileName: "f.xlsx",
      totalRecords: 6010,
      validRecords: 6008,
      newRecords: 6005,
      updatedRecords: 0,
      duplicateRecords: 1,
      rejectedRecords: 1,
      incompleteRecords: 2,
      warningRecords: 6007,
      noChangeRecords: 0,
      selectedSheet: null,
      hasComplaintNumber: true,
      unmappedColumns: [],
      columnMapping: { "رقم الشكوى": "externalId" },
      errors: Array.from({ length: 100 }, (_, i) => ({
        row: i + 1,
        errors: i < 2 ? [{ message: "مانع" }] : [],
        warnings: i >= 2 ? [{ message: "تحذير" }] : [],
      })),
      preview: [],
      canApprove: false,
      blockingRowCount: 2,
      warningRowCount: 6007,
      displayedObservationCount: 100,
      qualityDisplayLimit: 100,
      qualityIssueRowsTotal: 6009,
    };

    expect(resolveBlockingRowCount(result)).toBe(2);
    expect(resolveWarningRowCount(result)).toBe(6007);
    expect(result.errors).toHaveLength(100);
    expect(resolveBlockingRowCount(result)).not.toBe(result.errors.length);
    expect(buildImportQualitySummary(result)).toMatch(/مانع/);
    expect(result.canApprove).toBe(false);
  });

  it("uses en-dash for missing preview cells", () => {
    expect(displayPreviewCell(null)).toBe("—");
    expect(displayPreviewCell("")).toBe("—");
    expect(displayPreviewCell("COMP/1")).toBe("COMP/1");
  });
});
