import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportBatchStatus, ImportRowAction, ImportRowValidationStatus } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  rowFindMany: vi.fn(),
  batchCount: vi.fn(),
  classificationFindMany: vi.fn(),
  classificationUpdate: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    importBatch: { count: mocks.batchCount },
    importBatchRow: { findMany: mocks.rowFindMany },
    classification: {
      findMany: mocks.classificationFindMany,
      update: mocks.classificationUpdate,
    },
    auditLog: { create: mocks.auditCreate },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/server/logger", () => ({
  logger: { info: mocks.loggerInfo, warn: mocks.loggerWarn, error: vi.fn() },
}));

import {
  importDetailValuesAsKeywords,
  extractSourceDetail,
  listImportedDetailValues,
} from "./imported-detail-values-service";
import { normalizeClassificationKeyword } from "@/lib/classifications/classification-keyword-normalizer";

describe("imported detail values", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rowFindMany.mockResolvedValue([]);
    mocks.batchCount.mockResolvedValue(0);
    mocks.classificationFindMany.mockResolvedValue([]);
    mocks.classificationUpdate.mockResolvedValue({});
    mocks.auditCreate.mockResolvedValue({});
    mocks.transaction.mockImplementation(async (callback) => callback({
      classification: {
        findMany: mocks.classificationFindMany,
        update: mocks.classificationUpdate,
      },
      auditLog: { create: mocks.auditCreate },
    }));
  });

  it("extracts new and legacy detail fields without using complaint descriptions", () => {
    expect(extractSourceDetail(
      { sourceDetail: "القيمة المطبعة" },
      { sourceDetail: "قيمة raw", "تفصيل": "قيمة عربية" }
    )).toBe("القيمة المطبعة");
    expect(extractSourceDetail(null, { sourceDetail: "قيمة raw" })).toBe("قيمة raw");
    expect(extractSourceDetail(null, { "تفصيل": "طلب علاج" })).toBe("طلب علاج");
    expect(extractSourceDetail(null, { "التفصيل": "طلب نقل" })).toBe("طلب نقل");
    expect(extractSourceDetail(null, { " الـتـفصيل ": "وكالة" })).toBe("وكالة");
    expect(extractSourceDetail(null, { description: "لا تستخدم كوصف بديل" })).toBeNull();
  });

  it.each([
    ["إدارة", "اداره"],
    ["شكوى", "شكوي"],
    ["وكـالة", "وَكَالَة"],
    ["طلب   نقل", "  طلب نقل  "],
  ])("uses the central Arabic normalization policy for %s and %s", (left, right) => {
    expect(normalizeClassificationKeyword(left)).toBe(normalizeClassificationKeyword(right));
    expect(normalizeClassificationKeyword(left)).not.toBe("");
  });

  it("reads applied rows from confirmed batches only and groups Arabic variants", async () => {
    mocks.rowFindMany
      .mockResolvedValueOnce([
        { id: "row-1", normalizedData: { sourceDetail: "وكالة" } },
        { id: "row-2", normalizedData: { sourceDetail: " وَكَالَة " } },
        { id: "row-3", normalizedData: null },
        { id: "row-4", normalizedData: { sourceDetail: "   " } },
        { id: "row-5", normalizedData: null },
      ])
      .mockResolvedValueOnce([
        { id: "row-3", rawData: { "تفصيل": "وكالة" } },
        { id: "row-4", rawData: {} },
        { id: "row-5", rawData: {} },
      ]);
    mocks.batchCount.mockResolvedValue(2);
    mocks.classificationFindMany.mockResolvedValue([
      { id: "cls_current", keywords: ["وكالة"] },
      { id: "cls_other", keywords: ["طلب علاج"] },
    ]);

    const result = await listImportedDetailValues({ classificationId: "cls_current" });

    expect(mocks.rowFindMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: {
        importBatch: { status: ImportBatchStatus.CONFIRMED },
        validationStatus: { in: [ImportRowValidationStatus.VALID, ImportRowValidationStatus.WARNING] },
        action: { in: [ImportRowAction.NEW, ImportRowAction.UPDATE, ImportRowAction.NO_CHANGE, ImportRowAction.DUPLICATE] },
      },
      select: { id: true, normalizedData: true },
      orderBy: { id: "asc" },
      take: 500,
    }));
    expect(mocks.rowFindMany.mock.calls[0][0]).not.toHaveProperty("cursor");
    expect(mocks.rowFindMany.mock.calls[0][0]).not.toHaveProperty("skip");
    expect(mocks.rowFindMany).toHaveBeenNthCalledWith(2, {
      where: {
        AND: [
          {
            importBatch: { status: ImportBatchStatus.CONFIRMED },
            validationStatus: { in: [ImportRowValidationStatus.VALID, ImportRowValidationStatus.WARNING] },
            action: { in: [ImportRowAction.NEW, ImportRowAction.UPDATE, ImportRowAction.NO_CHANGE, ImportRowAction.DUPLICATE] },
          },
          { id: { in: ["row-3", "row-4", "row-5"] } },
        ],
      },
      select: { id: true, rawData: true },
    });
    expect(result.items).toEqual([
      expect.objectContaining({
        normalizedValue: normalizeClassificationKeyword("وكالة"),
        displayValue: "وكالة",
        occurrences: 3,
        linkedKeywordsCount: 1,
        alreadyLinkedToCurrentClassification: true,
      }),
    ]);
    expect(result).toMatchObject({
      total: 1,
      availableTotal: 1,
      diagnostics: {
        confirmedBatches: 2,
        rowsScanned: 5,
        rowsWithSourceDetail: 3,
        distinctValues: 1,
      },
    });
    expect(mocks.loggerInfo).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
    expect(result.items[0]).not.toHaveProperty("complaintId");
    expect(result.items[0]).not.toHaveProperty("description");
  });

  it("supports normalized search, link filters, and pagination", async () => {
    mocks.rowFindMany.mockResolvedValue([
      { id: "row-1", normalizedData: { sourceDetail: "وكالة" } },
      { id: "row-2", normalizedData: { sourceDetail: "طلب علاج" } },
      { id: "row-3", normalizedData: { sourceDetail: "نقل" } },
    ]);
    mocks.classificationFindMany.mockResolvedValue([
      { id: "cls_other", keywords: ["طلب علاج"] },
    ]);

    const searched = await listImportedDetailValues({ search: "  وَكَالَة  " });
    expect(searched.items.map((item) => item.displayValue)).toEqual(["وكالة"]);

    const emptySearch = await listImportedDetailValues({ search: "" });
    expect(emptySearch.total).toBe(3);

    const currentContext = await listImportedDetailValues({ classificationId: "cls_current" });
    expect(currentContext.items.map((item) => item.displayValue)).toEqual([
      "طلب علاج",
      "نقل",
      "وكالة",
    ]);

    const linked = await listImportedDetailValues({ linkStatus: "OTHER", page: 1, pageSize: 1 });
    expect(linked).toMatchObject({ total: 1, page: 1, pageSize: 1 });
    expect(linked.items[0].displayValue).toBe("طلب علاج");

    const unlinked = await listImportedDetailValues({ linkStatus: "UNLINKED" });
    expect(unlinked.items.map((item) => item.displayValue)).toEqual(["نقل", "وكالة"]);

    const linkedCurrent = await listImportedDetailValues({
      classificationId: "cls_other",
      linkStatus: "CURRENT",
    });
    expect(linkedCurrent.items.map((item) => item.displayValue)).toEqual(["طلب علاج"]);

    const secondPage = await listImportedDetailValues({ page: 2, pageSize: 2 });
    expect(secondPage).toMatchObject({ page: 2, pageSize: 2, total: 3, availableTotal: 3 });
    expect(secondPage.items).toHaveLength(1);
  });

  it("uses a stable id cursor without cumulative offset and does not repeat rows", async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      id: `row-${String(index + 1).padStart(3, "0")}`,
      normalizedData: { sourceDetail: "وكالة" },
    }));
    mocks.rowFindMany
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([
        { id: "row-501", normalizedData: { sourceDetail: "وكالة" } },
      ]);

    const result = await listImportedDetailValues();

    expect(mocks.rowFindMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      orderBy: { id: "asc" },
      take: 500,
    }));
    expect(mocks.rowFindMany.mock.calls[0][0]).not.toHaveProperty("cursor");
    expect(mocks.rowFindMany.mock.calls[0][0]).not.toHaveProperty("skip");
    expect(mocks.rowFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cursor: { id: "row-500" },
      skip: 1,
      orderBy: { id: "asc" },
      take: 500,
    }));
    expect(result.items).toEqual([
      expect.objectContaining({ displayValue: "وكالة", occurrences: 501 }),
    ]);
    expect(result.diagnostics).toMatchObject({
      rowsScanned: 501,
      rowsWithSourceDetail: 501,
    });
  });

  it("warns once without PII when confirmed rows have no extractable details", async () => {
    mocks.batchCount.mockResolvedValue(1);
    mocks.rowFindMany
      .mockResolvedValueOnce([{ id: "row-1", normalizedData: null }])
      .mockResolvedValueOnce([{ id: "row-1", rawData: {} }]);

    const result = await listImportedDetailValues();

    expect(result.total).toBe(0);
    expect(mocks.loggerInfo).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledOnce();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Confirmed imports contain no extractable detail values",
      { confirmedBatchCount: 1, rowsScanned: 1 }
    );
    expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain("rawData");
  });

  it("adds one or several values, deduplicates them, and writes safe audit metadata", async () => {
    mocks.classificationFindMany.mockResolvedValue([
      { id: "cls_current", keywords: ["موجودة"] },
      { id: "cls_other", keywords: [] },
    ]);

    const result = await importDetailValuesAsKeywords({
      classificationId: "cls_current",
      values: ["وكالة", " وَكَالَة ", "موجودة", "طلب علاج"],
      actor: "admin",
    });

    expect(result).toMatchObject({ added: 2, alreadyExists: 1, conflicts: [] });
    expect(mocks.classificationUpdate).toHaveBeenCalledWith({
      where: { id: "cls_current" },
      data: { keywords: ["موجودة", "وكالة", "طلب علاج"] },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CLASSIFICATION_KEYWORDS_IMPORTED",
        metadata: {
          source: "IMPORTED_DETAIL",
          requestedCount: 3,
          addedCount: 2,
          alreadyExistsCount: 1,
        },
      }),
    });
    expect(mocks.auditCreate.mock.calls[0][0].data.metadata).not.toHaveProperty("complaintId");
  });

  it("rejects a cross-classification conflict atomically", async () => {
    mocks.classificationFindMany.mockResolvedValue([
      { id: "cls_current", keywords: [] },
      { id: "cls_other", keywords: ["وكالة"] },
    ]);

    await expect(importDetailValuesAsKeywords({
      classificationId: "cls_current",
      values: ["طلب علاج", " وَكَالَة "],
    })).rejects.toMatchObject({ code: "KEYWORD_ALREADY_LINKED_TO_ANOTHER_CLASSIFICATION" });
    expect(mocks.classificationUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
