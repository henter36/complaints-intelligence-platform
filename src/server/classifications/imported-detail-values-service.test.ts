import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportBatchStatus, ImportRowAction, ImportRowValidationStatus } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  rowFindMany: vi.fn(),
  classificationFindMany: vi.fn(),
  classificationUpdate: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    importBatchRow: { findMany: mocks.rowFindMany },
    classification: {
      findMany: mocks.classificationFindMany,
      update: mocks.classificationUpdate,
    },
    auditLog: { create: mocks.auditCreate },
    $transaction: mocks.transaction,
  },
}));

import {
  importDetailValuesAsKeywords,
  listImportedDetailValues,
  normalizeImportedDetailValue,
} from "./imported-detail-values-service";

describe("imported detail values", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rowFindMany.mockResolvedValue([]);
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

  it("reads applied rows from confirmed batches only and groups Arabic variants", async () => {
    mocks.rowFindMany.mockResolvedValue([
      { normalizedData: { sourceDetail: "وكالة" } },
      { normalizedData: { sourceDetail: " وَكَالَة " } },
      { normalizedData: { sourceDetail: "وكالة" } },
      { normalizedData: { sourceDetail: "   " } },
      { normalizedData: null },
    ]);
    mocks.classificationFindMany.mockResolvedValue([
      { id: "cls_current", keywords: ["وكالة"] },
      { id: "cls_other", keywords: ["طلب علاج"] },
    ]);

    const result = await listImportedDetailValues({ classificationId: "cls_current" });

    expect(mocks.rowFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        importBatch: { status: ImportBatchStatus.CONFIRMED },
        validationStatus: { in: [ImportRowValidationStatus.VALID, ImportRowValidationStatus.WARNING] },
        action: { in: [ImportRowAction.NEW, ImportRowAction.UPDATE, ImportRowAction.NO_CHANGE, ImportRowAction.DUPLICATE] },
      },
      select: { normalizedData: true },
    }));
    expect(result.items).toEqual([
      expect.objectContaining({
        normalizedValue: normalizeImportedDetailValue("وكالة"),
        displayValue: "وكالة",
        occurrences: 3,
        linkedKeywordsCount: 1,
        alreadyLinkedToCurrentClassification: true,
      }),
    ]);
    expect(result.items[0]).not.toHaveProperty("complaintId");
    expect(result.items[0]).not.toHaveProperty("description");
  });

  it("supports normalized search, link filters, and pagination", async () => {
    mocks.rowFindMany.mockResolvedValue([
      { normalizedData: { sourceDetail: "وكالة" } },
      { normalizedData: { sourceDetail: "طلب علاج" } },
      { normalizedData: { sourceDetail: "نقل" } },
    ]);
    mocks.classificationFindMany.mockResolvedValue([
      { id: "cls_other", keywords: ["طلب علاج"] },
    ]);

    const searched = await listImportedDetailValues({ search: "  وَكَالَة  " });
    expect(searched.items.map((item) => item.displayValue)).toEqual(["وكالة"]);

    const linked = await listImportedDetailValues({ linkStatus: "OTHER", page: 1, pageSize: 1 });
    expect(linked).toMatchObject({ total: 1, page: 1, pageSize: 1 });
    expect(linked.items[0].displayValue).toBe("طلب علاج");
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
