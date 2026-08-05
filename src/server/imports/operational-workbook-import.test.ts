import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { ComplaintStatus } from "@prisma/client";
import {
  analyzeColumnMapping,
  matchComplaintColumns,
  normalizeColumnHeader,
} from "./complaint-column-schema";
import { parseExcelSerialDate } from "./excel-date-parser";
import { getImportedStatusDisplay, normalizeDateCell, normalizeImportRow } from "./normalization";
import { maskIdentifier } from "./privacy";
import { deriveSubject } from "./subject-derive";
import { parseXlsxWorkbook } from "./xlsx-parser";
import { getImportLimits } from "./file-storage";
import { buildComplaintFingerprint } from "@/server/complaints/identity-service";
import { sanitizeComplaint } from "@/server/ai/ai-data-sanitization-service";
import { buildImportErrorCsv } from "./error-report";
import { ImportRowAction, ImportRowValidationStatus } from "@prisma/client";
import { validateNormalizedComplaintRow } from "./row-validation";

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
    expect(mapping["تفصيل"]).toBe("sourceDetail");
    expect(mapping["آخر تحديث في"]).toBe("sourceUpdatedAt");
    expect(mapping["حالة الاجراء"]).toBe("sourceActionStatus");
    expect(mapping["المصدر"]).toBe("sourceOrigin");
    expect(mapping["الإجراء المتخذ"]).toBe("actionTaken");
    expect(mapping["وصف الإجراء"]).toBe("actionDescription");
    expect(mapping["المُعرف"]).toBe("sourceReference");
    expect(mapping["عدد الشكاوي"]).toBeUndefined();
    expect(mapping["أغلقت بواسطة"]).toBe("sourceClosedBy");
    expect(mapping["آخر تحديث بواسطة"]).toBe("sourceUpdatedBy");
    expect(conflicts).toHaveLength(0);
  });

  it("treats عدد الشكاوي and عدد الشكاوى as INTENTIONALLY_IGNORED — never mapped, never in unmappedColumns", () => {
    const headers = ["رقم الشكوى", "تاريخ التسجيل", "الوصف", "عدد الشكاوي", "عدد الشكاوى"];
    const { mapping, conflicts } = matchComplaintColumns(headers);
    const analysis = analyzeColumnMapping(headers, mapping, { conflicts });

    expect(mapping["عدد الشكاوي"]).toBeUndefined();
    expect(mapping["عدد الشكاوى"]).toBeUndefined();
    expect(conflicts).toHaveLength(0);
    expect(analysis.unmappedColumns).not.toContain("عدد الشكاوي");
    expect(analysis.unmappedColumns).not.toContain("عدد الشكاوى");
    expect(analysis.entries.some((e) => e.header === "عدد الشكاوي" && e.status === "INTENTIONALLY_IGNORED")).toBe(true);
    expect(analysis.entries.some((e) => e.header === "عدد الشكاوى" && e.status === "INTENTIONALLY_IGNORED")).toBe(true);
  });

  it("treats complaint count English alias as INTENTIONALLY_IGNORED", () => {
    const headers = ["رقم الشكوى", "تاريخ التسجيل", "الوصف", "complaint count"];
    const { mapping } = matchComplaintColumns(headers);
    const analysis = analyzeColumnMapping(headers, mapping);
    expect(mapping["complaint count"]).toBeUndefined();
    expect(analysis.unmappedColumns).not.toContain("complaint count");
    expect(analysis.entries.some((e) => e.header === "complaint count" && e.status === "INTENTIONALLY_IGNORED")).toBe(true);
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
    // Subject is no longer derived from description at normalization time;
    // it is set at confirmation via deriveSubject(description).
    expect(derived.normalized.subject).toBeUndefined();

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

  it("leaves subject and description undefined when neither column is mapped", () => {
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

    const validation = validateNormalizedComplaintRow(
      result.normalized,
      { categories: [], classifications: [] },
      new Date("2026-04-14T00:00:00Z")
    );

    // No error for missing description/subject — description column is simply absent
    expect(validation.errors.some((item) => item.code === "MISSING_TEXT")).toBe(false);
    // No row-level warning when description column is not in mapping (batch-level instead)
    expect(result.warnings.some((w) => w.code === "DESCRIPTION_VALUE_MISSING")).toBe(false);
  });

  it("produces a row warning when description column is mapped but cell is blank", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل", "الوصف"]);
    const result = normalizeImportRow({
      rowNumber: 5,
      values: { "رقم الشكوى": "COMP/TEST-002", "تاريخ التسجيل": 46126, "الوصف": "" },
    }, mapping);

    expect(result.warnings.some((w) => w.code === "DESCRIPTION_VALUE_MISSING")).toBe(true);
  });
});

describe("privacy helpers", () => {
  it("masks identifiers with a fixed-length prefix and never reveals original length", () => {
    expect(maskIdentifier("1082536010")).toBe("****6010");
    expect(maskIdentifier("1000000000")).toBe("****0000");
    expect(maskIdentifier("1234")).toBe("****");
    expect(maskIdentifier("12")).toBe("****");
    expect(maskIdentifier("")).toBe("****");
    expect(maskIdentifier("   ")).toBe("****");
    expect(maskIdentifier("1000000000")).toHaveLength(8);
    expect(maskIdentifier("999999999999")).toHaveLength(8);
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
  it("keeps the operational detail fixture through mapping, normalization, and validation", () => {
    const rawRow = {
      rowNumber: 2,
      values: {
        "رقم الشكوى": "1001",
        "تفصيل": "طلب نقل",
        "الحالة": "الإرسال إلى السجن",
        "حالة الاجراء": "جديد",
      },
    };
    const { mapping } = matchComplaintColumns(Object.keys(rawRow.values));
    const normalized = normalizeImportRow(rawRow, mapping);
    const validation = validateNormalizedComplaintRow(normalized.normalized, {
      categories: [],
      classifications: [],
    });

    expect(mapping["تفصيل"]).toBe("sourceDetail");
    expect(rawRow.values["تفصيل"]).toBe("طلب نقل");
    expect(normalized.normalized).toMatchObject({
      externalId: "1001",
      sourceDetail: "طلب نقل",
      sourceStatus: "الإرسال إلى السجن",
      sourceActionStatus: "جديد",
      status: ComplaintStatus.IN_PROGRESS,
    });
    expect(validation.errors.some((message) => message.field === "sourceDetail")).toBe(false);
    expect(normalized.normalized.sourceDetail).toBe("طلب نقل");
  });

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
      sourceOrigin: "مصدر تجريبي",
      facility: "منشأة تجريبية",
      region: "منطقة تجريبية",
      department: "إدارة تجريبية",
      description: "وصف صناعي لا يحتوي بيانات تشغيلية",
      sourceReference: "TEST-REF-001",
      actionTaken: "إجراء متخذ تجريبي",
      actionDescription: "وصف إجراء بديل",
      sourceUpdatedBy: "مستخدم تجريبي",
      sourceDetail: "تفصيل تجريبي",
      sourceStatus: "حالة مصدرية تجريبية",
      sourceActionStatus: "حالة إجراء تجريبية",
      status: ComplaintStatus.NEW,
    });
    expect(normalized.normalized.receivedAt?.toISOString()).toBe("2026-04-14T00:00:00.000Z");
    expect(normalized.normalized.complaintDate).toBeInstanceOf(Date);
    expect(normalized.warnings.some((item) => item.code === "UNKNOWN_SOURCE_STATUS")).toBe(true);
    expect(maskIdentifier(normalized.normalized.complainantIdentifier!)).toBe("****0000");
  });

  it.each([
    ["الإرسال إلى السجن", ComplaintStatus.IN_PROGRESS],
    ["الإرسال إلى المديرية", ComplaintStatus.AWAITING_RESPONSE],
    ["مغلقة", ComplaintStatus.CLOSED],
    ["مغلق", ComplaintStatus.CLOSED],
    ["تم الإغلاق", ComplaintStatus.CLOSED],
    ["إغلاق الشكوى", ComplaintStatus.CLOSED],
    ["منتهية", ComplaintStatus.CLOSED],
    ["تمت المعالجة", ComplaintStatus.CLOSED],
  ])("maps source complaint status %s without consulting action status", (sourceStatus, expected) => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل", "الوصف", "تفصيل", "حالة الاجراء", "الحالة"]);
    const result = normalizeImportRow({
      rowNumber: 2,
      values: {
        "رقم الشكوى": "COMP/STATUS-001",
        "تاريخ التسجيل": "2026-07-01",
        "الوصف": "وصف اختباري",
        "تفصيل": "  وكالة   ",
        "حالة الاجراء": "مغلقة",
        "الحالة": sourceStatus,
      },
    }, mapping);

    expect(result.normalized).toMatchObject({
      sourceDetail: "وكالة",
      sourceActionStatus: "مغلقة",
      sourceStatus,
      status: expected,
    });
  });

  it("uses the requested Arabic displays for routed statuses", () => {
    expect(getImportedStatusDisplay(ComplaintStatus.IN_PROGRESS)).toBe("تحت الإجراء");
    expect(getImportedStatusDisplay(ComplaintStatus.AWAITING_RESPONSE)).toBe("تحت المراجعة");
  });

  it("uses NEW with a warning for an unknown source status and preserves the original", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل", "الوصف", "الحالة"]);
    const result = normalizeImportRow({
      rowNumber: 2,
      values: {
        "رقم الشكوى": "COMP/STATUS-002",
        "تاريخ التسجيل": "2026-07-01",
        "الوصف": "وصف اختباري",
        "الحالة": "حالة تشغيلية غير معروفة",
      },
    }, mapping);

    expect(result.normalized.status).toBe(ComplaintStatus.NEW);
    expect(result.normalized.sourceStatus).toBe("حالة تشغيلية غير معروفة");
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNKNOWN_SOURCE_STATUS" }),
    ]));
  });

  it("does not use action status when the complaint status column is empty", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل", "الوصف", "حالة الاجراء", "الحالة"]);
    const result = normalizeImportRow({
      rowNumber: 2,
      values: {
        "رقم الشكوى": "COMP/STATUS-003",
        "تاريخ التسجيل": "2026-07-01",
        "الوصف": "وصف اختباري",
        "حالة الاجراء": "تم الإغلاق",
        "الحالة": "",
      },
    }, mapping);

    expect(result.normalized.sourceActionStatus).toBe("تم الإغلاق");
    expect(result.normalized.status).toBe(ComplaintStatus.NEW);
    expect(result.normalized).not.toHaveProperty("sourceStatus");
  });

  it("derives subject from sourceDetail when subject column is absent", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل", "تفصيل"]);
    const result = normalizeImportRow({
      rowNumber: 2,
      values: { "رقم الشكوى": "COMP/SD-001", "تاريخ التسجيل": 46126, "تفصيل": "  طلب نقل  " },
    }, mapping);

    expect(result.normalized.subject).toBe("طلب نقل");
    expect(result.normalized.sourceDetail).toBe("طلب نقل");
    expect(result.derived.some((d) => d.code === "SUBJECT_DERIVED_FROM_SOURCE_DETAIL")).toBe(true);
  });

  it("maps آخر تحديث في to sourceUpdatedAt and derives closedAt for closed rows", () => {
    const { mapping } = matchComplaintColumns([
      "رقم الشكوى", "تاريخ التسجيل", "الوصف", "الحالة", "آخر تحديث في",
    ]);
    expect(mapping["آخر تحديث في"]).toBe("sourceUpdatedAt");

    const result = normalizeImportRow({
      rowNumber: 2,
      values: {
        "رقم الشكوى": "COMP/CLOSED-002",
        "تاريخ التسجيل": "2026-07-01",
        "الوصف": "وصف مغلق",
        "الحالة": "مغلقة",
        "آخر تحديث في": "2026-08-01",
      },
    }, mapping);

    expect(result.normalized.sourceUpdatedAt?.toISOString().startsWith("2026-08-01")).toBe(true);
    expect(result.normalized.closedAt?.toISOString().startsWith("2026-08-01")).toBe(true);
    expect(result.derived.some((d) => d.code === "CLOSED_AT_DERIVED_FROM_LAST_UPDATED_AT")).toBe(true);
    expect(result.warnings.some((w) => w.code === "CLOSED_STATUS_WITHOUT_SOURCE_UPDATED_AT")).toBe(false);
  });

  it("warns for CLOSED without inventing closedAt", () => {
    const normalized = {
      externalId: "COMP/CLOSED-001",
      receivedAt: new Date("2026-07-01T00:00:00.000Z"),
      subject: "شكوى مغلقة",
      status: ComplaintStatus.CLOSED,
    };
    const validation = validateNormalizedComplaintRow(normalized, {
      categories: [],
      classifications: [],
    });

    expect(normalized).not.toHaveProperty("closedAt");
    expect(validation.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TERMINAL_STATUS_WITHOUT_CLOSED_AT" }),
    ]));
  });

  it("VALID row with only derived messages is not a quality issue row", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل", "الموضوع"]);
    const result = normalizeImportRow(
      {
        rowNumber: 2,
        values: {
          "رقم الشكوى": "COMP/001",
          "تاريخ التسجيل": "2026-07-01",
          "الموضوع": "موضوع اختبار",
        },
      },
      mapping
    );
    // Only derived messages should be present (no real warnings)
    expect(result.errors).toHaveLength(0);
    const realWarnings = result.warnings.filter((w) => w.level !== "derived");
    expect(realWarnings).toHaveLength(0);
    // validationStatus should be VALID
    const status =
      result.errors.length > 0
        ? ImportRowValidationStatus.INVALID
        : realWarnings.length > 0
          ? ImportRowValidationStatus.WARNING
          : ImportRowValidationStatus.VALID;
    expect(status).toBe(ImportRowValidationStatus.VALID);
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

describe("new operational fields normalization", () => {
  function makeRow(overrides: Record<string, unknown> = {}) {
    return {
      rowNumber: 2,
      values: {
        "رقم الشكوى": "COMP/OP-001",
        "تاريخ التسجيل": "2026-07-01",
        "الوصف": "وصف",
        ...overrides,
      },
    };
  }

  it("normalizes actionTaken from الإجراء المتخذ", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل", "الوصف", "الإجراء المتخذ"]);
    const result = normalizeImportRow(makeRow({ "الإجراء المتخذ": "تم الرد على المستفيد" }), mapping);
    expect(result.normalized.actionTaken).toBe("تم الرد على المستفيد");
    expect(result.normalized.resolution).toBeUndefined();
  });

  it("normalizes actionDescription from وصف الإجراء", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل", "الوصف", "وصف الإجراء"]);
    const result = normalizeImportRow(makeRow({ "وصف الإجراء": "تفاصيل الإجراء المتخذ" }), mapping);
    expect(result.normalized.actionDescription).toBe("تفاصيل الإجراء المتخذ");
    expect(result.normalized.resolution).toBeUndefined();
  });

  it("resolution field remains independent from actionTaken and actionDescription", () => {
    const { mapping } = matchComplaintColumns([
      "رقم الشكوى", "تاريخ التسجيل", "الوصف",
      "الإجراء أو الحل", "الإجراء المتخذ", "وصف الإجراء",
    ]);
    const result = normalizeImportRow(
      makeRow({
        "الإجراء أو الحل": "الحل النهائي",
        "الإجراء المتخذ": "الإجراء الأول",
        "وصف الإجراء": "وصف الإجراء هنا",
      }),
      mapping
    );
    expect(result.normalized.resolution).toBe("الحل النهائي");
    expect(result.normalized.actionTaken).toBe("الإجراء الأول");
    expect(result.normalized.actionDescription).toBe("وصف الإجراء هنا");
  });

  it("normalizes sourceClosedBy from أغلقت بواسطة", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل", "الوصف", "أغلقت بواسطة"]);
    const result = normalizeImportRow(makeRow({ "أغلقت بواسطة": "محمد" }), mapping);
    expect(result.normalized.sourceClosedBy).toBe("محمد");
  });

  it("normalizes wingCode from رمز الجناح", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل", "الوصف", "رمز الجناح"]);
    const result = normalizeImportRow(makeRow({ "رمز الجناح": "A-12" }), mapping);
    expect(result.normalized.wingCode).toBe("A-12");
  });

  it("normalizes sourceModifiedAt from آخر تعديل في", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل", "الوصف", "آخر تعديل في"]);
    const result = normalizeImportRow(makeRow({ "آخر تعديل في": "2026-07-15" }), mapping);
    expect(result.normalized.sourceModifiedAt?.toISOString()).toBe("2026-07-15T00:00:00.000Z");
  });

  it("normalizes sourceUpdatedBy from آخر تحديث بواسطة", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل", "الوصف", "آخر تحديث بواسطة"]);
    const result = normalizeImportRow(makeRow({ "آخر تحديث بواسطة": "عمر" }), mapping);
    expect(result.normalized.sourceUpdatedBy).toBe("عمر");
  });

  it("normalizes sourceOrigin from المصدر", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل", "الوصف", "المصدر"]);
    expect(mapping["المصدر"]).toBe("sourceOrigin");
    const result = normalizeImportRow(makeRow({ "المصدر": "الجهاز الرئيسي" }), mapping);
    expect(result.normalized.sourceOrigin).toBe("الجهاز الرئيسي");
    expect(result.normalized.channel).toBeUndefined();
  });

  it("maps اسم السجين and اسم النزيل to complainantName", () => {
    const { mapping: m1 } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل", "الوصف", "اسم السجين"]);
    expect(m1["اسم السجين"]).toBe("complainantName");
    const { mapping: m2 } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل", "الوصف", "اسم النزيل"]);
    expect(m2["اسم النزيل"]).toBe("complainantName");
  });

  it("maps الإجراء المتخد (typo variant) to actionTaken", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ التسجيل", "الوصف", "الإجراء المتخد"]);
    expect(mapping["الإجراء المتخد"]).toBe("actionTaken");
  });

  it("عدد الشكاوي is INTENTIONALLY_IGNORED — not mapped and not in unmappedColumns", () => {
    const headers = ["رقم الشكوى", "تاريخ التسجيل", "الوصف", "عدد الشكاوي"];
    const { mapping } = matchComplaintColumns(headers);
    const analysis = analyzeColumnMapping(headers, mapping);
    expect(mapping["عدد الشكاوي"]).toBeUndefined();
    expect(analysis.unmappedColumns).not.toContain("عدد الشكاوي");
    expect(analysis.entries.find((e) => e.header === "عدد الشكاوي")?.status).toBe("INTENTIONALLY_IGNORED");
  });
});
