/**
 * End-to-end integration test: XLSX file → column detection → normalization →
 * confirmation → Complaint persisted with all operational fields.
 *
 * Uses a fresh SQLite database per run so it never touches the dev database.
 */
import JSZip from "jszip";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComplaintPriority,
  ComplaintStatus,
  ImportBatchStatus,
  ImportRowAction,
  ImportRowValidationStatus,
  PeriodType,
  type Prisma,
  PrismaClient,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { analyzeColumnMapping, matchComplaintColumns } from "./complaint-column-schema";
import { normalizeImportRow } from "./normalization";
import { parseXlsxWorkbook } from "./xlsx-parser";
import { confirmReadyImportBatch } from "./import-confirmation-service";

// Keep integration tests isolated from the AI scan service.
const startTextRiskScanMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ runId: "scan-mock", status: "COMPLETE", processed: 0, matched: 0 })
);
vi.mock("@/server/analytics/text-risk/text-risk-analysis-service", () => ({
  startTextRiskScan: startTextRiskScanMock,
}));

// ---------------------------------------------------------------------------
// Synthetic workbook builder
// ---------------------------------------------------------------------------

const OPERATIONAL_HEADERS = [
  "رقم الشكوى",
  "هوية السجين",
  "عدد الشكاوي",   // INTENTIONALLY_IGNORED
  "المصدر",         // → sourceOrigin (NOT channel)
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
  "وصف الإجراء",
  "الوصف",
  "رمز الجناح",
  "المُعرف",
  "تاريخ الإنشاء",
] as const;

type CellValue = string | number | { n: number };

async function buildOperationalWorkbook(dataRows: CellValue[][]): Promise<Buffer> {
  const zip = new JSZip();

  const headerRow = OPERATIONAL_HEADERS.map((header, col) => {
    const colLetter = String.fromCharCode(65 + col);
    return `<c r="${colLetter}1" t="inlineStr"><is><t>${header}</t></is></c>`;
  }).join("");

  const sheetRows = [{ r: 1, cells: headerRow }];

  for (const [rowOffset, row] of dataRows.entries()) {
    const rowNumber = rowOffset + 2;
    const cells = row
      .map((value, col) => {
        const colLetter = String.fromCharCode(65 + col);
        const ref = `${colLetter}${rowNumber}`;
        if (typeof value === "object" && "n" in value) {
          return `<c r="${ref}"><v>${value.n}</v></c>`;
        }
        return `<c r="${ref}" t="inlineStr"><is><t>${String(value)}</t></is></c>`;
      })
      .join("");
    sheetRows.push({ r: rowNumber, cells });
  }

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="الشكاوى" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<worksheet><sheetData>
${sheetRows.map((row) => `<row r="${row.r}">${row.cells}</row>`).join("\n")}
</sheetData></worksheet>`
  );

  return zip.generateAsync({ type: "nodebuffer" });
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

let prisma: PrismaClient;
let tempDir: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cip-xlsx-integration-"));
  const dbPath = join(tempDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    stdio: "pipe",
  });
  prisma = new PrismaClient();
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

async function createReadyBatch(prismaClient: PrismaClient) {
  return prismaClient.importBatch.create({
    data: {
      fileName: `imports/${crypto.randomUUID()}.xlsx`,
      originalFileName: "operational.xlsx",
      fileHash: crypto.randomUUID(),
      fileSize: 4096,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      periodType: PeriodType.MONTHLY,
      periodStart: new Date("2026-07-01T00:00:00Z"),
      periodEnd: new Date("2026-07-31T00:00:00Z"),
      status: ImportBatchStatus.READY_FOR_CONFIRMATION,
      totalRows: 1,
      validRows: 1,
      invalidRows: 0,
      newRows: 1,
      updatedRows: 0,
      noChangeRows: 0,
      duplicateRows: 0,
      createdBy: "single-admin",
    },
  });
}

async function addRow(
  prismaClient: PrismaClient,
  input: {
    batchId: string;
    rowNumber: number;
    action: ImportRowAction;
    externalId?: string;
    normalizedData: Record<string, unknown>;
    validationStatus?: ImportRowValidationStatus;
  }
) {
  return prismaClient.importBatchRow.create({
    data: {
      importBatchId: input.batchId,
      rowNumber: input.rowNumber,
      rawData: { rowNumber: input.rowNumber },
      normalizedData: input.normalizedData as Prisma.InputJsonValue,
      externalId: input.externalId ?? null,
      action: input.action,
      validationStatus: input.validationStatus ?? ImportRowValidationStatus.VALID,
      matchedComplaintId: null,
      matchedComplaintVersion: null,
    },
  });
}

// ---------------------------------------------------------------------------
// Column detection tests (no DB required)
// ---------------------------------------------------------------------------

describe("XLSX operational field mapping", () => {
  it("parses workbook and detects all operational headers", async () => {
    const buffer = await buildOperationalWorkbook([
      ["COMP/001", "1000000001", 1, "مستشفى الملك فهد", "سجن المدينة", "الرياض",
       "طلب نقل", "قسم الرعاية", { n: 46126 }, "قيد المعالجة", "", "مفتوح",
       { n: 46126.5 }, "المشرف محمد", "تم مراجعة الطلب", "يُوصى بالنقل",
       "يشكو المتهم من ظروف السجن", "A12", "REF-001", { n: 46100 }],
    ]);

    const parsed = await parseXlsxWorkbook(buffer);
    const headers = Object.keys(parsed.rows[0]?.values ?? {});

    expect(headers).toContain("رقم الشكوى");
    expect(headers).toContain("المصدر");
    expect(headers).toContain("عدد الشكاوي");
    expect(headers).toContain("الإجراء المتخذ");
    expect(headers).toContain("وصف الإجراء");
    expect(headers).toContain("أغلقت بواسطة");
    expect(headers).toContain("الوصف");
  });

  it("maps المصدر to sourceOrigin — not channel", () => {
    const { mapping } = matchComplaintColumns([...OPERATIONAL_HEADERS]);
    expect(mapping["المصدر"]).toBe("sourceOrigin");
    expect(Object.values(mapping)).not.toContain("channel");
  });

  it("maps الإجراء المتخذ to actionTaken", () => {
    const { mapping } = matchComplaintColumns([...OPERATIONAL_HEADERS]);
    expect(mapping["الإجراء المتخذ"]).toBe("actionTaken");
  });

  it("maps وصف الإجراء to actionDescription", () => {
    const { mapping } = matchComplaintColumns([...OPERATIONAL_HEADERS]);
    expect(mapping["وصف الإجراء"]).toBe("actionDescription");
  });

  it("maps أغلقت بواسطة to sourceClosedBy", () => {
    const { mapping } = matchComplaintColumns([...OPERATIONAL_HEADERS]);
    expect(mapping["أغلقت بواسطة"]).toBe("sourceClosedBy");
  });

  it("marks عدد الشكاوي as INTENTIONALLY_IGNORED and excludes it from unmappedColumns", () => {
    const { mapping, conflicts } = matchComplaintColumns([...OPERATIONAL_HEADERS]);
    const analysis = analyzeColumnMapping([...OPERATIONAL_HEADERS], mapping, { conflicts });

    expect(mapping["عدد الشكاوي"]).toBeUndefined();
    expect(analysis.unmappedColumns).not.toContain("عدد الشكاوي");
    const entry = analysis.entries.find((e) => e.header === "عدد الشكاوي");
    expect(entry?.status).toBe("INTENTIONALLY_IGNORED");
  });
});

// ---------------------------------------------------------------------------
// Normalization tests (no DB required)
// ---------------------------------------------------------------------------

describe("XLSX operational normalization", () => {
  it("normalizes description and does not emit DESCRIPTION_VALUE_MISSING when text is present", () => {
    const { mapping } = matchComplaintColumns([...OPERATIONAL_HEADERS]);
    const result = normalizeImportRow(
      {
        rowNumber: 2,
        values: {
          "رقم الشكوى": "COMP/001",
          "تاريخ التسجيل": 46126,
          "الوصف": "يشكو المتهم من ظروف السجن",
        },
      },
      mapping
    );

    expect(result.normalized.description).toBe("يشكو المتهم من ظروف السجن");
    expect(result.warnings.some((w) => w.code === "DESCRIPTION_VALUE_MISSING")).toBe(false);
  });

  it("normalizes المصدر to sourceOrigin, never to channel", () => {
    const { mapping } = matchComplaintColumns([...OPERATIONAL_HEADERS]);
    const result = normalizeImportRow(
      {
        rowNumber: 2,
        values: {
          "رقم الشكوى": "COMP/001",
          "تاريخ التسجيل": 46126,
          "المصدر": "مستشفى الملك فهد",
        },
      },
      mapping
    );

    expect(result.normalized.sourceOrigin).toBe("مستشفى الملك فهد");
    expect(result.normalized.channel).toBeUndefined();
  });

  it("normalizes all operational text fields from a full row", () => {
    const { mapping } = matchComplaintColumns([...OPERATIONAL_HEADERS]);
    const result = normalizeImportRow(
      {
        rowNumber: 2,
        values: {
          "رقم الشكوى": "COMP/002",
          "تاريخ التسجيل": 46126,
          "المصدر": "مستشفى الملك فهد",
          "الإجراء المتخذ": "تم مراجعة الطلب",
          "وصف الإجراء": "يُوصى بالنقل",
          "أغلقت بواسطة": "المشرف محمد",
          "رمز الجناح": "A12",
          "آخر تحديث بواسطة": "مسؤول النظام",
          "الوصف": "يشكو المتهم من ظروف السجن",
          "عدد الشكاوي": 5,
        },
      },
      mapping
    );

    expect(result.normalized.sourceOrigin).toBe("مستشفى الملك فهد");
    expect(result.normalized.actionTaken).toBe("تم مراجعة الطلب");
    expect(result.normalized.actionDescription).toBe("يُوصى بالنقل");
    expect(result.normalized.sourceClosedBy).toBe("المشرف محمد");
    expect(result.normalized.wingCode).toBe("A12");
    expect(result.normalized.sourceUpdatedBy).toBe("مسؤول النظام");
    expect(result.normalized.description).toBe("يشكو المتهم من ظروف السجن");
    // عدد الشكاوي is INTENTIONALLY_IGNORED — it must not appear in the normalized row
    expect("complaintCount" in result.normalized).toBe(false);
  });

  it("normalizes date fields for sourceUpdatedAt and sourceModifiedAt", () => {
    const headersWithDates = [...OPERATIONAL_HEADERS, "آخر تعديل في"] as const;
    const { mapping } = matchComplaintColumns([...headersWithDates]);
    const result = normalizeImportRow(
      {
        rowNumber: 2,
        values: {
          "رقم الشكوى": "COMP/003",
          "تاريخ التسجيل": 46126,
          "آخر تحديث في": 46126.5,
          "آخر تعديل في": "2026-04-15T00:00:00.000Z",
        },
      },
      mapping
    );

    expect(result.normalized.sourceUpdatedAt).toBeInstanceOf(Date);
    expect(result.normalized.sourceModifiedAt).toBeInstanceOf(Date);
    expect(result.normalized.sourceModifiedAt?.toISOString()).toBe("2026-04-15T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// End-to-end confirmation: all operational fields survive to Complaint
// ---------------------------------------------------------------------------

describe("XLSX operational confirmation — fields persist to Complaint", () => {
  it("saves description, sourceOrigin, actionTaken, actionDescription, sourceClosedBy, wingCode, sourceUpdatedBy via confirmation", async () => {
    const externalId = `COMP/E2E-${crypto.randomUUID()}`;
    const batch = await createReadyBatch(prisma);

    await addRow(prisma, {
      batchId: batch.id,
      rowNumber: 2,
      action: ImportRowAction.NEW,
      externalId,
      normalizedData: {
        externalId,
        complaintDate: "2026-07-01T00:00:00.000Z",
        receivedAt: "2026-07-01T00:00:00.000Z",
        status: ComplaintStatus.OPEN,
        priority: ComplaintPriority.MEDIUM,
        description: "يشكو المتهم من ظروف السجن",
        sourceOrigin: "مستشفى الملك فهد",
        actionTaken: "تم مراجعة الطلب",
        actionDescription: "يُوصى بالنقل",
        sourceClosedBy: "المشرف محمد",
        wingCode: "A12",
        sourceUpdatedAt: "2026-07-15T10:30:00.000Z",
        sourceModifiedAt: "2026-07-14T08:00:00.000Z",
        sourceUpdatedBy: "مسؤول النظام",
        sourceStatus: "مفتوح",
        sourceDetail: "طلب نقل",
        sourceActionStatus: "قيد المعالجة",
      },
    });

    await confirmReadyImportBatch(batch.id, { client: prisma, actor: "single-admin" });

    const complaint = await prisma.complaint.findUnique({ where: { externalId } });
    expect(complaint).not.toBeNull();
    expect(complaint?.description).toBe("يشكو المتهم من ظروف السجن");
    expect(complaint?.sourceOrigin).toBe("مستشفى الملك فهد");
    expect(complaint?.actionTaken).toBe("تم مراجعة الطلب");
    expect(complaint?.actionDescription).toBe("يُوصى بالنقل");
    expect(complaint?.sourceClosedBy).toBe("المشرف محمد");
    expect(complaint?.wingCode).toBe("A12");
    expect(complaint?.sourceUpdatedAt?.toISOString()).toBe("2026-07-15T10:30:00.000Z");
    expect(complaint?.sourceModifiedAt?.toISOString()).toBe("2026-07-14T08:00:00.000Z");
    expect(complaint?.sourceUpdatedBy).toBe("مسؤول النظام");
    expect(complaint?.sourceStatus).toBe("مفتوح");
    expect(complaint?.sourceDetail).toBe("طلب نقل");
    expect(complaint?.sourceActionStatus).toBe("قيد المعالجة");
    // channel must not be set from المصدر
    expect(complaint?.channel).toBeNull();
  });

  it("عدد الشكاوي does not affect the total records count — ignored row still creates one Complaint", async () => {
    const externalId = `COMP/COUNT-${crypto.randomUUID()}`;
    const batch = await createReadyBatch(prisma);

    await addRow(prisma, {
      batchId: batch.id,
      rowNumber: 2,
      action: ImportRowAction.NEW,
      externalId,
      normalizedData: {
        externalId,
        complaintDate: "2026-07-01T00:00:00.000Z",
        receivedAt: "2026-07-01T00:00:00.000Z",
        status: ComplaintStatus.OPEN,
        priority: ComplaintPriority.MEDIUM,
        description: "شكوى لاختبار عدد الشكاوي",
        // Intentionally no complaintCount field — it should never appear here
      },
    });

    const result = await confirmReadyImportBatch(batch.id, { client: prisma, actor: "single-admin" });
    expect(result.created).toBe(1);

    const complaint = await prisma.complaint.findUnique({ where: { externalId } });
    expect(complaint).not.toBeNull();
  });

  it("resolution field stays independent — not overridden by sourceOrigin", async () => {
    const externalId = `COMP/RES-${crypto.randomUUID()}`;
    const batch = await createReadyBatch(prisma);

    await addRow(prisma, {
      batchId: batch.id,
      rowNumber: 2,
      action: ImportRowAction.NEW,
      externalId,
      normalizedData: {
        externalId,
        complaintDate: "2026-07-01T00:00:00.000Z",
        receivedAt: "2026-07-01T00:00:00.000Z",
        status: ComplaintStatus.OPEN,
        priority: ComplaintPriority.MEDIUM,
        sourceOrigin: "جهة المصدر",
        resolution: "تم الحل بالتراضي",
      },
    });

    await confirmReadyImportBatch(batch.id, { client: prisma, actor: "single-admin" });

    const complaint = await prisma.complaint.findUnique({ where: { externalId } });
    expect(complaint?.sourceOrigin).toBe("جهة المصدر");
    expect(complaint?.resolution).toBe("تم الحل بالتراضي");
    expect(complaint?.channel).toBeNull();
  });
});
