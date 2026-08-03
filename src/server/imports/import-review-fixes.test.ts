import { describe, expect, it } from "vitest";
import { ComplaintStatus } from "@prisma/client";
import { matchComplaintColumns } from "./complaint-column-schema";
import { resolveEffectiveColumnMapping } from "./excel-import-service";
import { ImportValidationError } from "./import-errors";
import { normalizeImportRow } from "./normalization";
import { validateNormalizedComplaintRow } from "./row-validation";
import { toColumnMappingStatusLabel } from "@/components/screens/import-center";

function taxonomyFixture() {
  const categoryA = {
    id: "cat_a",
    nameAr: "فئة ألف",
    nameEn: null,
    description: null,
    displayOrder: 1,
    isActive: true,
    isDeleted: false,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const categoryB = {
    ...categoryA,
    id: "cat_b",
    nameAr: "فئة باء",
  };
  const categoryAmbiguousTwin = {
    ...categoryA,
    id: "cat_a2",
    nameAr: "فئة ألف",
  };

  const classificationForA = {
    id: "cls_a",
    categoryId: "cat_a",
    nameAr: "تصنيف ألف",
    nameEn: null,
    description: null,
    color: "#000",
    keywords: null,
    displayOrder: 1,
    isActive: true,
    isDeleted: false,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    category: categoryA,
  };
  const classificationForB = {
    ...classificationForA,
    id: "cls_b",
    categoryId: "cat_b",
    nameAr: "تصنيف باء",
    category: categoryB,
  };
  const classificationAmbiguousTwin = {
    ...classificationForA,
    id: "cls_a2",
    nameAr: "تصنيف ألف",
  };

  return {
    categoryA,
    categoryB,
    categoryAmbiguousTwin,
    classificationForA,
    classificationForB,
    classificationAmbiguousTwin,
  };
}

describe("actionDescription and actionTaken fields", () => {
  it("maps وصف الإجراء to actionDescription (not resolution)", () => {
    const { mapping } = matchComplaintColumns([
      "رقم الشكوى",
      "تاريخ التسجيل",
      "الوصف",
      "وصف الإجراء",
    ]);
    expect(mapping["وصف الإجراء"]).toBe("actionDescription");

    const result = normalizeImportRow(
      {
        rowNumber: 2,
        values: {
          "رقم الشكوى": "C-1",
          "تاريخ التسجيل": 46126,
          "الوصف": "وصف",
          "وصف الإجراء": "حل نصي",
        },
      },
      mapping
    );

    expect(result.errors).toHaveLength(0);
    expect(result.normalized.actionDescription).toBe("حل نصي");
    expect(result.normalized.resolution).toBeUndefined();
  });

  it("rejects formula-like وصف الإجراء value without storing it", () => {
    const { mapping } = matchComplaintColumns([
      "رقم الشكوى",
      "تاريخ التسجيل",
      "الوصف",
      "وصف الإجراء",
    ]);
    const result = normalizeImportRow(
      {
        rowNumber: 2,
        values: {
          "رقم الشكوى": "C-1",
          "تاريخ التسجيل": 46126,
          "الوصف": "وصف",
          "وصف الإجراء": "=CMD()",
        },
      },
      mapping
    );

    expect(result.normalized.actionDescription).toBeUndefined();
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "FORMULA_NOT_ALLOWED" })])
    );
  });

  it("maps الإجراء المتخذ to actionTaken and وصف الإجراء to actionDescription independently", () => {
    const { mapping, conflicts } = matchComplaintColumns([
      "رقم الشكوى",
      "تاريخ التسجيل",
      "الوصف",
      "الإجراء المتخذ",
      "وصف الإجراء",
    ]);

    expect(mapping["الإجراء المتخذ"]).toBe("actionTaken");
    expect(mapping["وصف الإجراء"]).toBe("actionDescription");
    expect(conflicts).toHaveLength(0);

    const result = normalizeImportRow(
      {
        rowNumber: 2,
        values: {
          "رقم الشكوى": "C-1",
          "تاريخ التسجيل": 46126,
          "الوصف": "وصف",
          "الإجراء المتخذ": "إجراء أساسي",
          "وصف الإجراء": "وصف بديل",
        },
      },
      mapping
    );
    expect(result.normalized.actionTaken).toBe("إجراء أساسي");
    expect(result.normalized.actionDescription).toBe("وصف بديل");
    expect(result.normalized.resolution).toBeUndefined();
  });
});

describe("required column mapping analysis details", () => {
  it("attaches missingRequiredFields and mappingAnalysis to IMPORT_REQUIRED_COLUMNS_MISSING", () => {
    try {
      resolveEffectiveColumnMapping({
        headers: ["عمود عشوائي", "عمود آخر"],
        callerMapping: {},
        storedMapping: {},
      });
      throw new Error("expected IMPORT_REQUIRED_COLUMNS_MISSING");
    } catch (error) {
      expect(error).toBeInstanceOf(ImportValidationError);
      const importError = error as ImportValidationError;
      expect(importError.code).toBe("IMPORT_REQUIRED_COLUMNS_MISSING");
      expect(importError.status).toBe(422);
      expect(importError.details?.missingRequiredFields).toEqual(
        expect.arrayContaining([
          "externalId|sourceReference",
          "complaintDate|receivedAt",
          "subject|description",
        ])
      );
      expect(importError.details?.mappingAnalysis).toMatchObject({
        missingRequiredFields: expect.arrayContaining([
          "externalId|sourceReference",
          "complaintDate|receivedAt",
          "subject|description",
        ]),
      });
    }
  });

  it("reports individual missing required groups", () => {
    try {
      resolveEffectiveColumnMapping({
        headers: ["رقم الشكوى", "الموضوع"],
        callerMapping: {},
        storedMapping: {},
      });
      throw new Error("expected IMPORT_REQUIRED_COLUMNS_MISSING");
    } catch (error) {
      const importError = error as ImportValidationError;
      expect(importError.code).toBe("IMPORT_REQUIRED_COLUMNS_MISSING");
      expect(importError.details?.missingRequiredFields).toEqual(["complaintDate|receivedAt"]);
    }
  });

  it("keeps successful mappings unchanged", () => {
    const result = resolveEffectiveColumnMapping({
      headers: ["رقم الشكوى", "تاريخ الشكوى", "الموضوع"],
      callerMapping: {},
      storedMapping: {},
    });

    expect(result.columnMapping).toMatchObject({
      "رقم الشكوى": "externalId",
      "تاريخ الشكوى": "complaintDate",
      "الموضوع": "subject",
    });
    expect(result.mappingAnalysis.missingRequiredFields).toEqual([]);
  });
});

describe("category and classification consistency", () => {
  const fixtures = taxonomyFixture();

  it("does not adopt a lone classification when the source category is unknown", () => {
    const row = {
      externalId: "C-1",
      complaintDate: new Date("2026-07-01T00:00:00Z"),
      subject: "موضوع",
      category: "فئة غير موجودة",
      classification: "تصنيف ألف",
    };
    const result = validateNormalizedComplaintRow(row, {
      categories: [fixtures.categoryA],
      classifications: [fixtures.classificationForA],
    });

    expect(row.category).toBeUndefined();
    expect(row.classification).toBeUndefined();
    expect(result.warnings.map((item) => item.code)).toEqual(
      expect.arrayContaining(["CATEGORY_NOT_FOUND", "CLASSIFICATION_PARENT_UNRESOLVED"])
    );
  });

  it("does not adopt a lone classification when the source category is ambiguous", () => {
    const row = {
      externalId: "C-1",
      complaintDate: new Date("2026-07-01T00:00:00Z"),
      subject: "موضوع",
      category: "فئة ألف",
      classification: "تصنيف ألف",
    };
    const result = validateNormalizedComplaintRow(row, {
      categories: [fixtures.categoryA, fixtures.categoryAmbiguousTwin],
      classifications: [fixtures.classificationForA],
    });

    expect(row.category).toBeUndefined();
    expect(row.classification).toBeUndefined();
    expect(result.warnings.map((item) => item.code)).toEqual(
      expect.arrayContaining(["CATEGORY_AMBIGUOUS", "CLASSIFICATION_PARENT_UNRESOLVED"])
    );
  });

  it("rejects mismatched category/classification without swapping parents", () => {
    const row = {
      externalId: "C-1",
      complaintDate: new Date("2026-07-01T00:00:00Z"),
      subject: "موضوع",
      category: "فئة ألف",
      classification: "تصنيف باء",
    };
    const result = validateNormalizedComplaintRow(row, {
      categories: [fixtures.categoryA, fixtures.categoryB],
      classifications: [fixtures.classificationForA, fixtures.classificationForB],
    });

    expect(row.category).toBe("فئة ألف");
    expect(row.classification).toBeUndefined();
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "CLASSIFICATION_CATEGORY_MISMATCH" })])
    );
  });

  it("keeps compatible category and classification", () => {
    const row = {
      externalId: "C-1",
      complaintDate: new Date("2026-07-01T00:00:00Z"),
      subject: "موضوع",
      category: "فئة ألف",
      classification: "تصنيف ألف",
    };
    const result = validateNormalizedComplaintRow(row, {
      categories: [fixtures.categoryA],
      classifications: [fixtures.classificationForA],
    });

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(row.category).toBe("فئة ألف");
    expect(row.classification).toBe("تصنيف ألف");
  });

  it("allows a lone classification when no category was provided", () => {
    const row = {
      externalId: "C-1",
      complaintDate: new Date("2026-07-01T00:00:00Z"),
      subject: "موضوع",
      classification: "تصنيف ألف",
    };
    const result = validateNormalizedComplaintRow(row, {
      categories: [fixtures.categoryA],
      classifications: [fixtures.classificationForA],
    });

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(row.classification).toBe("تصنيف ألف");
  });

  it("clears ambiguous classifications", () => {
    const row = {
      externalId: "C-1",
      complaintDate: new Date("2026-07-01T00:00:00Z"),
      subject: "موضوع",
      classification: "تصنيف ألف",
    };
    const result = validateNormalizedComplaintRow(row, {
      categories: [fixtures.categoryA],
      classifications: [fixtures.classificationForA, fixtures.classificationAmbiguousTwin],
    });

    expect(row.classification).toBeUndefined();
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "CLASSIFICATION_AMBIGUOUS" })])
    );
  });
});

describe("resolution synonym الحل", () => {
  it("maps الحل to resolution", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ الشكوى", "الموضوع", "الحل"]);
    expect(mapping["الحل"]).toBe("resolution");
  });

  it("maps الإجراء المتخذ to actionTaken and الحل to resolution without conflict", () => {
    const { mapping, conflicts } = matchComplaintColumns([
      "رقم الشكوى",
      "تاريخ الشكوى",
      "الموضوع",
      "الإجراء المتخذ",
      "الحل",
    ]);
    expect(mapping["الإجراء المتخذ"]).toBe("actionTaken");
    expect(mapping["الحل"]).toBe("resolution");
    expect(conflicts).toHaveLength(0);
  });
});

describe("mapping status Arabic labels", () => {
  it("returns Arabic labels for known statuses and a safe fallback", () => {
    expect(toColumnMappingStatusLabel("AUTO_MAPPED")).toBe("مطابق تلقائيًا");
    expect(toColumnMappingStatusLabel("MANUALLY_MAPPED")).toBe("مطابق يدويًا");
    expect(toColumnMappingStatusLabel("UNMAPPED_PRESERVED")).toBe("غير مطابق — تم الاحتفاظ به");
    expect(toColumnMappingStatusLabel("MISSING_REQUIRED")).toBe("حقل إلزامي مفقود");
    expect(toColumnMappingStatusLabel("CONFLICT")).toBe("تعارض في المطابقة");
    expect(toColumnMappingStatusLabel("FUTURE_STATUS")).toBe("حالة مطابقة غير معروفة");
  });
});

describe("formula-like status sanity", () => {
  it("keeps NEW default for unknown statuses without formula issues", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ الشكوى", "الموضوع", "الحالة"]);
    const result = normalizeImportRow(
      {
        rowNumber: 2,
        values: {
          "رقم الشكوى": "C-1",
          "تاريخ الشكوى": "2026-07-01",
          "الموضوع": "موضوع",
          "الحالة": "حالة مصدرية",
        },
      },
      mapping
    );
    expect(result.normalized.status).toBe(ComplaintStatus.NEW);
  });
});
