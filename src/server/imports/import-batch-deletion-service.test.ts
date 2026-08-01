import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportBatchStatus } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  batchFind: vi.fn(),
  batchDeleteMany: vi.fn(),
  complaintCount: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    auditLog: { create: mocks.auditCreate },
    $transaction: mocks.transaction,
  },
}));

vi.mock("./file-storage", () => ({
  deleteStoredImportFileForBatch: mocks.deleteFile,
}));

import { deleteUnconfirmedImportBatch } from "./import-batch-deletion-service";

describe("delete unconfirmed import batch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.batchFind.mockResolvedValue({
      id: "batch_1",
      status: ImportBatchStatus.READY_FOR_CONFIRMATION,
      storageKey: "safe.xlsx",
      originalFileName: "complaints.xlsx",
    });
    mocks.batchDeleteMany.mockResolvedValue({ count: 1 });
    mocks.complaintCount.mockResolvedValue(0);
    mocks.auditCreate.mockResolvedValue({});
    mocks.deleteFile.mockResolvedValue("DELETED");
    mocks.transaction.mockImplementation(async (callback) => callback({
      importBatch: { findUnique: mocks.batchFind, deleteMany: mocks.batchDeleteMany },
      complaint: { count: mocks.complaintCount },
      auditLog: { create: mocks.auditCreate },
    }));
  });

  it.each([
    ImportBatchStatus.UPLOADED,
    ImportBatchStatus.VALIDATED,
    ImportBatchStatus.READY_FOR_CONFIRMATION,
    ImportBatchStatus.FAILED,
  ])("deletes %s rows transactionally, preserves complaints, audits, and removes storage", async (status) => {
    mocks.batchFind.mockResolvedValueOnce({
      id: "batch_1",
      status,
      storageKey: "safe.xlsx",
      originalFileName: "complaints.xlsx",
    });

    await expect(deleteUnconfirmedImportBatch("batch_1", "admin")).resolves.toEqual({
      deleted: true,
      storageCleanup: "DELETED",
    });
    expect(mocks.complaintCount).toHaveBeenCalledWith({ where: { importBatchId: "batch_1" } });
    expect(mocks.batchDeleteMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "batch_1" }) }));
    expect(mocks.auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "IMPORT_BATCH_DELETED" }) });
    expect(mocks.deleteFile).toHaveBeenCalledWith("safe.xlsx");
  });

  it.each([
    ImportBatchStatus.PARSING,
    ImportBatchStatus.CONFIRMING,
    ImportBatchStatus.CONFIRMED,
    ImportBatchStatus.ROLLING_BACK,
    ImportBatchStatus.ROLLED_BACK,
  ])("prevents deletion in %s state", async (status) => {
    mocks.batchFind.mockResolvedValueOnce({
      id: "batch_1",
      status,
      storageKey: "safe.xlsx",
      originalFileName: "complaints.xlsx",
    });

    await expect(deleteUnconfirmedImportBatch("batch_1")).rejects.toMatchObject({
      code: "IMPORT_BATCH_STATE_CONFLICT",
    });
    expect(mocks.batchDeleteMany).not.toHaveBeenCalled();
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });

  it("returns a state conflict when another tab changes the batch before deletion", async () => {
    mocks.batchDeleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(deleteUnconfirmedImportBatch("batch_1")).rejects.toMatchObject({
      code: "IMPORT_BATCH_STATE_CONFLICT",
    });
  });

  it("records sanitized cleanup failure after the database deletion", async () => {
    mocks.deleteFile.mockRejectedValueOnce(new Error("/private/storage/secret.xlsx"));
    const result = await deleteUnconfirmedImportBatch("batch_1");

    expect(result.storageCleanup).toBe("FAILED");
    expect(mocks.auditCreate).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        action: "IMPORT_BATCH_FILE_CLEANUP_FAILED",
        metadata: { cleanupRequired: true },
      }),
    });
    expect(JSON.stringify(result)).not.toContain("/private/storage");
  });
});
