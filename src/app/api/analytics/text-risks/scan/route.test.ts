import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { startScanMock, resumeScanMock } = vi.hoisted(() => ({
  startScanMock: vi.fn(),
  resumeScanMock: vi.fn(),
}));

vi.mock("@/server/auth/auth-guard", () => ({
  requireAdminApiSession: vi.fn().mockResolvedValue({}),
  mapAuthError: vi.fn().mockReturnValue(null),
}));
vi.mock("@/server/analytics/text-risk/text-risk-analysis-service", () => ({
  startTextRiskScan: startScanMock,
  resumeTextRiskScan: resumeScanMock,
}));

const SCAN_SUMMARY = { runId: "run-1", status: "COMPLETE", processed: 0, matched: 0 };

async function post(body: unknown) {
  const { POST } = await import("./route");
  return POST(
    new NextRequest("http://localhost/api/analytics/text-risks/scan", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    })
  );
}

describe("POST /api/analytics/text-risks/scan", () => {
  beforeEach(() => {
    startScanMock.mockResolvedValue(SCAN_SUMMARY);
    resumeScanMock.mockResolvedValue(SCAN_SUMMARY);
  });

  it("returns 202 for a new full scan (empty body)", async () => {
    const res = await post({});
    expect(res.status).toBe(202);
    expect(startScanMock).toHaveBeenCalledWith(expect.objectContaining({ importBatchId: undefined }));
  });

  it("returns 202 for a new scan with importBatchId", async () => {
    const res = await post({ importBatchId: "batch-abc" });
    expect(res.status).toBe(202);
    expect(startScanMock).toHaveBeenCalledWith(expect.objectContaining({ importBatchId: "batch-abc" }));
  });

  it("returns 202 for a resume scan", async () => {
    const res = await post({ resumeRunId: "run-1" });
    expect(res.status).toBe(202);
    expect(resumeScanMock).toHaveBeenCalledWith("run-1");
  });

  it("returns 400 when fullScan and importBatchId are combined", async () => {
    const res = await post({ fullScan: true, importBatchId: "batch-abc" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when resumeRunId and importBatchId are combined", async () => {
    const res = await post({ resumeRunId: "run-1", importBatchId: "batch-abc" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when resumeRunId and fullScan are combined", async () => {
    const res = await post({ resumeRunId: "run-1", fullScan: true });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the run is not found", async () => {
    resumeScanMock.mockRejectedValueOnce(new Error("SCAN_RUN_NOT_FOUND"));
    const res = await post({ resumeRunId: "nonexistent" });
    expect(res.status).toBe(404);
  });

  it("returns 409 when the run is not resumable", async () => {
    resumeScanMock.mockRejectedValueOnce(new Error("SCAN_RUN_NOT_RESUMABLE"));
    const res = await post({ resumeRunId: "run-1" });
    expect(res.status).toBe(409);
  });

  it("returns 409 when the batch is not confirmed", async () => {
    startScanMock.mockRejectedValueOnce(new Error("TEXT_RISK_SCAN_BATCH_NOT_CONFIRMED"));
    const res = await post({ importBatchId: "batch-unconfirmed" });
    expect(res.status).toBe(409);
  });

  it("returns 500 for unexpected errors", async () => {
    startScanMock.mockRejectedValueOnce(new Error("unexpected db failure"));
    const res = await post({});
    expect(res.status).toBe(500);
  });
});
