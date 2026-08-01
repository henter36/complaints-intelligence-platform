import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportValidationError } from "@/server/imports/import-errors";

const mocks = vi.hoisted(() => ({
  loadResume: vi.fn(),
  deleteBatch: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("@/server/auth/auth-guard", () => ({
  requireAdminApiSession: vi.fn().mockResolvedValue({ username: "admin" }),
  mapAuthError: vi.fn().mockReturnValue(null),
}));

vi.mock("@/server/imports/excel-import-service", () => ({
  loadImportBatchForResume: mocks.loadResume,
}));

vi.mock("@/server/imports/import-batch-deletion-service", () => ({
  deleteUnconfirmedImportBatch: mocks.deleteBatch,
}));

vi.mock("@/lib/db", () => ({ db: { importBatch: { findUnique: mocks.findUnique } } }));

import { DELETE, GET } from "./route";

const context = { params: Promise.resolve({ batchId: "batch_1" }) };

describe("import batch resume and delete route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads the same persisted batch for resume", async () => {
    mocks.loadResume.mockResolvedValue({ batchId: "batch_1", status: "READY_FOR_CONFIRMATION" });
    const response = await GET(new NextRequest("http://localhost/api/import/batch_1?resume=true"), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ batchId: "batch_1" });
    expect(mocks.loadResume).toHaveBeenCalledWith("batch_1");
  });

  it("deletes an eligible batch with the authenticated actor", async () => {
    mocks.deleteBatch.mockResolvedValue({ deleted: true, storageCleanup: "DELETED" });
    const response = await DELETE(new NextRequest("http://localhost/api/import/batch_1", {
      method: "DELETE",
      headers: { origin: "http://localhost", host: "localhost" },
    }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, storageCleanup: "DELETED" });
    expect(mocks.deleteBatch).toHaveBeenCalledWith("batch_1", "admin");
  });

  it("returns IMPORT_BATCH_STATE_CONFLICT for a concurrent state change", async () => {
    mocks.deleteBatch.mockRejectedValue(new ImportValidationError(
      "IMPORT_BATCH_STATE_CONFLICT",
      "تغيرت حالة الدفعة في جلسة أخرى.",
      409
    ));
    const response = await DELETE(new NextRequest("http://localhost/api/import/batch_1", {
      method: "DELETE",
      headers: { origin: "http://localhost", host: "localhost" },
    }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "IMPORT_BATCH_STATE_CONFLICT" } });
  });
});
