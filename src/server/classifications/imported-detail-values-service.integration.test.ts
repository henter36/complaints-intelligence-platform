import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ImportBatchStatus,
  ImportRowAction,
  ImportRowValidationStatus,
  PeriodType,
  PrismaClient,
  type Prisma,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  importDetailValuesAsKeywords,
  listImportedDetailValues,
} from "./imported-detail-values-service";
import { matchComplaintColumns } from "@/server/imports/complaint-column-schema";
import { normalizeImportRow } from "@/server/imports/normalization";
import { confirmReadyImportBatch } from "@/server/imports/import-confirmation-service";
import { persistPreviewRows } from "@/server/imports/excel-import-service";

let prisma: PrismaClient;
let tempDir: string;
let previousDatabaseUrl: string | undefined;

beforeAll(async () => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  tempDir = mkdtempSync(join(tmpdir(), "cip-imported-details-"));
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
  try {
    await prisma.$disconnect();
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

async function createBatch(status: ImportBatchStatus) {
  return prisma.importBatch.create({
    data: {
      fileName: `${crypto.randomUUID()}.xlsx`,
      originalFileName: "operational.xlsx",
      fileHash: crypto.randomUUID(),
      fileSize: 1024,
      periodType: PeriodType.MONTHLY,
      periodStart: new Date("2026-08-01T00:00:00.000Z"),
      periodEnd: new Date("2026-08-31T00:00:00.000Z"),
      status,
      createdBy: "integration-test",
    },
  });
}

async function addDetailRow(input: {
  batchId: string;
  rowNumber: number;
  normalizedData?: Prisma.InputJsonValue;
  rawData: Prisma.InputJsonValue;
}) {
  return prisma.importBatchRow.create({
    data: {
      importBatchId: input.batchId,
      rowNumber: input.rowNumber,
      rawData: input.rawData,
      normalizedData: input.normalizedData,
      action: ImportRowAction.NEW,
      validationStatus: ImportRowValidationStatus.VALID,
    },
  });
}

describe("imported detail values with real SQLite", () => {
  it("reads normalized and legacy raw details only from confirmed batches", async () => {
    const confirmed = await createBatch(ImportBatchStatus.CONFIRMED);
    await addDetailRow({
      batchId: confirmed.id,
      rowNumber: 1,
      normalizedData: { sourceDetail: "طلب نقل" },
      rawData: { "تفصيل": "قيمة أقدم" },
    });
    await addDetailRow({
      batchId: confirmed.id,
      rowNumber: 2,
      rawData: { "تفصيل": "طلب علاج" },
    });

    for (const status of [
      ImportBatchStatus.READY_FOR_CONFIRMATION,
      ImportBatchStatus.FAILED,
      ImportBatchStatus.ROLLED_BACK,
    ]) {
      const excluded = await createBatch(status);
      await addDetailRow({
        batchId: excluded.id,
        rowNumber: 1,
        normalizedData: { sourceDetail: `قيمة مستبعدة ${status}` },
        rawData: { "تفصيل": `قيمة مستبعدة ${status}` },
      });
    }

    const result = await listImportedDetailValues({}, prisma);

    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ displayValue: "طلب نقل", occurrences: 1 }),
      expect.objectContaining({ displayValue: "طلب علاج", occurrences: 1 }),
    ]));
    expect(result.items.map((item) => item.displayValue)).not.toContain("قيمة أقدم");
    expect(result.items.some((item) => item.displayValue.startsWith("قيمة مستبعدة"))).toBe(false);
    expect(result.total).toBe(2);
  });

  it("confirms an operational row, lists its detail, and links it without re-importing", async () => {
    const rawData = {
      "رقم الشكوى": `1001-${crypto.randomUUID()}`,
      "تفصيل": "وكالة",
      "الحالة": "الإرسال إلى السجن",
      "حالة الاجراء": "جديد",
      "تاريخ التسجيل": "2026-08-01",
      "الوصف": "اختبار قبول لمسار الاستيراد",
    };
    const { mapping } = matchComplaintColumns(Object.keys(rawData));
    const normalized = normalizeImportRow({ rowNumber: 2, values: rawData }, mapping);
    expect(normalized.normalized.sourceDetail).toBe("وكالة");

    const batch = await createBatch(ImportBatchStatus.READY_FOR_CONFIRMATION);
    await persistPreviewRows(batch.id, [{
      rowNumber: 2,
      rawData,
      normalizedData: JSON.parse(JSON.stringify(normalized.normalized)) as Prisma.InputJsonValue,
      externalId: normalized.normalized.externalId ?? null,
      action: ImportRowAction.NEW,
      validationStatus: ImportRowValidationStatus.VALID,
      validationErrors: null,
      validationWarnings: null,
      matchedComplaintId: null,
      matchedComplaintVersion: null,
    }], { importBatchRow: prisma.importBatchRow });
    await confirmReadyImportBatch(batch.id, { client: prisma });

    const category = await prisma.category.create({ data: { nameAr: `فئة ${crypto.randomUUID()}` } });
    const classification = await prisma.classification.create({
      data: { categoryId: category.id, nameAr: `تصنيف ${crypto.randomUUID()}` },
    });
    const beforeLink = await listImportedDetailValues({ classificationId: classification.id }, prisma);
    expect(beforeLink.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        displayValue: "وكالة",
        occurrences: 1,
        alreadyLinkedToCurrentClassification: false,
      }),
    ]));

    await importDetailValuesAsKeywords({
      classificationId: classification.id,
      values: ["وكالة"],
      actor: "integration-test",
    }, prisma);
    const afterLink = await listImportedDetailValues({
      classificationId: classification.id,
      linkStatus: "CURRENT",
    }, prisma);
    expect(afterLink.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        displayValue: "وكالة",
        alreadyLinkedToCurrentClassification: true,
      }),
    ]));
  });
});
