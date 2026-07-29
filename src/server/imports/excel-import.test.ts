import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import {
  matchComplaintColumns,
  normalizeColumnHeader,
  parseColumnMapping,
  validateColumnMapping,
} from "./complaint-column-schema";
import { getRequiredUncompressedSize, validateXlsxZip } from "./file-storage";
import { buildImportErrorCsv, toSafeMessage } from "./error-report";
import { normalizeDateCell, normalizeExcelSerialDate, normalizeImportRow, normalizeTextCell } from "./normalization";
import { parseXlsxWorkbook } from "./xlsx-parser";
import {
  DUPLICATE_BLOCKING_IMPORT_STATUSES,
  complaintCandidateIdentityKeys,
  hasMeaningfulChange,
  normalizedCandidateIdentityKeys,
  persistPreviewRows,
  resolveEffectiveColumnMapping,
  type ProcessedImportRow,
} from "./excel-import-service";
import {
  ComplaintPriority,
  ComplaintStatus,
  ImportBatchStatus,
  ImportRowAction,
  ImportRowValidationStatus,
} from "@prisma/client";
import { validateNormalizedComplaintRow } from "./row-validation";

async function workbookBuffer(options: {
  sheets?: Array<{ name: string; rows: string[][]; state?: string }>;
  extra?: Record<string, string>;
} = {}): Promise<Buffer> {
  const zip = new JSZip();
  const sheets = options.sheets ?? [
    {
      name: "الشكاوى",
      rows: [
        ["رقم الشكوى", "تاريخ الشكوى", "الموضوع", "الحالة"],
        ["C-1", "2026-07-01", "نص عربي", "مفتوح"],
      ],
    },
  ];

  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"${sheet.state ? ` state="${sheet.state}"` : ""}/>`).join("")}
  </sheets>
</workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}
</Relationships>`);

  for (const [sheetIndex, sheet] of sheets.entries()) {
    zip.file(`xl/worksheets/sheet${sheetIndex + 1}.xml`, `<?xml version="1.0" encoding="UTF-8"?>
<worksheet><sheetData>
${sheet.rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">
${row.map((value, columnIndex) => {
  const column = String.fromCharCode(65 + columnIndex);
  return `<c r="${column}${rowIndex + 1}" t="inlineStr"><is><t>${value}</t></is></c>`;
}).join("")}
</row>`).join("")}
</sheetData></worksheet>`);
  }

  for (const [name, content] of Object.entries(options.extra ?? {})) {
    zip.file(name, content);
  }

  return zip.generateAsync({ type: "nodebuffer" });
}

function expectImportMappingError(callback: () => unknown, code: string): void {
  try {
    callback();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }

  throw new Error("Expected import mapping error");
}

describe("secure xlsx import parsing", () => {
  it("parses a valid Arabic complaint workbook", async () => {
    const parsed = await parseXlsxWorkbook(await workbookBuffer());

    expect(parsed.selectedSheet).toBe("الشكاوى");
    expect(parsed.headers).toEqual(["رقم الشكوى", "تاريخ الشكوى", "الموضوع", "الحالة"]);
    expect(parsed.rows[0]).toMatchObject({
      rowNumber: 2,
      values: {
        "رقم الشكوى": "C-1",
        "الموضوع": "نص عربي",
      },
    });
  });

  it("rejects zip slip entries", async () => {
    const buffer = await workbookBuffer({ extra: { "../evil.txt": "bad" } });

    await expect(validateXlsxZip(buffer)).rejects.toMatchObject({
      code: "IMPORT_ZIP_SLIP_DETECTED",
    });
  });

  it("rejects active workbook content", async () => {
    const buffer = await workbookBuffer({ extra: { "xl/vbaProject.bin": "macro" } });

    await expect(validateXlsxZip(buffer)).rejects.toMatchObject({
      code: "IMPORT_XLSX_ACTIVE_CONTENT",
    });
  });

  it("rejects ambiguous visible data sheets", async () => {
    const buffer = await workbookBuffer({
      sheets: [
        { name: "A", rows: [["رقم الشكوى"], ["C-1"]] },
        { name: "B", rows: [["رقم الشكوى"], ["C-2"]] },
      ],
    });

    await expect(parseXlsxWorkbook(buffer)).rejects.toMatchObject({
      code: "IMPORT_AMBIGUOUS_SHEETS",
    });
  });

  it("keeps formulas as unsafe values for row validation", () => {
    const mapping = matchComplaintColumns(["رقم الشكوى", "تاريخ الشكوى", "الموضوع"]);
    const result = normalizeImportRow(
      {
        rowNumber: 2,
        values: {
          "رقم الشكوى": "C-1",
          "تاريخ الشكوى": "2026-07-01",
          "الموضوع": "=HYPERLINK(\"http://example.test\")",
        },
      },
      mapping
    );

    expect(result.errors).toContainEqual(expect.objectContaining({ code: "FORMULA_NOT_ALLOWED" }));
  });

  it("normalizes Excel serial dates without relying on locale timezone", () => {
    expect(normalizeExcelSerialDate(45108)?.toISOString()).toBe("2023-07-01T00:00:00.000Z");
  });

  it("validates required mapped columns", () => {
    const mapping = matchComplaintColumns(["رقم الشكوى", "الموضوع"]);

    expect(() => validateColumnMapping(mapping)).toThrow(/تاريخ/);
  });

  it("parses a valid caller column mapping at runtime", () => {
    const mapping = parseColumnMapping({
      "رقم الشكوى": "externalId",
      "تاريخ الشكوى": "complaintDate",
      "الموضوع": "subject",
    });

    expect(mapping).toEqual({
      "رقم الشكوى": "externalId",
      "تاريخ الشكوى": "complaintDate",
      "الموضوع": "subject",
    });
    expect(() => validateColumnMapping(mapping!, ["رقم الشكوى", "تاريخ الشكوى", "الموضوع"])).not.toThrow();
  });

  it("treats empty caller and stored mappings as absent so headers can be auto-matched", () => {
    expect(parseColumnMapping({})).toBeUndefined();
    expect(parseColumnMapping({ "   ": "externalId" })).toBeUndefined();

    const mapping = matchComplaintColumns(["رقم الشكوى", "تاريخ الشكوى", "الموضوع"]);

    expect(mapping).toMatchObject({
      "رقم الشكوى": "externalId",
      "تاريخ الشكوى": "complaintDate",
      "الموضوع": "subject",
    });
    expect(() => validateColumnMapping(mapping, ["رقم الشكوى", "تاريخ الشكوى", "الموضوع"])).not.toThrow();
  });

  it.each([
    ["unknown field", { "رقم الشكوى": "unknownField" }],
    ["array mapping", []],
    ["string mapping", "externalId"],
    ["dangerous proto key", JSON.parse("{\"__proto__\":\"externalId\"}")],
    ["dangerous constructor key", { constructor: "externalId" }],
  ])("rejects invalid column mapping payloads: %s", (_label, payload) => {
    expectImportMappingError(() => parseColumnMapping(payload), "IMPORT_INVALID_COLUMN_MAPPING");
  });

  it("rejects empty headers when mixed with valid mapping entries", () => {
    expectImportMappingError(() => parseColumnMapping({
      " ": "externalId",
      "تاريخ الشكوى": "complaintDate",
    }), "IMPORT_INVALID_COLUMN_MAPPING");
  });

  it("rejects mappings that point to missing headers or duplicate target fields", () => {
    expectImportMappingError(() => validateColumnMapping({
      "رقم الشكوى": "externalId",
      "تاريخ الشكوى": "complaintDate",
      "الموضوع": "subject",
    }, ["رقم الشكوى", "الموضوع"]), "IMPORT_INVALID_COLUMN_MAPPING");

    expectImportMappingError(() => validateColumnMapping({
      "رقم الشكوى": "externalId",
      "معرف الشكوى": "externalId",
      "تاريخ الشكوى": "complaintDate",
      "الموضوع": "subject",
    }), "DUPLICATE_IMPORT_COLUMN");
  });

  it("resolves caller mapping before stored mapping and auto matching", () => {
    const headers = ["رقم الشكوى", "الرقم المرجعي", "تاريخ الشكوى", "الموضوع"];
    const mapping = resolveEffectiveColumnMapping({
      headers,
      callerMapping: {
        "الرقم المرجعي": "sourceReference",
        "تاريخ الشكوى": "complaintDate",
        "الموضوع": "subject",
      },
      storedMapping: {
        "رقم الشكوى": "externalId",
        "تاريخ الشكوى": "complaintDate",
        "الموضوع": "subject",
      },
    });

    expect(mapping).toMatchObject({
      "الرقم المرجعي": "sourceReference",
      "تاريخ الشكوى": "complaintDate",
      "الموضوع": "subject",
    });
    expect(mapping).not.toHaveProperty("رقم الشكوى");
  });

  it("falls back from empty caller mapping to stored mapping", () => {
    const mapping = resolveEffectiveColumnMapping({
      headers: ["رقم الشكوى", "تاريخ الشكوى", "الموضوع"],
      callerMapping: {},
      storedMapping: {
        "رقم الشكوى": "externalId",
        "تاريخ الشكوى": "complaintDate",
        "الموضوع": "subject",
      },
    });

    expect(mapping).toMatchObject({
      "رقم الشكوى": "externalId",
      "تاريخ الشكوى": "complaintDate",
      "الموضوع": "subject",
    });
  });

  it("falls back from empty caller and stored mappings to workbook header matching", () => {
    const mapping = resolveEffectiveColumnMapping({
      headers: ["رقم الشكوى", "تاريخ الشكوى", "الموضوع"],
      callerMapping: {},
      storedMapping: {},
    });

    expect(mapping).toMatchObject({
      "رقم الشكوى": "externalId",
      "تاريخ الشكوى": "complaintDate",
      "الموضوع": "subject",
    });
  });

  it("normalizes every repeated Arabic header character", () => {
    expect(normalizeColumnHeader("آأإا  ةة  ىى")).toBe("اااا هه يي");
  });

  it("does not convert unsupported objects to object Object text", () => {
    expect(normalizeTextCell({ message: "secret" })).toBeUndefined();
    expect(buildImportErrorCsv([{
      rowNumber: 2,
      action: "REJECT" as never,
      validationStatus: "INVALID" as never,
      validationErrors: [{ field: {}, code: {}, message: {} }],
      validationWarnings: [{}],
    }])).not.toContain(["[object", "Object]"].join(" "));
  });

  it.each([
    ["plain", "plain"],
    [new Error("failed"), "failed"],
    [{ message: "from object" }, "from object"],
    [{ other: "ignored" }, ""],
    [null, ""],
    [undefined, ""],
    [3, "3"],
    [true, "true"],
  ])("safely converts report message %s", (input, expected) => {
    expect(toSafeMessage(input)).toBe(expected);
  });

  it("accepts explicit dates and rejects ambiguous local formats", () => {
    expect(normalizeDateCell("2026-07-01")?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(normalizeDateCell("2026-07-01T12:30:00Z")?.toISOString()).toBe("2026-07-01T12:30:00.000Z");
    expect(normalizeDateCell("03/04/2024")).toBeUndefined();
    expect(normalizeDateCell("04-03-2024")).toBeUndefined();
  });

  it("rejects inherited enum-like properties", () => {
    const mapping = matchComplaintColumns(["رقم الشكوى", "تاريخ الشكوى", "الموضوع", "الحالة", "الأولوية"]);
    const result = normalizeImportRow({
      rowNumber: 2,
      values: {
        "رقم الشكوى": "C-1",
        "تاريخ الشكوى": "2026-07-01",
        "الموضوع": "اختبار",
        "الحالة": "constructor",
        "الأولوية": "__proto__",
      },
    }, mapping);

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INVALID_STATUS" }),
      expect.objectContaining({ code: "INVALID_PRIORITY" }),
    ]));
  });

  it("fails closed when zip entry size metadata is unavailable", () => {
    expect(() => getRequiredUncompressedSize({ name: "xl/workbook.xml" } as never)).toThrow(/تعذر التحقق/);
  });

  it("ignores a huge non-selected sheet when a preferred sheet is present", async () => {
    const hugeRows = [["تعليمات"], ...Array.from({ length: 10_050 }, () => ["نص"])];
    const buffer = await workbookBuffer({
      sheets: [
        {
          name: "الشكاوى",
          rows: [["رقم الشكوى", "تاريخ الشكوى", "الموضوع"], ["C-1", "2026-07-01", "اختبار"]],
        },
        { name: "تعليمات", rows: hugeRows },
      ],
    });

    await expect(parseXlsxWorkbook(buffer)).resolves.toMatchObject({ selectedSheet: "الشكاوى" });
  }, 15_000);

  it("rejects the selected sheet when it exceeds the row limit", async () => {
    const rows = [["رقم الشكوى"], ...Array.from({ length: 10_050 }, (_, index) => [`C-${index}`])];

    await expect(parseXlsxWorkbook(await workbookBuffer({
      sheets: [{ name: "الشكاوى", rows }],
    }))).rejects.toMatchObject({ code: "IMPORT_TOO_MANY_ROWS" });
  }, 15_000);

  it("parses a generated 5000-row workbook within the configured row limit", async () => {
    const rows = [
      ["رقم الشكوى", "تاريخ الشكوى", "الموضوع"],
      ...Array.from({ length: 5_000 }, (_, index) => [
        `C-${index + 1}`,
        "2026-07-01",
        `شكوى صناعية ${index + 1}`,
      ]),
    ];
    const startedAt = performance.now();
    const parsed = await parseXlsxWorkbook(await workbookBuffer({
      sheets: [{ name: "الشكاوى", rows }],
    }));
    const durationMs = performance.now() - startedAt;

    expect(parsed.rows).toHaveLength(5_000);
    expect(durationMs).toBeLessThan(5_000);
  }, 10_000);

  it("keeps missing date fields out of meaningful-change comparison", () => {
    const complaint = {
      id: "cmp_1",
      externalId: "C-1",
      sourceReference: null,
      complaintDate: new Date("2026-07-01T00:00:00Z"),
      receivedAt: new Date("2026-07-01T00:00:00Z"),
      dueDate: new Date("2026-07-10T00:00:00Z"),
      closedAt: null,
      subject: "اختبار",
      description: null,
      status: ComplaintStatus.NEW,
      priority: ComplaintPriority.MEDIUM,
      region: null,
      facility: null,
      department: null,
      channel: null,
      resolution: null,
    } as never;

    expect(hasMeaningfulChange({ externalId: "C-1", subject: "اختبار" }, complaint)).toBe(false);
    expect(hasMeaningfulChange({ dueDate: new Date("2026-07-11T00:00:00Z") }, complaint)).toBe(true);
    expect(hasMeaningfulChange({ dueDate: new Date("2026-07-10T00:00:00Z") }, complaint)).toBe(false);
  });

  it("builds complaint identity keys for all supported strategies", () => {
    const complaint = {
      externalId: "C-1",
      sourceReference: "SRC-1",
      complaintDate: new Date("2026-07-01T00:00:00Z"),
      region: "الرياض",
      facility: "المركز",
      department: "الدعم",
      subject: "اختبار",
    };

    const complaintKeys = complaintCandidateIdentityKeys(complaint);
    const rowKeys = normalizedCandidateIdentityKeys({
      externalId: "C-1",
      sourceReference: "SRC-1",
      complaintDate: new Date("2026-07-01T00:00:00Z"),
      region: "الرياض",
      facility: "المركز",
      department: "الدعم",
      subject: "اختبار",
    });

    expect(complaintKeys).toEqual(expect.arrayContaining([
      "externalId:c-1",
      "sourceReferenceDate:src-1|2026-07-01",
    ]));
    expect(rowKeys.some((key) => key.startsWith("fingerprint:"))).toBe(true);
  });

  it("blocks duplicate uploads for active import states only", () => {
    expect(DUPLICATE_BLOCKING_IMPORT_STATUSES).toEqual([
      ImportBatchStatus.UPLOADED,
      ImportBatchStatus.PARSING,
      ImportBatchStatus.VALIDATED,
      ImportBatchStatus.READY_FOR_CONFIRMATION,
      ImportBatchStatus.CONFIRMING,
      ImportBatchStatus.CONFIRMED,
    ]);
    expect(DUPLICATE_BLOCKING_IMPORT_STATUSES).not.toContain(ImportBatchStatus.FAILED);
    expect(DUPLICATE_BLOCKING_IMPORT_STATUSES).not.toContain(ImportBatchStatus.ROLLED_BACK);
  });

  it("persists 10000 preview rows in bounded chunks", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 500 });
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const rows: ProcessedImportRow[] = Array.from({ length: 10_000 }, (_, index) => ({
      rowNumber: index + 1,
      rawData: { externalId: `C-${index + 1}` },
      normalizedData: { externalId: `C-${index + 1}` },
      externalId: `C-${index + 1}`,
      action: ImportRowAction.NEW,
      validationStatus: ImportRowValidationStatus.VALID,
      validationErrors: null,
      validationWarnings: null,
      matchedComplaintId: null,
    }));

    await persistPreviewRows("batch_1", rows, {
      importBatchRow: { createMany, deleteMany },
    } as never);

    expect(deleteMany).toHaveBeenCalledWith({ where: { importBatchId: "batch_1" } });
    expect(createMany).toHaveBeenCalledTimes(20);
    expect(createMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.arrayContaining([expect.objectContaining({ rowNumber: 1 })]),
    }));
    expect(createMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.arrayContaining([expect.objectContaining({ rowNumber: 10_000 })]),
    }));
    expect(createMany.mock.calls.every(([input]) => input.data.length <= 500)).toBe(true);
  });

  it("validates required fields, lifecycle, taxonomy, and lengths independently", () => {
    const taxonomy = {
      categories: [{
        id: "cat_1",
        nameAr: "فئة",
        nameEn: null,
        description: null,
        displayOrder: 0,
        isActive: true,
        isDeleted: false,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
      classifications: [{
        id: "cls_1",
        categoryId: "cat_1",
        nameAr: "تصنيف",
        nameEn: null,
        description: null,
        color: "#000",
        keywords: null,
        displayOrder: 0,
        isActive: true,
        isDeleted: false,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        category: {
          id: "cat_1",
          nameAr: "فئة",
          nameEn: null,
          description: null,
          displayOrder: 0,
          isActive: true,
          isDeleted: false,
          deletedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }],
    };

    const messages = validateNormalizedComplaintRow({
      status: ComplaintStatus.OPEN,
      closedAt: new Date("2026-07-01T00:00:00Z"),
      subject: "س".repeat(301),
      category: "غير موجودة",
      classification: "غير موجود",
    }, taxonomy, new Date("2026-07-01T00:00:00Z"));

    expect(messages.map((message) => message.code)).toEqual(expect.arrayContaining([
      "MISSING_IDENTITY",
      "MISSING_COMPLAINT_DATE",
      "CLOSED_AT_FOR_OPEN_STATUS",
      "SUBJECT_TOO_LONG",
      "CATEGORY_NOT_FOUND",
      "CLASSIFICATION_NOT_FOUND",
    ]));
  });
});
