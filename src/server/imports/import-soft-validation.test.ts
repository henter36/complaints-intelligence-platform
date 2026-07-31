import { describe, expect, it } from "vitest";
import { ComplaintStatus } from "@prisma/client";
import { matchComplaintColumns } from "./complaint-column-schema";
import {
  buildImportErrorCsv,
  resolveImportRowReference,
} from "./error-report";
import { normalizeImportRow } from "./normalization";
import { validateNormalizedComplaintRow } from "./row-validation";
import { buildComplaintTiming } from "@/server/complaints/complaint-timing";
import { ImportRowAction, ImportRowValidationStatus } from "@prisma/client";

describe("soft description validation", () => {
  it("keeps an explicit description", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل", "الوصف"]);
    const result = normalizeImportRow(
      {
        rowNumber: 2,
        values: {
          "رقم الشكوى": "C-1",
          "تاريخ التسجيل": "2026-07-01",
          "الوصف": "وصف صريح",
        },
      },
      mapping
    );
    expect(result.normalized.description).toBe("وصف صريح");
    expect(result.warnings.some((item) => item.code?.startsWith("DESCRIPTION_"))).toBe(false);
  });

  it("derives description from subject when description is missing", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل", "الموضوع"]);
    const result = normalizeImportRow(
      {
        rowNumber: 2,
        values: {
          "رقم الشكوى": "C-1",
          "تاريخ التسجيل": "2026-07-01",
          "الموضوع": "موضوع بديل",
        },
      },
      mapping
    );
    expect(result.normalized.description).toBe("موضوع بديل");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DESCRIPTION_DERIVED_FROM_SUBJECT",
          level: "derived",
          source: "subject",
        }),
      ])
    );
    const validation = validateNormalizedComplaintRow(result.normalized, {
      categories: [],
      classifications: [],
    });
    expect(validation.errors.some((item) => item.code === "MISSING_TEXT")).toBe(false);
  });

  it("derives a neutral description from classification when no text exists", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل", "تصنيف"]);
    const result = normalizeImportRow(
      {
        rowNumber: 2,
        values: {
          "رقم الشكوى": "C-1",
          "تاريخ التسجيل": "2026-07-01",
          "تصنيف": "الرعاية الصحية",
        },
      },
      mapping
    );
    expect(result.normalized.description).toContain("الرعاية الصحية");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "DESCRIPTION_DERIVED_FROM_CLASSIFICATION", level: "derived" }),
      ])
    );
  });

  it("warns without rejecting when all text fields are missing", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل"]);
    const result = normalizeImportRow(
      {
        rowNumber: 2,
        values: {
          "رقم الشكوى": "C-1",
          "تاريخ التسجيل": "2026-07-01",
        },
      },
      mapping
    );
    expect(result.normalized.description).toBeUndefined();
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "DESCRIPTION_MISSING", level: "warning" })])
    );
    const validation = validateNormalizedComplaintRow(result.normalized, {
      categories: [],
      classifications: [],
    });
    expect(validation.errors).toHaveLength(0);
  });
});

describe("terminal status without closedAt", () => {
  it("allows non-terminal status without closedAt", () => {
    const result = validateNormalizedComplaintRow(
      {
        externalId: "C-1",
        receivedAt: new Date("2026-07-01T00:00:00Z"),
        subject: "موضوع",
        status: ComplaintStatus.OPEN,
      },
      { categories: [], classifications: [] }
    );
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some((item) => item.code === "TERMINAL_STATUS_WITHOUT_CLOSED_AT")).toBe(false);
  });

  it("warns for terminal status without inventing a closedAt", () => {
    for (const status of [ComplaintStatus.CLOSED, ComplaintStatus.RESOLVED, ComplaintStatus.CANCELLED]) {
      const row = {
        externalId: "C-1",
        receivedAt: new Date("2026-07-01T00:00:00Z"),
        subject: "موضوع",
        status,
      };
      const result = validateNormalizedComplaintRow(row, { categories: [], classifications: [] });
      expect(result.errors.some((item) => item.code === "CLOSED_STATUS_REQUIRES_CLOSED_AT")).toBe(false);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "TERMINAL_STATUS_WITHOUT_CLOSED_AT",
            level: "warning",
          }),
        ])
      );
      expect(row).not.toHaveProperty("closedAt");
    }
  });

  it("keeps an explicit closedAt for terminal status", () => {
    const result = validateNormalizedComplaintRow(
      {
        externalId: "C-1",
        receivedAt: new Date("2026-07-01T00:00:00Z"),
        closedAt: new Date("2026-07-25T00:00:00Z"),
        subject: "موضوع",
        status: ComplaintStatus.CLOSED,
      },
      { categories: [], classifications: [] }
    );
    expect(result.warnings.some((item) => item.code === "TERMINAL_STATUS_WITHOUT_CLOSED_AT")).toBe(false);
  });

  it("does not use receivedAt or now as closedAt", () => {
    const receivedAt = new Date("2026-04-14T00:00:00Z");
    const row = {
      externalId: "C-1",
      receivedAt,
      subject: "موضوع",
      status: ComplaintStatus.CLOSED,
    };
    validateNormalizedComplaintRow(row, { categories: [], classifications: [] });
    expect((row as { closedAt?: Date }).closedAt).toBeUndefined();
  });
});

describe("error report complaint number", () => {
  it("resolves complaint number from externalId, raw headers, or غير متوفر", () => {
    expect(resolveImportRowReference({ externalId: "COMP/1" })).toBe("COMP/1");
    expect(
      resolveImportRowReference({
        externalId: null,
        rawData: { "رقم الشكوى": "COMP/RAW-1", "الوصف": "x" },
      })
    ).toBe("COMP/RAW-1");
    expect(resolveImportRowReference({ externalId: null, rawData: {} })).toBe("غير متوفر");
  });

  it("keeps complaint number visible in CSV even when the row is invalid", () => {
    const csv = buildImportErrorCsv([
      {
        rowNumber: 5,
        action: ImportRowAction.REJECT,
        validationStatus: ImportRowValidationStatus.INVALID,
        externalId: null,
        rawData: { "رقم الشكوى": "COMP/16219" },
        validationErrors: [
          {
            field: "complaintDate",
            code: "MISSING_COMPLAINT_DATE",
            message: "يجب توفير تاريخ الشكوى أو تاريخ الورود",
            level: "error",
          },
        ],
        validationWarnings: [
          {
            field: "description",
            code: "DESCRIPTION_MISSING",
            message: "الوصف غير موجود في المصدر، وسيُستورد الصف دون وصف.",
            level: "warning",
          },
        ],
      },
    ]);

    expect(csv).toContain("COMP/16219");
    expect(csv).toContain("خطأ");
    expect(csv).toContain("تحذير");
    expect(csv).not.toContain("[object Object]");
    expect(csv).not.toContain("undefined");
    expect(csv.split("\n")[0]).toContain("رقم الشكوى");
  });
});

describe("KPI timing excludes terminal rows without closedAt", () => {
  it("keeps resolutionDays null and does not mark due-date compliance", () => {
    const timing = buildComplaintTiming({
      status: ComplaintStatus.CLOSED,
      complaintDate: new Date("2026-07-01T00:00:00Z"),
      receivedAt: new Date("2026-07-01T00:00:00Z"),
      dueDate: new Date("2026-07-10T00:00:00Z"),
      closedAt: null,
    });

    expect(timing.resolutionDays).toBeNull();
    expect(timing.isClosedWithinDueDate).toBe(false);
    expect(timing.wasClosedLate).toBe(false);
  });
});

describe("identity remains blocking", () => {
  it("rejects rows without externalId or sourceReference", () => {
    const result = validateNormalizedComplaintRow(
      {
        receivedAt: new Date("2026-07-01T00:00:00Z"),
        subject: "موضوع",
      },
      { categories: [], classifications: [] }
    );
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MISSING_IDENTITY", level: "error" })])
    );
  });
});
