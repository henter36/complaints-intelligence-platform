import { describe, expect, it } from "vitest";
import { ComplaintStatus } from "@prisma/client";
import { normalizeArabic } from "./arabic-normalize";
import {
  matchComplaintColumns,
  normalizeColumnHeader,
  parseColumnMapping,
  validateColumnMapping,
} from "./complaint-column-schema";
import { normalizeImportRow, normalizeArabic as reexportedNormalizeArabic } from "./normalization";
import { validateNormalizedComplaintRow } from "./row-validation";
import { resolveEffectiveColumnMapping } from "./excel-import-service";

describe("normalizeArabic shared rules", () => {
  it("strips Arabic diacritics and tatweel", () => {
    expect(normalizeArabic("المُــعَـرَّف")).toBe("المعرف");
    expect(normalizeArabic("تَشْكِيل")).toBe("تشكيل");
  });

  it("folds alef, alef maqsura, and ta marbuta", () => {
    expect(normalizeArabic("إأآا")).toBe("اااا");
    expect(normalizeArabic("ى")).toBe("ي");
    expect(normalizeArabic("ة")).toBe("ه");
  });

  it("is re-exported from normalization without changing behavior", () => {
    expect(reexportedNormalizeArabic("الإجراء")).toBe(normalizeArabic("الإجراء"));
  });
});

describe("call-site wrappers keep extras on top of normalizeArabic", () => {
  it("normalizeColumnHeader collapses spaces and lowercases", () => {
    expect(normalizeColumnHeader("  المُــعَـرَّف  ")).toBe("المعرف");
    expect(normalizeColumnHeader("آأإا  ةة  ىى")).toBe("اااا هه يي");
    expect(normalizeColumnHeader("Complaint ID")).toBe("complaint id");
  });

  it("maps headers that differ only by diacritics, tatweel, or hamza", () => {
    const { mapping } = matchComplaintColumns([
      "رَقْم الشَّكْوى",
      "المُــعَـرَّف",
      "تَارِيخ التَّسْجِيل",
      "الوَصْف",
    ]);

    expect(mapping["رَقْم الشَّكْوى"]).toBe("externalId");
    expect(mapping["المُــعَـرَّف"]).toBe("sourceReference");
    expect(mapping["تَارِيخ التَّسْجِيل"]).toBe("receivedAt");
    expect(mapping["الوَصْف"]).toBe("description");
  });

  it("normalizeArabicToken path matches known status labels with diacritics and ta marbuta", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ الشكوى", "الموضوع", "الحالة"]);
    const result = normalizeImportRow(
      {
        rowNumber: 2,
        values: {
          "رقم الشكوى": "C-1",
          "تاريخ الشكوى": "2026-07-01",
          "الموضوع": "اختبار",
          "الحالة": "جَدِيدَة",
        },
      },
      mapping
    );

    expect(result.errors).toHaveLength(0);
    expect(result.normalized.status).toBe(ComplaintStatus.NEW);
  });

  it("normalizeLookup matches taxonomy names that use ى or ة variants", () => {
    const taxonomy = {
      categories: [
        {
          id: "cat_1",
          nameAr: "فئة عامة",
          nameEn: null,
          description: null,
          displayOrder: 1,
          isActive: true,
          isDeleted: false,
          deletedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      classifications: [
        {
          id: "cls_1",
          categoryId: "cat_1",
          nameAr: "شكوى",
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
          category: {
            id: "cat_1",
            nameAr: "فئة عامة",
            nameEn: null,
            description: null,
            displayOrder: 1,
            isActive: true,
            isDeleted: false,
            deletedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
      ],
    };

    const matched = validateNormalizedComplaintRow(
      {
        externalId: "C-1",
        complaintDate: new Date("2026-07-01T00:00:00Z"),
        subject: "موضوع",
        category: "فئه عامه",
        classification: "شكوى",
      },
      taxonomy,
      new Date("2026-07-01T00:00:00Z")
    );

    expect(matched.errors).toHaveLength(0);
    expect(matched.warnings).toHaveLength(0);
  });
});

describe("complaint-column-schema contracts remain stable", () => {
  it("rejects invalid mappings with the same error codes", () => {
    expect(() => parseColumnMapping({ "رقم الشكوى": "unknownField" })).toThrow(
      expect.objectContaining({ code: "IMPORT_INVALID_COLUMN_MAPPING" })
    );
    expect(() =>
      validateColumnMapping({
        "رقم الشكوى": "externalId",
        "معرف الشكوى": "externalId",
        "تاريخ الشكوى": "complaintDate",
        "الموضوع": "subject",
      })
    ).toThrow(expect.objectContaining({ code: "DUPLICATE_IMPORT_COLUMN" }));
  });

  it("treats empty mapping payloads as absent and falls back to header matching", () => {
    expect(parseColumnMapping({})).toBeUndefined();
    expect(parseColumnMapping({ "   ": "externalId" })).toBeUndefined();

    const { columnMapping } = resolveEffectiveColumnMapping({
      headers: ["رقم الشكوى", "تاريخ الشكوى", "الموضوع"],
      callerMapping: {},
      storedMapping: {},
    });

    expect(columnMapping).toMatchObject({
      "رقم الشكوى": "externalId",
      "تاريخ الشكوى": "complaintDate",
      "الموضوع": "subject",
    });
  });

  it("does not treat an empty object as a completed mapping", () => {
    const parsed = parseColumnMapping({});
    expect(parsed).toBeUndefined();
    if (parsed) {
      expect(() => validateColumnMapping(parsed)).toThrow();
    }
  });
});
