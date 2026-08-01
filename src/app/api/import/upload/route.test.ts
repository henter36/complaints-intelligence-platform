import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/auth-guard", () => ({
  requireAdminApiSession: vi.fn().mockResolvedValue({ id: "session_test", username: "admin" }),
  mapAuthError: vi.fn().mockReturnValue(null),
}));

const mocks = vi.hoisted(() => ({
  processUploadedImportFile: vi.fn(),
}));

vi.mock("@/server/imports/excel-import-service", () => ({
  processUploadedImportFile: mocks.processUploadedImportFile,
}));

beforeEach(() => {
  vi.resetModules();
  mocks.processUploadedImportFile.mockReset();
});

function formRequest(formData: FormData): NextRequest {
  return {
    url: "http://localhost/api/import/upload",
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === "content-type") return "multipart/form-data; boundary=vitest";
        if (name.toLowerCase() === "origin") return "http://localhost";
        if (name.toLowerCase() === "host") return "localhost";
        return null;
      },
    },
    formData: () => Promise.resolve(formData),
  } as unknown as NextRequest;
}

describe("import upload route", () => {
  it("rejects non multipart requests", async () => {
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("http://localhost/api/import/upload", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
        host: "localhost",
      },
      body: JSON.stringify({}),
    }));

    expect(response.status).toBe(415);
    expect(mocks.processUploadedImportFile).not.toHaveBeenCalled();
  });

  it("rejects missing or multiple files", async () => {
    const { POST } = await import("./route");
    const empty = new FormData();
    expect((await POST(formRequest(empty))).status).toBe(400);

    const multiple = new FormData();
    multiple.append("file", new File(["a"], "a.xlsx"));
    multiple.append("file", new File(["b"], "b.xlsx"));
    expect((await POST(formRequest(multiple))).status).toBe(400);
    expect(mocks.processUploadedImportFile).not.toHaveBeenCalled();
  });

  it("rejects unexpected fields", async () => {
    const { POST } = await import("./route");
    const formData = new FormData();
    formData.append("file", new File(["x"], "complaints.xlsx"));
    formData.append("entity", "old-prototype-field");

    const response = await POST(formRequest(formData));

    expect(response.status).toBe(400);
    expect(mocks.processUploadedImportFile).not.toHaveBeenCalled();
  });

  it("passes a single xlsx file to the import service", async () => {
    mocks.processUploadedImportFile.mockResolvedValue({
      batchId: "batch_1",
      status: "READY_FOR_CONFIRMATION",
    });
    const { POST } = await import("./route");
    const formData = new FormData();
    const file = new File(["PK\u0003\u0004"], "complaints.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    formData.append("file", file);
    formData.append("periodType", "monthly");

    const response = await POST(formRequest(formData));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.batchId).toBe("batch_1");
    expect(mocks.processUploadedImportFile).toHaveBeenCalledWith(expect.objectContaining({
      file,
      periodType: "monthly",
      actor: "admin",
    }));
  });

  it("returns direct resume and delete metadata for a duplicate active file", async () => {
    const { POST } = await import("./route");
    const { ImportValidationError } = await import("@/server/imports/import-errors");
    mocks.processUploadedImportFile.mockRejectedValue(new ImportValidationError(
      "IMPORT_FILE_ALREADY_EXISTS",
      "سبق رفع هذا الملف، ويمكنك استكمال الدفعة الحالية أو حذفها.",
      409,
      {
        existingBatchId: "batch_existing",
        existingBatchStatus: "READY_FOR_CONFIRMATION",
        canResume: true,
        canDelete: true,
      }
    ));
    const formData = new FormData();
    formData.append("file", new File(["PK\u0003\u0004"], "complaints.xlsx"));

    const response = await POST(formRequest(formData));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatchObject({
      code: "IMPORT_FILE_ALREADY_EXISTS",
      existingBatchId: "batch_existing",
      existingBatchStatus: "READY_FOR_CONFIRMATION",
      canResume: true,
      canDelete: true,
    });
  });
});
