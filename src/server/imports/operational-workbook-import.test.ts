import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { ComplaintStatus } from "@prisma/client";
import {
  matchComplaintColumns,
  normalizeColumnHeader,
} from "./complaint-column-schema";
import { parseExcelSerialDate } from "./excel-date-parser";
import { normalizeDateCell, normalizeImportRow } from "./normalization";
import { maskIdentifier } from "./privacy";
import { deriveSubject } from "./subject-derive";
import { parseXlsxWorkbook } from "./xlsx-parser";
import { getImportLimits } from "./file-storage";
import { buildComplaintFingerprint } from "@/server/complaints/identity-service";
import { sanitizeComplaint } from "@/server/ai/ai-data-sanitization-service";
import { buildImportErrorCsv } from "./error-report";
import { ImportRowAction, ImportRowValidationStatus } from "@prisma/client";

const OPERATIONAL_HEADERS = [
  "رقم الشكوى",
  "هوية السجين",
  "عدد الشكاوي",
  "المصدر",
  "السجن",
  "المنطقة",
  "تفصيل",
  "القسم",
  "تاريخ التسجيل",
  "حالة الاجراء",
  "أغلقت بواسطة",
  "الحالة",
  "آخر تحديث في",
  "آخر تحديث بواسطة",
  "الإجراء المتخذ",
  "الإجراء المقترح",
  "الوصف",
  "تصنيف",
  "وصف الإجراء",
  "المُعرف",
  "تاريخ الإنشاء",
] as const;

type CellSpec = string | number | { n: number } | { s: string };

async function operationalWorkbookBuffer(options: {
  rows?: CellSpec[][];
  trailingEmptyRows?: number;
}): Promise<Buffer> {
  const zip = new JSZip();
  const dataRows = options.rows ?? [
    [
      "COMP/TEST-001",
      "1000000000",
      1,
      "مصدر تجريبي",
      "منشأة تجريبية",
      "منطقة تجريبية",
      "تفصيل تجريبي",
      "إدارة تجريبية",
      { n: 46126 },
      "حالة إجراء تجريبية",
      "",
      "حالة مصدرية تجريبية",
      { n: 46126.5 },
      "مستخدم تجريبي",
      "إجراء متخذ تجريبي",
      "إجراء مقترح تجريبي",
      "وصف صناعي لا يحتوي بيانات تشغيلية",
      "تصنيف تجريبي",
      "وصف إجراء بديل",
      "TEST-REF-001",
      { n: 46126.47107638889 },
    ],
  ];

  const sheetRows: Array<{ r: number; cells: string }> = [];
  sheetRows.push({
    r: 1,
    cells: OPERATIONAL_HEADERS.map((header, columnIndex) => {
      const column = String.fromCharCode(65 + (columnIndex % 26));
      const prefix = columnIndex >= 26 ? String.fromCharCode(64 + Math.floor(columnIndex / 26)) : "";
      return `<c r="${prefix}${column}1" t="inlineStr"><is><t>${header}</t></is></c>`;
    }).join(""),
  });

  for (const [rowOffset, row] of dataRows.entries()) {
    const rowNumber = rowOffset + 2;
    sheetRows.push({
      r: rowNumber,
      cells: row.map((value, columnIndex) => {
        const column = String.fromCharCode(65 + (columnIndex % 26));
        const prefix = columnIndex >= 26 ? String.fromCharCode(64 + Math.floor(columnIndex / 26)) : "";
        const ref = `${prefix}${column}${rowNumber}`;
        if (typeof value === "object" && value !== null && "n" in value) {
          return `<c r="${ref}"><v>${value.n}</v></c>`;
        }
        const text = typeof value === "object" && value !== null && "s" in value
          ? value.s
          : String(value);
        return `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
      }).join(""),
    });
  }

  for (let index = 0; index < (options.trailingEmptyRows ?? 0); index += 1) {
    const rowNumber = dataRows.length + 2 + index;
    sheetRows.push({ r: rowNumber, cells: "" });
  }

  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="الشكاوى" sheetId="1" r:id="rId1"/></sheets>
</workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`);
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?>
<worksheet><sheetData>
${sheetRows.map((row) => `<row r="${row.r}">${row.cells}</row>`).join("\n")}
</sheetData></worksheet>`);

  return zip.generateAsync({ type: "nodebuffer" });
}

describe("operational workbook column synonyms", () => {
  it("maps operational Arabic headers to system fields", () => {
    const { mapping, conflicts } = matchComplaintColumns([...OPERATIONAL_HEADERS]);

    expect(mapping["رقم الشكوى"]).toBe("externalId");
    expect(mapping["هوية السجين"]).toBe("complainantIdentifier");
    expect(mapping["تاريخ التسجيل"]).toBe("receivedAt");
    expect(mapping["تاريخ الإنشاء"]).toBe("complaintDate");
    expect(mapping["الوصف"]).toBe("description");
    expect(mapping["السجن"]).toBe("facility");
    expect(mapping["المنطقة"]).toBe("region");
    expect(mapping["القسم"]).toBe("department");
    expect(mapping["تصنيف"]).toBe("classification");
    expect(mapping["الحالة"]).toBe("status");
    expect(mapping["المصدر"]).toBe("channel");
    expect(mapping["الإجراء المتخذ"]).toBe("resolution");
    expect(mapping["المُعرف"]).toBe("sourceReference");
    expect(mapping["وصف الإجراء"]).toBeUndefined();
    expect(conflicts.some((item) => item.header === "وصف الإجراء")).toBe(true);
    expect(mapping).not.toHaveProperty("عدد الشكاوي");
    expect(mapping).not.toHaveProperty("تفصيل");
  });

  it("equates hamza and tatweel variants", () => {
    expect(normalizeColumnHeader("الإجراء")).toBe(normalizeColumnHeader("الاجراء"));
    expect(normalizeColumnHeader("المُعرف")).toBe(normalizeColumnHeader("المعرف"));
    expect(normalizeColumnHeader("الإنشاء")).toBe(normalizeColumnHeader("الانشاء"));
    expect(normalizeColumnHeader("الإدارة")).toBe(normalizeColumnHeader("الادارة"));
    expect(normalizeColumnHeader("المــعرف")).toBe(normalizeColumnHeader("المعرف"));
  });

  it("does not let المصدر المرجعي override رقم الشكوى", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "المُعرف", "الوصف", "تاريخ التسجيل"]);
    expect(mapping["رقم الشكوى"]).toBe("externalId");
    expect(mapping["المُعرف"]).toBe("sourceReference");
  });
});

describe("excel serial date parser", () => {
  it("parses whole and fractional Excel serials", () => {
    expect(parseExcelSerialDate(46126)?.toISOString()).toBe("2026-04-14T00:00:00.000Z");
    const withTime = parseExcelSerialDate(46126.47108796296);
    expect(withTime).toBeInstanceOf(Date);
    expect(Math.abs((withTime?.getTime() ?? 0) - Date.parse("2026-04-14T11:18:22.000Z"))).toBeLessThan(1000);
  });

  it("rejects invalid serial values", () => {
    expect(parseExcelSerialDate(0)).toBeNull();
    expect(parseExcelSerialDate(-1)).toBeNull();
    expect(parseExcelSerialDate(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseExcelSerialDate(Number.NaN)).toBeNull();
    expect(parseExcelSerialDate(3_000_000)).toBeNull();
  });

  it("accepts Date, ISO, calendar, and numeric strings in normalizeDateCell", () => {
    expect(normalizeDateCell(new Date("2026-04-14T00:00:00.000Z"))?.toISOString()).toBe(
      "2026-04-14T00:00:00.000Z"
    );
    expect(normalizeDateCell("2026-04-14T11:18:22.000Z")?.toISOString()).toBe(
      "2026-04-14T11:18:22.000Z"
    );
    expect(normalizeDateCell("2026-04-14")?.toISOString()).toBe("2026-04-14T00:00:00.000Z");
    expect(normalizeDateCell("46126")?.toISOString()).toBe("2026-04-14T00:00:00.000Z");
    expect(normalizeDateCell("not-a-date")).toBeUndefined();
  });
});

describe("subject derivation and description-only rows", () => {
  it("derives subject deterministically without AI", () => {
    expect(deriveSubject("  نص   قصير  ")).toBe("نص قصير");
    expect(deriveSubject("أ".repeat(120))).toHaveLength(120);
    expect(deriveSubject("أ".repeat(121))).toBe(`${"أ".repeat(117)}...`);
  });

  it("accepts description without subject and preserves existing subject", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل", "الوصف"]);
    const derived = normalizeImportRow({
      rowNumber: 2,
      values: {
        "رقم الشكوى": "COMP/TEST-001",
        "تاريخ التسجيل": 46126,
        "الوصف": "وصف صناعي لا يحتوي بيانات تشغيلية",
      },
    }, mapping);

    expect(derived.errors).toHaveLength(0);
    expect(derived.normalized.description).toBe("وصف صناعي لا يحتوي بيانات تشغيلية");
    expect(derived.normalized.subject).toBe("وصف صناعي لا يحتوي بيانات تشغيلية");

    const withSubjectMapping = {
      ...mapping,
      "الموضوع": "subject" as const,
    };
    const preserved = normalizeImportRow({
      rowNumber: 2,
      values: {
        "رقم الشكوى": "COMP/TEST-001",
        "تاريخ التسجيل": 46126,
        "الموضوع": "موضوع موجود",
        "الوصف": "وصف أطول يجب ألا يستبدل الموضوع",
      },
    }, withSubjectMapping);

    expect(preserved.normalized.subject).toBe("موضوع موجود");
  });

  it("rejects rows missing both subject and description", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل"]);
    const result = normalizeImportRow({
      rowNumber: 27,
      values: {
        "رقم الشكوى": "COMP/TEST-001",
        "تاريخ التسجيل": 46126,
      },
    }, mapping);

    expect(result.normalized.subject).toBeUndefined();
    expect(result.normalized.description).toBeUndefined();
  });
});

describe("privacy helpers", () => {
  it("masks identifiers for preview and reports", () => {
    expect(maskIdentifier("1082536010")).toBe("******6010");
    expect(maskIdentifier("1000000000")).toBe("******0000");
    expect(maskIdentifier("12")).toBe("****");
  });

  it("keeps complainant identifiers out of AI payloads and fingerprints", () => {
    const sanitized = sanitizeComplaint({
      id: "c1",
      subject: "موضوع",
      description: "وصف",
      complainantIdentifier: "1000000000",
      complainantName: "اسم",
    } as never);

    expect(sanitized).not.toHaveProperty("complainantIdentifier");
    expect(sanitized).not.toHaveProperty("complainantName");

    const fingerprint = buildComplaintFingerprint({
      complaintDate: new Date("2026-04-14T00:00:00.000Z"),
      sourceReference: "TEST-REF-001",
      region: "منطقة تجريبية",
      facility: "منشأة تجريبية",
      department: "إدارة تجريبية",
      subject: "وصف صناعي",
    });
    expect(fingerprint).not.toContain("1000000000");
  });

  it("does not embed identifiers in error CSV messages", () => {
    const csv = buildImportErrorCsv([
      {
        rowNumber: 12,
        action: ImportRowAction.REJECT,
        validationStatus: ImportRowValidationStatus.INVALID,
        validationErrors: [
          {
            field: "externalId",
            code: "MISSING_IDENTITY",
            message: "رقم الشكوى أو الرقم المرجعي غير موجود.",
          },
        ],
        validationWarnings: null,
      },
    ]);

    expect(csv).not.toContain("1000000000");
    expect(csv).toContain("رقم الشكوى أو الرقم المرجعي غير موجود.");
  });
});

describe("operational workbook parsing and normalization", () => {
  it("parses operational headers and Excel serial dates through the production parser", async () => {
    const parsed = await parseXlsxWorkbook(await operationalWorkbookBuffer({}));
    expect(parsed.headers).toEqual([...OPERATIONAL_HEADERS]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].values["تاريخ التسجيل"]).toBe(46126);
    expect(parsed.rows[0].values["تاريخ الإنشاء"]).toBeCloseTo(46126.47107638889, 5);

    const { mapping } = matchComplaintColumns(parsed.headers);
    const normalized = normalizeImportRow(parsed.rows[0], mapping);

    expect(normalized.errors).toHaveLength(0);
    expect(normalized.normalized).toMatchObject({
      externalId: "COMP/TEST-001",
      complainantIdentifier: "1000000000",
      channel: "مصدر تجريبي",
      facility: "منشأة تجريبية",
      region: "منطقة تجريبية",
      department: "إدارة تجريبية",
      description: "وصف صناعي لا يحتوي بيانات تشغيلية",
      sourceReference: "TEST-REF-001",
      resolution: "إجراء متخذ تجريبي",
      status: ComplaintStatus.NEW,
    });
    expect(normalized.normalized.receivedAt?.toISOString()).toBe("2026-04-14T00:00:00.000Z");
    expect(normalized.normalized.complaintDate).toBeInstanceOf(Date);
    expect(normalized.warnings.some((item) => item.code === "UNKNOWN_SOURCE_STATUS")).toBe(true);
    expect(maskIdentifier(normalized.normalized.complainantIdentifier!)).toBe("******0000");
  });

  it("counts only non-empty data rows toward IMPORT_MAX_ROWS", async () => {
    const limits = getImportLimits();
    const emptyPadding = Array.from({ length: limits.maxRows + 50 }, () => "");
    const buffer = await operationalWorkbookBuffer({
      rows: [
        [
          "COMP/TEST-001",
          "1000000000",
          1,
          "مصدر تجريبي",
          "منشأة تجريبية",
          "منطقة تجريبية",
          "",
          "إدارة تجريبية",
          { n: 46126 },
          "",
          "",
          "جديدة",
          "",
          "",
          "إجراء",
          "",
          "وصف صناعي",
          "",
          "",
          "TEST-REF-001",
          { n: 46126 },
        ],
      ],
      trailingEmptyRows: emptyPadding.length,
    });

    await expect(parseXlsxWorkbook(buffer)).resolves.toMatchObject({
      rows: expect.any(Array),
    });
  });

  it("rejects when real data rows exceed IMPORT_MAX_ROWS", async () => {
    const limits = getImportLimits();
    const rows = Array.from({ length: limits.maxRows + 1 }, (_, index) => [
      `COMP/TEST-${index}`,
      "1000000000",
      1,
      "مصدر تجريبي",
      "منشأة تجريبية",
      "منطقة تجريبية",
      "",
      "إدارة تجريبية",
      { n: 46126 },
      "",
      "",
      "جديدة",
      "",
      "",
      "",
      "",
      "وصف صناعي",
      "",
      "",
      `TEST-REF-${index}`,
      { n: 46126 },
    ]);

    await expect(parseXlsxWorkbook(await operationalWorkbookBuffer({ rows }))).rejects.toMatchObject({
      code: "IMPORT_TOO_MANY_ROWS",
    });
  }, 60_000);
});
