import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import {
  matchComplaintColumns,
  normalizeColumnHeader,
  parseColumnMapping,
  validateColumnMapping,
} from "./complaint-column-schema";
import { deleteStoredImportFileForBatch, getRequiredUncompressedSize, validateXlsxZip } from "./file-storage";
import { buildImportErrorCsv, toSafeMessage } from "./error-report";
import { normalizeDateCell, normalizeExcelSerialDate, normalizeImportRow, normalizeTextCell, isEmptyWingCodePlaceholder } from "./normalization";
import { parseXlsxWorkbook } from "./xlsx-parser";
import {
  DUPLICATE_BLOCKING_IMPORT_STATUSES,
  classifyNormalizedImportRows,
  complaintCandidateIdentityKeys,
  findExistingComplaintByIdentity,
  getImportRowOutcome,
  hasMeaningfulChange,
  loadImportBatchForResume,
  normalizedCandidateIdentityKeys,
  persistPreviewRows,
  resolveEffectiveColumnMapping,
  resolveIncomingIdentity,
  type ComplaintIndexEntry,
  type ProcessedImportRow,
} from "./excel-import-service";
import {
  buildQualityObservationsSummary,
  orderQualityObservationsForDisplay,
  resolvePreviewValue,
  QUALITY_OBSERVATION_DISPLAY_LIMIT,
} from "./import-preview-presentation";
import { buildComplaintFingerprint } from "@/server/complaints/identity-service";
import { db } from "@/lib/db";
import {
  ComplaintPriority,
  ComplaintStatus,
  ImportBatchStatus,
  ImportRowAction,
  ImportRowValidationStatus,
  type Complaint,
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
  it("rejects unsafe storage keys without exposing or deleting outside import storage", async () => {
    await expect(deleteStoredImportFileForBatch("../secret.xlsx")).rejects.toMatchObject({
      code: "IMPORT_STORAGE_PATH_INVALID",
      message: "مرجع ملف الاستيراد غير آمن",
    });
  });

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
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ الشكوى", "الموضوع"]);
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

  it("treats a standalone dash in wingCode as an empty placeholder", () => {
    const { mapping } = matchComplaintColumns([
      "رقم الشكوى",
      "تاريخ الشكوى",
      "الموضوع",
      "رمز الجناح",
    ]);

    const result = normalizeImportRow(
      {
        rowNumber: 2,
        values: {
          "رقم الشكوى": "C-WING-1",
          "تاريخ الشكوى": "2026-07-01",
          "الموضوع": "شكوى تجريبية",
          "رمز الجناح": "-",
        },
      },
      mapping
    );

    expect(result.normalized.wingCode).toBeUndefined();
    expect(result.errors).not.toContainEqual(
      expect.objectContaining({ code: "FORMULA_NOT_ALLOWED" })
    );
  });

  it.each([
    "-",
    "--",
    "---",
    "–",
    "—",
    "−",
    " -- ",
    "––",
    "——",
  ])("treats wingCode placeholder %j as empty without FORMULA_NOT_ALLOWED", (placeholder) => {
    expect(isEmptyWingCodePlaceholder(placeholder)).toBe(true);

    const { mapping } = matchComplaintColumns([
      "رقم الشكوى",
      "تاريخ الشكوى",
      "الموضوع",
      "رمز الجناح",
    ]);

    const result = normalizeImportRow(
      {
        rowNumber: 2,
        values: {
          "رقم الشكوى": `C-WING-${placeholder}`,
          "تاريخ الشكوى": "2026-07-01",
          "الموضوع": "شكوى تجريبية",
          "رمز الجناح": placeholder,
        },
      },
      mapping
    );

    expect(result.normalized.wingCode).toBeUndefined();
    expect(result.errors).not.toContainEqual(
      expect.objectContaining({ code: "FORMULA_NOT_ALLOWED" })
    );
  });

  it.each(["-1", "-أ", "جناح-1", "A-"])(
    "does not treat %j as an empty wingCode placeholder",
    (value) => {
      expect(isEmptyWingCodePlaceholder(value)).toBe(false);
    }
  );

  it("still rejects actual formulas in wingCode", () => {
    const { mapping } = matchComplaintColumns([
      "رقم الشكوى",
      "تاريخ الشكوى",
      "الموضوع",
      "رمز الجناح",
    ]);

    for (const formula of ["=1+1", "+1", "@value"] as const) {
      const result = normalizeImportRow(
        {
          rowNumber: 2,
          values: {
            "رقم الشكوى": `C-WING-F-${formula}`,
            "تاريخ الشكوى": "2026-07-01",
            "الموضوع": "شكوى تجريبية",
            "رمز الجناح": formula,
          },
        },
        mapping
      );

      expect(result.normalized.wingCode).toBeUndefined();
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          field: "wingCode",
          code: "FORMULA_NOT_ALLOWED",
        })
      );
    }
  });

  it("still rejects an actual formula in wingCode", () => {
    const { mapping } = matchComplaintColumns([
      "رقم الشكوى",
      "تاريخ الشكوى",
      "الموضوع",
      "رمز الجناح",
    ]);

    const result = normalizeImportRow(
      {
        rowNumber: 2,
        values: {
          "رقم الشكوى": "C-WING-2",
          "تاريخ الشكوى": "2026-07-01",
          "الموضوع": "شكوى تجريبية",
          "رمز الجناح": "=1+1",
        },
      },
      mapping
    );

    expect(result.normalized.wingCode).toBeUndefined();
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        field: "wingCode",
        code: "FORMULA_NOT_ALLOWED",
      })
    );
  });

  it("normalizes Excel serial dates without relying on locale timezone", () => {
    expect(normalizeExcelSerialDate(45108)?.toISOString()).toBe("2023-07-01T00:00:00.000Z");
  });

  it("validates required mapped columns", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "الموضوع"]);

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

    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ الشكوى", "الموضوع"]);

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
    const { columnMapping } = resolveEffectiveColumnMapping({
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

    expect(columnMapping).toMatchObject({
      "الرقم المرجعي": "sourceReference",
      "تاريخ الشكوى": "complaintDate",
      "الموضوع": "subject",
    });
    expect(columnMapping).not.toHaveProperty("رقم الشكوى");
  });

  it("falls back from empty caller mapping to stored mapping", () => {
    const { columnMapping } = resolveEffectiveColumnMapping({
      headers: ["رقم الشكوى", "تاريخ الشكوى", "الموضوع"],
      callerMapping: {},
      storedMapping: {
        "رقم الشكوى": "externalId",
        "تاريخ الشكوى": "complaintDate",
        "الموضوع": "subject",
      },
    });

    expect(columnMapping).toMatchObject({
      "رقم الشكوى": "externalId",
      "تاريخ الشكوى": "complaintDate",
      "الموضوع": "subject",
    });
  });

  it("falls back from empty caller and stored mappings to workbook header matching", () => {
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

  it("warns on unknown source status and rejects unsupported priority", () => {
    const { mapping } = matchComplaintColumns(["رقم الشكوى", "تاريخ الشكوى", "الموضوع", "الحالة", "الأولوية"]);
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

    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNKNOWN_SOURCE_STATUS" }),
    ]));
    expect(result.normalized.status).toBe(ComplaintStatus.NEW);
    expect(result.errors).toEqual(expect.arrayContaining([
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

  it("builds exclusive incoming identity keys (no weaker fallback keys)", () => {
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
    // Existing complaints are multi-indexed for performance; fingerprint remains available for lookup.
    expect(complaintKeys.some((key) => key.startsWith("fingerprint:"))).toBe(true);

    // Incoming rows use exclusive externalId-only strategy when present.
    expect(rowKeys).toEqual(["externalId:c-1"]);
    expect(rowKeys.some((key) => key.startsWith("fingerprint:"))).toBe(false);
  });

  it("never falls back to fingerprint when externalId differs from an existing match", () => {
    const date = new Date("2026-07-01T00:00:00Z");
    const shared = {
      complaintDate: date,
      region: "الرياض",
      facility: "سجن",
      department: "الإدارة",
      subject: "نفس الموضوع",
    };
    const existing = {
      id: "cmp-existing",
      version: 1,
      externalId: "COMP/06313",
      ...shared,
    } as Complaint;

    const existingByIdentity = new Map<string, ComplaintIndexEntry>();
    for (const key of complaintCandidateIdentityKeys(existing)) {
      existingByIdentity.set(key, { kind: "match", complaint: existing });
    }

    // Same fingerprint signal, different externalId
    const fingerprintKey = `fingerprint:${buildComplaintFingerprint(shared)}`;
    expect(existingByIdentity.has(fingerprintKey)).toBe(true);

    const incoming = {
      externalId: "COMP/06271",
      ...shared,
    };

    expect(resolveIncomingIdentity(incoming)).toEqual({
      kind: "EXTERNAL_ID",
      key: "externalId:comp/06271",
    });
    expect(findExistingComplaintByIdentity(
      resolveIncomingIdentity(incoming),
      existingByIdentity
    )).toBeUndefined();

    const classified = classifyNormalizedImportRows(
      [
        { externalId: "COMP/06313", ...shared },
        { externalId: "COMP/06271", ...shared },
      ],
      existingByIdentity
    );

    expect(classified[0]).toMatchObject({
      action: ImportRowAction.NO_CHANGE,
      matchedComplaintId: "cmp-existing",
      errors: [],
    });
    expect(classified[1]).toMatchObject({
      action: ImportRowAction.NEW,
      matchedComplaintId: null,
      errors: [],
    });
    expect(classified[1].errors.some((e) => e.code === "DUPLICATE_TARGET_COMPLAINT")).toBe(false);
  });

  it("uses sourceReference+date exclusively without fingerprint fallback", () => {
    const date = new Date("2026-07-01T00:00:00Z");
    const shared = {
      complaintDate: date,
      region: "الرياض",
      facility: "سجن",
      department: "الإدارة",
      subject: "موضوع",
    };
    const existing = {
      id: "cmp-src",
      version: 2,
      externalId: null,
      sourceReference: "SRC-MATCH",
      ...shared,
    } as Complaint;

    const index = new Map<string, ComplaintIndexEntry>();
    for (const key of complaintCandidateIdentityKeys(existing)) {
      index.set(key, { kind: "match", complaint: existing });
    }

    expect(resolveIncomingIdentity({ sourceReference: "SRC-MATCH", ...shared })).toMatchObject({
      kind: "SOURCE_REFERENCE_DATE",
    });

    // Unmatched sourceReference must not fall through to fingerprint of shared subject fields
    const miss = classifyNormalizedImportRows(
      [{ sourceReference: "SRC-OTHER", ...shared }],
      index
    );
    expect(miss[0]).toMatchObject({ action: ImportRowAction.NEW, matchedComplaintId: null });

    const hit = classifyNormalizedImportRows(
      [{ sourceReference: "SRC-MATCH", ...shared }],
      index
    );
    expect(hit[0]).toMatchObject({
      action: ImportRowAction.NO_CHANGE,
      matchedComplaintId: "cmp-src",
    });
  });

  it("uses fingerprint only when stronger identities are absent", () => {
    const date = new Date("2026-07-01T00:00:00Z");
    const shared = {
      complaintDate: date,
      region: "الرياض",
      facility: "سجن",
      department: "الإدارة",
      subject: "بصمة",
    };
    const existing = {
      id: "cmp-fp",
      version: 1,
      externalId: null,
      sourceReference: null,
      ...shared,
    } as Complaint;

    const index = new Map<string, ComplaintIndexEntry>();
    for (const key of complaintCandidateIdentityKeys(existing)) {
      index.set(key, { kind: "match", complaint: existing });
    }

    expect(resolveIncomingIdentity(shared).kind).toBe("FINGERPRINT");
    const classified = classifyNormalizedImportRows([shared], index);
    expect(classified[0]).toMatchObject({
      action: ImportRowAction.NO_CHANGE,
      matchedComplaintId: "cmp-fp",
    });
  });

  it("returns NONE for date-only rows (fingerprint needs date plus a descriptive field)", () => {
    expect(
      resolveIncomingIdentity({
        complaintDate: new Date("2026-07-01T00:00:00Z"),
      })
    ).toEqual({ kind: "NONE" });
    expect(
      resolveIncomingIdentity({
        subject: "موضوع فقط بدون تاريخ",
      })
    ).toEqual({ kind: "NONE" });
  });

  it("detects true in-file duplicates for the same externalId", () => {
    const row = {
      externalId: "COMP/DUPE",
      complaintDate: new Date("2026-07-01T00:00:00Z"),
      subject: "مكرر",
    };
    const classified = classifyNormalizedImportRows([row, row], new Map());
    expect(classified[0].action).toBe(ImportRowAction.NEW);
    expect(classified[1].action).toBe(ImportRowAction.DUPLICATE);
    expect(classified[1].errors.some((e) => e.code === "DUPLICATE_ROW_IN_FILE")).toBe(true);
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
    // Legacy name: now exclusive for incoming rows (externalId wins).
    expect(rowKeys).toEqual(["externalId:c-1"]);
  });

  describe("import preview presentation", () => {
    it("prefers normalizedData, falls back to rawData, then empty", () => {
      expect(
        resolvePreviewValue({ subject: "منظم" }, { "الموضوع": "خام" }, "subject", {
          "الموضوع": "subject",
        })
      ).toBe("منظم");
      expect(
        resolvePreviewValue(null, { "الموضوع": "خام", "رقم الشكوى": "COMP/1" }, "subject", {
          "الموضوع": "subject",
          "رقم الشكوى": "externalId",
        })
      ).toBe("خام");
      expect(
        resolvePreviewValue(null, { "رقم الشكوى": "COMP/1" }, "subject", {
          "رقم الشكوى": "externalId",
        })
      ).toBeUndefined();
    });

    it("orders blocking rows before warnings and respects the 100 display limit", () => {
      const blocking = Array.from({ length: 2 }, (_, i) => ({ id: `b${i}` }));
      const warnings = Array.from({ length: 120 }, (_, i) => ({ id: `w${i}` }));
      const displayed = orderQualityObservationsForDisplay(blocking, warnings);

      expect(displayed).toHaveLength(QUALITY_OBSERVATION_DISPLAY_LIMIT);
      expect(displayed.slice(0, 2).map((r) => r.id)).toEqual(["b0", "b1"]);
      expect(displayed.filter((r) => r.id.startsWith("b"))).toHaveLength(2);
      expect(displayed.filter((r) => r.id.startsWith("w"))).toHaveLength(98);

      const counts = {
        blockingRowCount: 2,
        warningRowCount: 6007,
        displayedObservationCount: 100,
        qualityDisplayLimit: 100,
      };
      expect(buildQualityObservationsSummary(counts)).toContain("مانع");
      expect(buildQualityObservationsSummary(counts)).toContain(
        new Intl.NumberFormat("ar-SA").format(6007)
      );
      expect(counts.blockingRowCount).not.toBe(counts.displayedObservationCount);
    });
  });

  describe("Issue #44 reference synthetic fixture", () => {
    it("treats different externalId as NEW despite shared fingerprint, accepts -- wingCode, and keeps matching externalId as NO_CHANGE", () => {
      const date = new Date("2026-07-01T00:00:00Z");
      const sharedFingerprint = {
        complaintDate: date,
        region: "الرياض",
        facility: "سجن",
        department: "الإدارة",
        subject: "شكوى مشتركة البصمة",
      };
      const existing = {
        id: "cmp-ref-06313",
        version: 3,
        externalId: "COMP/06313",
        ...sharedFingerprint,
      } as Complaint;

      const index = new Map<string, ComplaintIndexEntry>();
      for (const key of complaintCandidateIdentityKeys(existing)) {
        index.set(key, { kind: "match", complaint: existing });
      }

      // Row 3 style: existing externalId → NO_CHANGE
      // Row 44 style: different externalId, same fingerprint → NEW (not DUPLICATE_TARGET)
      const classified = classifyNormalizedImportRows(
        [
          { externalId: "COMP/06313", ...sharedFingerprint },
          { externalId: "COMP/06271", ...sharedFingerprint },
        ],
        index
      );

      expect(classified[0]).toMatchObject({
        action: ImportRowAction.NO_CHANGE,
        matchedComplaintId: "cmp-ref-06313",
      });
      expect(classified[1]).toMatchObject({
        action: ImportRowAction.NEW,
        matchedComplaintId: null,
        errors: [],
      });

      // Row 3207 style: wingCode "--" is not REJECT
      const { mapping } = matchComplaintColumns([
        "رقم الشكوى",
        "تاريخ الشكوى",
        "الموضوع",
        "رمز الجناح",
        "المنطقة",
        "السجن",
        "القسم",
      ]);
      const wing = normalizeImportRow(
        {
          rowNumber: 3207,
          values: {
            "رقم الشكوى": "COMP/03074",
            "تاريخ الشكوى": "2026-07-01",
            "الموضوع": "موضوع",
            "رمز الجناح": "--",
            "المنطقة": "الرياض",
            "السجن": "سجن",
            "القسم": "الإدارة",
          },
        },
        mapping
      );
      expect(wing.normalized.wingCode).toBeUndefined();
      expect(wing.errors).toEqual([]);

      // Preview of INVALID row with null normalized still surfaces raw complaint number
      expect(
        resolvePreviewValue(
          null,
          { "رقم الشكوى": "COMP/06271", "الموضوع": "شكوى" },
          "externalId",
          { "رقم الشكوى": "externalId", "الموضوع": "subject" }
        )
      ).toBe("COMP/06271");

      // Approve eligibility counters independent of warning flood
      const summary = buildQualityObservationsSummary({
        blockingRowCount: 0,
        warningRowCount: 6007,
        displayedObservationCount: 100,
        qualityDisplayLimit: 100,
      });
      expect(summary).toMatch(/ملاحظات جودة غير مانعة/);
      expect(summary).not.toMatch(/صف مانع|صفوف مانعة|صفان مانعان/);
    });
  });

  it("blocks duplicate uploads for active import states only", () => {
    expect(DUPLICATE_BLOCKING_IMPORT_STATUSES).toEqual([
      ImportBatchStatus.UPLOADED,
      ImportBatchStatus.PARSING,
      ImportBatchStatus.VALIDATED,
      ImportBatchStatus.READY_FOR_CONFIRMATION,
      ImportBatchStatus.CONFIRMING,
      ImportBatchStatus.CONFIRMED,
      ImportBatchStatus.FAILED,
    ]);
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
      matchedComplaintVersion: null,
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

    const { errors, warnings } = validateNormalizedComplaintRow({
      status: ComplaintStatus.OPEN,
      closedAt: new Date("2026-07-01T00:00:00Z"),
      subject: "س".repeat(301),
      category: "غير موجودة",
      classification: "غير موجود",
    }, taxonomy, new Date("2026-07-01T00:00:00Z"));

    expect(errors.map((message) => message.code)).toEqual(expect.arrayContaining([
      "MISSING_IDENTITY",
      "MISSING_COMPLAINT_DATE",
      "CLOSED_AT_FOR_OPEN_STATUS",
      "SUBJECT_TOO_LONG",
    ]));
    expect(warnings.map((message) => message.code)).toEqual(expect.arrayContaining([
      "CATEGORY_NOT_FOUND",
      "CLASSIFICATION_NOT_FOUND",
    ]));
  });
});

describe("getImportRowOutcome", () => {
  it("maps validation statuses to upload outcomes", () => {
    expect(getImportRowOutcome(ImportRowValidationStatus.INVALID)).toBe("REJECTED");
    expect(getImportRowOutcome(ImportRowValidationStatus.WARNING)).toBe(
      "IMPORTED_WITH_WARNINGS"
    );
    expect(getImportRowOutcome(ImportRowValidationStatus.VALID)).toBe("IMPORTED");
  });
});

describe("durable import resume", () => {
  it("rebuilds the preview from the same persisted batch without creating another batch", async () => {
    const findUnique = vi.spyOn(db.importBatch, "findUnique").mockResolvedValue({
      id: "batch_resume",
      originalFileName: "operational.xlsx",
      status: ImportBatchStatus.READY_FOR_CONFIRMATION,
      selectedSheet: "الشكاوى",
      columnMapping: {
        "رقم الشكوى": "externalId",
        "تفصيل": "sourceDetail",
        "الحالة": "status",
        "حالة الاجراء": "sourceActionStatus",
      },
      rows: [{
        rowNumber: 2,
        rawData: {
          "رقم الشكوى": "C-1",
          "تفصيل": "وكالة",
          "الحالة": "الإرسال إلى السجن",
          "حالة الاجراء": "جديد",
        },
        normalizedData: {
          externalId: "C-1",
          sourceDetail: "وكالة",
          sourceStatus: "الإرسال إلى السجن",
          sourceActionStatus: "جديد",
          status: ComplaintStatus.IN_PROGRESS,
        },
        externalId: "C-1",
        action: ImportRowAction.NEW,
        validationStatus: ImportRowValidationStatus.VALID,
        validationErrors: null,
        validationWarnings: null,
        matchedComplaintId: null,
        matchedComplaintVersion: null,
      }],
    } as never);

    try {
      const result = await loadImportBatchForResume("batch_resume");
      expect(result.batchId).toBe("batch_resume");
      expect(result.preview[0]).toMatchObject({
        sourceDetail: "وكالة",
        sourceStatus: "الإرسال إلى السجن",
        sourceActionStatus: "جديد",
        status: ComplaintStatus.IN_PROGRESS,
        statusDisplay: "تحت الإجراء",
      });
      expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "batch_resume" } }));
    } finally {
      findUnique.mockRestore();
    }
  });
});
