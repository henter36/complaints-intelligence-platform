import { describe, expect, it } from "vitest";
import { formatDate } from "@/lib/ar-utils";
import {
  buildImportMessageKey,
  buildImportQualitySummary,
  defaultPeriodRange,
  displayPreviewCell,
  formatLocalDate,
  formatPreviewDate,
  formatPreviewValue,
  getImportResultLabel,
  getVisiblePreviewEntries,
  HIDDEN_PREVIEW_FIELDS,
  mappingContainsComplaintNumber,
  normalizeUploadResultPayload,
  resolveBlockingRowCount,
  resolvePreviewComplaintNumber,
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

describe("formatPreviewValue", () => {
  it("formats primitive values", () => {
    expect(formatPreviewValue("test")).toBe("test");
    expect(formatPreviewValue(12)).toBe("12");
    expect(formatPreviewValue(true)).toBe("true");
  });

  it("formats arrays without object default stringification", () => {
    expect(formatPreviewValue(["أ", "ب"])).toBe("أ، ب");
  });

  it("serializes plain objects explicitly", () => {
    expect(formatPreviewValue({ code: "X" })).toBe(
      '{"code":"X"}',
    );
  });

  it("does not return object default stringification", () => {
    expect(formatPreviewValue({ value: 1 })).not.toBe(
      "[object Object]",
    );
  });

  it("handles nullish values", () => {
    expect(formatPreviewValue(null)).toBe("—");
    expect(formatPreviewValue(undefined)).toBe("—");
  });

  it("hides sensitive preview fields when building visible entries", () => {
    const entries = getVisiblePreviewEntries({
      subject: "موضوع",
      rawData: { secret: true },
      complainantIdentifier: "123",
      complainantPhone: "050",
      complainantIdentifierMasked: "***",
      externalId: "COMP/1",
    });

    const keys = entries.map(([key]) => key);
    expect(keys).toEqual(["subject", "externalId"]);
    expect(HIDDEN_PREVIEW_FIELDS.has("rawData")).toBe(true);
    expect(keys).not.toContain("rawData");
    expect(keys).not.toContain("complainantIdentifier");
  });
});

describe("resolvePreviewComplaintNumber", () => {
  it("falls back to externalId when complaintNumber is empty", () => {
    expect(
      resolvePreviewComplaintNumber({
        complaintNumber: "",
        externalId: "COMP/1",
      })
    ).toBe("COMP/1");
  });

  it("falls back to externalId when complaintNumber is whitespace-only", () => {
    expect(
      resolvePreviewComplaintNumber({
        complaintNumber: "   ",
        externalId: "COMP/2",
      })
    ).toBe("COMP/2");
  });

  it("prefers a trimmer non-blank complaintNumber over externalId", () => {
    expect(
      resolvePreviewComplaintNumber({
        complaintNumber: " COMP/3 ",
        externalId: "COMP/4",
      })
    ).toBe("COMP/3");
  });

  it("returns undefined when both identifiers are blank", () => {
    expect(
      resolvePreviewComplaintNumber({
        complaintNumber: "  ",
        externalId: "",
      })
    ).toBeUndefined();
    expect(formatPreviewValue(resolvePreviewComplaintNumber({}))).toBe("—");
  });
});

describe("formatPreviewDate", () => {
  it("returns the empty placeholder for blank and invalid values", () => {
    expect(formatPreviewDate("not-a-date")).toBe("—");
    expect(formatPreviewDate("")).toBe("—");
    expect(formatPreviewDate(null)).toBe("—");
    expect(formatPreviewDate(undefined)).toBe("—");
  });

  it("formats a valid ISO date using formatDate", () => {
    const iso = "2026-04-14T00:00:00.000Z";
    expect(formatPreviewDate(iso)).toBe(formatDate(new Date(iso)));
  });

  it("does not throw when preview rows carry an invalid receivedDate", () => {
    const previewRow = {
      row: 44,
      complaintNumber: "",
      externalId: "COMP/06271",
      receivedDate: "invalid-date",
    };

    expect(() => {
      const complaintNumber = formatPreviewValue(
        resolvePreviewComplaintNumber(previewRow)
      );
      const receivedDate = formatPreviewDate(previewRow.receivedDate);
      return { complaintNumber, receivedDate };
    }).not.toThrow();

    expect(formatPreviewValue(resolvePreviewComplaintNumber(previewRow))).toBe(
      "COMP/06271"
    );
    expect(formatPreviewDate(previewRow.receivedDate)).toBe("—");
  });
});
