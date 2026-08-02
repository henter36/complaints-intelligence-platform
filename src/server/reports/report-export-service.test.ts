import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReportFormat, ReportType } from "@prisma/client";

const dbMocks = vi.hoisted(() => ({
  runCreate: vi.fn(),
  runUpdate: vi.fn(),
  artifactCreate: vi.fn(),
  artifactDeleteMany: vi.fn(),
  templateUpdate: vi.fn(),
  auditLogCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    reportRun: { create: dbMocks.runCreate, update: dbMocks.runUpdate },
    reportArtifact: { create: dbMocks.artifactCreate, deleteMany: dbMocks.artifactDeleteMany },
    reportTemplate: { update: dbMocks.templateUpdate },
    auditLog: { create: dbMocks.auditLogCreate },
  },
}));

vi.mock("@/lib/env", () => ({
  env: { reportRetentionDays: 90, reportMaxFileSizeMb: 25, reportStoragePath: "./storage/reports" },
}));

const dataMocks = vi.hoisted(() => ({ buildReportData: vi.fn() }));
vi.mock("./report-data-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./report-data-service")>();
  return { ...actual, buildReportData: dataMocks.buildReportData };
});

const pdfMocks = vi.hoisted(() => ({ renderReportPdf: vi.fn() }));
vi.mock("./report-pdf-service", () => ({ renderReportPdf: pdfMocks.renderReportPdf }));

const xlsxMocks = vi.hoisted(() => ({ renderReportXlsx: vi.fn() }));
vi.mock("./report-xlsx-service", () => ({ renderReportXlsx: xlsxMocks.renderReportXlsx }));

const storageMocks = vi.hoisted(() => ({
  storeReportArtifact: vi.fn(),
  deleteReportArtifact: vi.fn(),
}));
vi.mock("./report-storage", () => ({
  storeReportArtifact: storageMocks.storeReportArtifact,
  deleteReportArtifact: storageMocks.deleteReportArtifact,
}));

const VALID_FILTERS = { from: "2026-07-01", to: "2026-07-31" };

function buildRequest() {
  return {
    type: ReportType.EXECUTIVE_SUMMARY,
    filters: VALID_FILTERS,
    options: { includeComparison: false, includeCharts: false, includeDetailedRows: false, includeSensitiveFields: false as const },
  };
}

function reportData(overrides: Record<string, unknown> = {}) {
  return {
    type: ReportType.EXECUTIVE_SUMMARY,
    title: "t",
    generatedAt: new Date().toISOString(),
    period: { from: "2026-07-01", to: "2026-07-31" },
    filters: VALID_FILTERS,
    kpis: {},
    sections: [],
    warnings: [],
    rowCount: 0,
    ...overrides,
  };
}

describe("runReport orchestration", () => {
  beforeEach(() => {
    Object.values(dbMocks).forEach((m) => m.mockReset());
    dataMocks.buildReportData.mockReset();
    pdfMocks.renderReportPdf.mockReset();
    xlsxMocks.renderReportXlsx.mockReset();
    storageMocks.storeReportArtifact.mockReset();
    storageMocks.deleteReportArtifact.mockReset().mockResolvedValue({ deleted: true });
    dbMocks.auditLogCreate.mockResolvedValue({ id: "audit_1" });
    dbMocks.artifactDeleteMany.mockResolvedValue({ count: 1 });
  });

  it("creates a ReportRun, stores artifacts, and marks COMPLETED on success", async () => {
    dbMocks.runCreate.mockResolvedValue({ id: "run_1" });
    dataMocks.buildReportData.mockResolvedValue(reportData({ rowCount: 5 }));
    pdfMocks.renderReportPdf.mockResolvedValue({ buffer: Buffer.from("pdf"), warnings: [] });
    storageMocks.storeReportArtifact.mockResolvedValue({ storageKey: "abc.pdf", fileSize: 3, sha256: "hash" });
    dbMocks.artifactCreate.mockResolvedValue({ id: "art_1", format: ReportFormat.PDF, fileName: "x.pdf", fileSize: 3, sha256: "hash" });
    dbMocks.runUpdate.mockResolvedValue({ id: "run_1" });

    const { runReport } = await import("./report-export-service");
    const now = new Date("2026-08-01T00:00:00Z");
    const request = {
      ...buildRequest(),
      options: { ...buildRequest().options, reportMode: "DIGITAL_EXECUTIVE_BRIEF" as const },
    };
    const result = await runReport({ request, formats: [ReportFormat.PDF], requestedBy: "admin" }, now);

    expect(result.status).toBe("COMPLETED");
    expect(result.artifacts).toHaveLength(1);
    expect(dbMocks.runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "run_1" }, data: expect.objectContaining({ status: "COMPLETED" }) })
    );
    expect(dbMocks.runCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        optionsSnapshot: expect.objectContaining({ reportMode: "DIGITAL_EXECUTIVE_BRIEF" }),
      }),
    }));

    // Retention: expiresAt must be exactly reportRetentionDays (90) after `now`.
    const artifactCreateArgs = dbMocks.artifactCreate.mock.calls[0][0];
    const expiresAt: Date = artifactCreateArgs.data.expiresAt;
    const expectedExpiry = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    expect(expiresAt.getTime()).toBe(expectedExpiry.getTime());

    // Audit trail.
    const auditActions = dbMocks.auditLogCreate.mock.calls.map((c) => c[0].data.action);
    expect(auditActions).toContain("REPORT_RUN_STARTED");
    expect(auditActions).toContain("REPORT_RUN_COMPLETED");
  });

  it("scenario 1: file deletion succeeds -> the artifact row is deleted and nothing is retained", async () => {
    dbMocks.runCreate.mockResolvedValue({ id: "run_2" });
    dataMocks.buildReportData.mockResolvedValue(reportData());
    pdfMocks.renderReportPdf.mockResolvedValue({ buffer: Buffer.from("pdf"), warnings: [] });
    storageMocks.storeReportArtifact.mockResolvedValue({ storageKey: "abc.pdf", fileSize: 3, sha256: "hash" });
    dbMocks.artifactCreate.mockResolvedValue({ id: "art_1", format: ReportFormat.PDF, fileName: "x.pdf", fileSize: 3, sha256: "hash" });
    storageMocks.deleteReportArtifact.mockResolvedValue({ deleted: true });
    xlsxMocks.renderReportXlsx.mockRejectedValue(new Error("internal exceljs boom with a stack trace"));
    dbMocks.runUpdate.mockResolvedValue({ id: "run_2" });

    const { runReport, isReportRunError } = await import("./report-export-service");
    let caught: unknown;
    try {
      await runReport(
        { request: buildRequest(), formats: [ReportFormat.PDF, ReportFormat.XLSX], requestedBy: "admin" },
        new Date("2026-08-01T00:00:00Z")
      );
    } catch (error) {
      caught = error;
    }

    expect(isReportRunError(caught)).toBe(true);
    if (isReportRunError(caught)) {
      expect(caught.message).not.toContain("boom");
      expect(caught.code).toBe("REPORT_GENERATION_FAILED");
    }

    // The PDF artifact that WAS stored before the XLSX failure must be cleaned
    // up: file deleted, then (and only then) its row deleted individually.
    expect(storageMocks.deleteReportArtifact).toHaveBeenCalledWith("abc.pdf");
    expect(dbMocks.artifactDeleteMany).toHaveBeenCalledWith({ where: { id: "art_1" } });

    const updateCall = dbMocks.runUpdate.mock.calls.find((c) => c[0].data.status === "FAILED");
    expect(updateCall).toBeDefined();
    expect(updateCall![0].data.errorMessage).not.toContain("boom");

    const failedAudit = dbMocks.auditLogCreate.mock.calls.find((c) => c[0].data.action === "REPORT_RUN_FAILED");
    expect(failedAudit).toBeDefined();
    expect(failedAudit![0].data.metadata.deletedArtifactIds).toEqual(["art_1"]);
    expect(failedAudit![0].data.metadata.retainedArtifactIds).toEqual([]);
  });

  it("scenario 2: a missing file (ENOENT, folded into deleted:true by the storage layer) is treated as success and the row is deleted", async () => {
    dbMocks.runCreate.mockResolvedValue({ id: "run_3" });
    dataMocks.buildReportData.mockResolvedValue(reportData());
    pdfMocks.renderReportPdf.mockResolvedValue({ buffer: Buffer.from("pdf"), warnings: [] });
    storageMocks.storeReportArtifact.mockResolvedValue({ storageKey: "abc.pdf", fileSize: 3, sha256: "hash" });
    dbMocks.artifactCreate.mockResolvedValue({ id: "art_1", format: ReportFormat.PDF, fileName: "x.pdf", fileSize: 3, sha256: "hash" });
    storageMocks.deleteReportArtifact.mockResolvedValue({ deleted: true }); // report-storage folds ENOENT into success
    xlsxMocks.renderReportXlsx.mockRejectedValue(new Error("boom"));
    dbMocks.runUpdate.mockResolvedValue({ id: "run_3" });

    const { runReport, isReportRunError } = await import("./report-export-service");
    let caught: unknown;
    try {
      await runReport(
        { request: buildRequest(), formats: [ReportFormat.PDF, ReportFormat.XLSX], requestedBy: "admin" },
        new Date("2026-08-01T00:00:00Z")
      );
    } catch (error) {
      caught = error;
    }

    expect(isReportRunError(caught)).toBe(true);
    expect(dbMocks.artifactDeleteMany).toHaveBeenCalledWith({ where: { id: "art_1" } });
    const failedAudit = dbMocks.auditLogCreate.mock.calls.find((c) => c[0].data.action === "REPORT_RUN_FAILED");
    expect(failedAudit![0].data.metadata.deletedArtifactIds).toEqual(["art_1"]);
  });

  it("scenario 3: file deletion fails -> the row is retained (never deleted), a cleanup failure is recorded, and the run still becomes FAILED", async () => {
    dbMocks.runCreate.mockResolvedValue({ id: "run_4" });
    dataMocks.buildReportData.mockResolvedValue(reportData());
    pdfMocks.renderReportPdf.mockResolvedValue({ buffer: Buffer.from("pdf"), warnings: [] });
    storageMocks.storeReportArtifact.mockResolvedValue({ storageKey: "abc.pdf", fileSize: 3, sha256: "hash" });
    dbMocks.artifactCreate.mockResolvedValue({ id: "art_1", format: ReportFormat.PDF, fileName: "x.pdf", fileSize: 3, sha256: "hash" });
    storageMocks.deleteReportArtifact.mockResolvedValue({
      deleted: false,
      reason: "DELETE_FAILED",
      error: new Error("disk unavailable"),
    });
    xlsxMocks.renderReportXlsx.mockRejectedValue(new Error("boom"));
    dbMocks.runUpdate.mockResolvedValue({ id: "run_4" });

    const { runReport, isReportRunError } = await import("./report-export-service");
    let caught: unknown;
    try {
      await runReport(
        { request: buildRequest(), formats: [ReportFormat.PDF, ReportFormat.XLSX], requestedBy: "admin" },
        new Date("2026-08-01T00:00:00Z")
      );
    } catch (error) {
      caught = error;
    }

    expect(isReportRunError(caught)).toBe(true);
    // The row must survive: no deleteMany call for an artifact whose file
    // deletion was not confirmed.
    expect(dbMocks.artifactDeleteMany).not.toHaveBeenCalled();

    const updateCall = dbMocks.runUpdate.mock.calls.find((c) => c[0].data.status === "FAILED");
    expect(updateCall).toBeDefined();

    const failedAudit = dbMocks.auditLogCreate.mock.calls.find((c) => c[0].data.action === "REPORT_RUN_FAILED");
    expect(failedAudit![0].data.metadata.retainedArtifactIds).toEqual(["art_1"]);
    expect(failedAudit![0].data.metadata.deletedArtifactIds).toEqual([]);
    expect(failedAudit![0].data.metadata.cleanupFailures).toEqual([
      { artifactId: "art_1", step: "artifact_file", message: "disk unavailable" },
    ]);
  });

  it("scenario 4: first artifact's file deletion succeeds and the second fails -> only the first row is deleted, the second is retained", async () => {
    dbMocks.runCreate.mockResolvedValue({ id: "run_5" });
    dataMocks.buildReportData.mockResolvedValue(reportData());
    pdfMocks.renderReportPdf.mockResolvedValue({ buffer: Buffer.from("pdf"), warnings: [] });
    xlsxMocks.renderReportXlsx.mockResolvedValue({ buffer: Buffer.from("xlsx"), warnings: [] });
    storageMocks.storeReportArtifact
      .mockResolvedValueOnce({ storageKey: "one.pdf", fileSize: 3, sha256: "hash1" })
      .mockResolvedValueOnce({ storageKey: "two.xlsx", fileSize: 3, sha256: "hash2" });
    dbMocks.artifactCreate
      .mockResolvedValueOnce({ id: "art_1", format: ReportFormat.PDF, fileName: "one.pdf", fileSize: 3, sha256: "hash1" })
      .mockResolvedValueOnce({ id: "art_2", format: ReportFormat.XLSX, fileName: "two.xlsx", fileSize: 3, sha256: "hash2" });
    storageMocks.deleteReportArtifact.mockImplementation(async (key: string) =>
      key === "one.pdf" ? { deleted: true } : { deleted: false, reason: "DELETE_FAILED", error: new Error("locked") }
    );
    // Both renders succeed and both artifacts get created; the export only
    // fails when marking the run COMPLETED, so cleanup runs against both.
    let updateCallCount = 0;
    dbMocks.runUpdate.mockImplementation(async () => {
      updateCallCount += 1;
      if (updateCallCount === 1) throw new Error("completion update failed");
      return { id: "run_5" };
    });

    const { runReport, isReportRunError } = await import("./report-export-service");
    let caught: unknown;
    try {
      await runReport(
        { request: buildRequest(), formats: [ReportFormat.PDF, ReportFormat.XLSX], requestedBy: "admin" },
        new Date("2026-08-01T00:00:00Z")
      );
    } catch (error) {
      caught = error;
    }

    expect(isReportRunError(caught)).toBe(true);
    expect(dbMocks.artifactDeleteMany).toHaveBeenCalledWith({ where: { id: "art_1" } });
    expect(dbMocks.artifactDeleteMany).not.toHaveBeenCalledWith({ where: { id: "art_2" } });

    const failedAudit = dbMocks.auditLogCreate.mock.calls.find((c) => c[0].data.action === "REPORT_RUN_FAILED");
    expect(failedAudit![0].data.metadata.deletedArtifactIds).toEqual(["art_1"]);
    expect(failedAudit![0].data.metadata.retainedArtifactIds).toEqual(["art_2"]);
  });

  it("scenario 5: file deletion succeeds but the row deletion itself fails -> recorded as an artifact_row failure and the row stays discoverable", async () => {
    dbMocks.runCreate.mockResolvedValue({ id: "run_6" });
    dataMocks.buildReportData.mockResolvedValue(reportData());
    pdfMocks.renderReportPdf.mockResolvedValue({ buffer: Buffer.from("pdf"), warnings: [] });
    storageMocks.storeReportArtifact.mockResolvedValue({ storageKey: "abc.pdf", fileSize: 3, sha256: "hash" });
    dbMocks.artifactCreate.mockResolvedValue({ id: "art_1", format: ReportFormat.PDF, fileName: "x.pdf", fileSize: 3, sha256: "hash" });
    storageMocks.deleteReportArtifact.mockResolvedValue({ deleted: true });
    dbMocks.artifactDeleteMany.mockRejectedValue(new Error("db connection lost"));
    xlsxMocks.renderReportXlsx.mockRejectedValue(new Error("internal exceljs boom"));
    dbMocks.runUpdate.mockResolvedValue({ id: "run_6" });

    const { runReport, isReportRunError } = await import("./report-export-service");
    let caught: unknown;
    try {
      await runReport(
        { request: buildRequest(), formats: [ReportFormat.PDF, ReportFormat.XLSX], requestedBy: "admin" },
        new Date("2026-08-01T00:00:00Z")
      );
    } catch (error) {
      caught = error;
    }

    // The original export error must still be classified and preserved, even
    // though the row-deletion cleanup step itself rejected.
    expect(isReportRunError(caught)).toBe(true);
    if (isReportRunError(caught)) {
      expect(caught.code).toBe("REPORT_GENERATION_FAILED");
      expect(caught.message).not.toContain("boom");
    }

    const updateCall = dbMocks.runUpdate.mock.calls.find((c) => c[0].data.status === "FAILED");
    expect(updateCall).toBeDefined();
    expect(updateCall![0].data.errorCode).toBe("REPORT_GENERATION_FAILED");

    // The run must never be left RUNNING or become COMPLETED.
    const statuses = dbMocks.runUpdate.mock.calls.map((c) => c[0].data.status);
    expect(statuses).not.toContain("COMPLETED");
    expect(statuses).toContain("FAILED");

    // The row is retained (undiscoverable file deletion never happened for the DB),
    // so it remains queryable/retryable by the retention job.
    const failedAudit = dbMocks.auditLogCreate.mock.calls.find((c) => c[0].data.action === "REPORT_RUN_FAILED");
    expect(failedAudit).toBeDefined();
    expect(failedAudit![0].data.metadata.retainedArtifactIds).toEqual(["art_1"]);
    expect(failedAudit![0].data.metadata.cleanupFailures).toEqual([
      { artifactId: "art_1", step: "artifact_row", message: "db connection lost" },
    ]);
  });

  it("scenario 6: every file deletion fails -> no bulk deleteMany happens, every row is retained, and the run still becomes FAILED", async () => {
    dbMocks.runCreate.mockResolvedValue({ id: "run_7" });
    dataMocks.buildReportData.mockResolvedValue(reportData());
    pdfMocks.renderReportPdf.mockResolvedValue({ buffer: Buffer.from("pdf"), warnings: [] });
    storageMocks.storeReportArtifact.mockResolvedValue({ storageKey: "abc.pdf", fileSize: 3, sha256: "hash" });
    dbMocks.artifactCreate.mockResolvedValue({ id: "art_1", format: ReportFormat.PDF, fileName: "x.pdf", fileSize: 3, sha256: "hash" });
    storageMocks.deleteReportArtifact.mockResolvedValue({
      deleted: false,
      reason: "DELETE_FAILED",
      error: new Error("disk error"),
    });
    xlsxMocks.renderReportXlsx.mockRejectedValue(new Error("boom"));
    dbMocks.runUpdate.mockResolvedValue({ id: "run_7" });

    const { runReport, isReportRunError } = await import("./report-export-service");
    let caught: unknown;
    try {
      await runReport(
        { request: buildRequest(), formats: [ReportFormat.PDF, ReportFormat.XLSX], requestedBy: "admin" },
        new Date("2026-08-01T00:00:00Z")
      );
    } catch (error) {
      caught = error;
    }

    expect(isReportRunError(caught)).toBe(true);
    // No indiscriminate bulk deletion of rows whose files were never confirmed deleted.
    expect(dbMocks.artifactDeleteMany).not.toHaveBeenCalled();

    const updateCall = dbMocks.runUpdate.mock.calls.find((c) => c[0].data.status === "FAILED");
    expect(updateCall).toBeDefined();
    const statuses = dbMocks.runUpdate.mock.calls.map((c) => c[0].data.status);
    expect(statuses).not.toContain("COMPLETED");

    const failedAudit = dbMocks.auditLogCreate.mock.calls.find((c) => c[0].data.action === "REPORT_RUN_FAILED");
    expect(failedAudit![0].data.metadata.retainedArtifactIds).toEqual(["art_1"]);
  });

  it("scenario 7/8: a critical composite error is thrown without losing the original errorCode when the FAILED-state update itself fails; cleanup errors never replace it", async () => {
    dbMocks.runCreate.mockResolvedValue({ id: "run_8" });
    dataMocks.buildReportData.mockResolvedValue(reportData());
    pdfMocks.renderReportPdf.mockResolvedValue({ buffer: Buffer.from("pdf"), warnings: [] });
    storageMocks.storeReportArtifact.mockResolvedValue({ storageKey: "abc.pdf", fileSize: 3, sha256: "hash" });
    dbMocks.artifactCreate.mockResolvedValue({ id: "art_1", format: ReportFormat.PDF, fileName: "x.pdf", fileSize: 3, sha256: "hash" });
    storageMocks.deleteReportArtifact.mockResolvedValue({ deleted: true });
    xlsxMocks.renderReportXlsx.mockRejectedValue(new Error("boom"));
    dbMocks.runUpdate.mockRejectedValue(new Error("db unreachable"));

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { runReport, isReportRunError } = await import("./report-export-service");
    let caught: unknown;
    try {
      await runReport(
        { request: buildRequest(), formats: [ReportFormat.PDF, ReportFormat.XLSX], requestedBy: "admin" },
        new Date("2026-08-01T00:00:00Z")
      );
    } catch (error) {
      caught = error;
    }

    expect(isReportRunError(caught)).toBe(true);
    if (isReportRunError(caught)) {
      expect(caught.code).toBe("REPORT_GENERATION_FAILED");
      expect(caught.cause).toBeDefined();
    }
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Critical"), "run_8", expect.any(Error));
    // No failure audit log can be written since the run row update failed first.
    const auditActions = dbMocks.auditLogCreate.mock.calls.map((c) => c[0].data.action);
    expect(auditActions).not.toContain("REPORT_RUN_FAILED");

    consoleErrorSpy.mockRestore();
  });

  it("never writes a REPORT_RUN_COMPLETED audit log after an export failure", async () => {
    dbMocks.runCreate.mockResolvedValue({ id: "run_9" });
    dataMocks.buildReportData.mockResolvedValue(reportData());
    pdfMocks.renderReportPdf.mockRejectedValue(new Error("boom"));
    dbMocks.runUpdate.mockResolvedValue({ id: "run_9" });

    const { runReport, isReportRunError } = await import("./report-export-service");
    let caught: unknown;
    try {
      await runReport({ request: buildRequest(), formats: [ReportFormat.PDF], requestedBy: "admin" }, new Date("2026-08-01T00:00:00Z"));
    } catch (error) {
      caught = error;
    }

    expect(isReportRunError(caught)).toBe(true);
    const auditActions = dbMocks.auditLogCreate.mock.calls.map((c) => c[0].data.action);
    expect(auditActions).not.toContain("REPORT_RUN_COMPLETED");
    expect(auditActions).toContain("REPORT_RUN_FAILED");
  });

  it("does not attempt any cleanup when the export fails before any artifact is created", async () => {
    dbMocks.runCreate.mockResolvedValue({ id: "run_10" });
    dataMocks.buildReportData.mockRejectedValue(new Error("boom before render"));
    dbMocks.runUpdate.mockResolvedValue({ id: "run_10" });

    const { runReport, isReportRunError } = await import("./report-export-service");
    let caught: unknown;
    try {
      await runReport({ request: buildRequest(), formats: [ReportFormat.PDF], requestedBy: "admin" }, new Date("2026-08-01T00:00:00Z"));
    } catch (error) {
      caught = error;
    }

    expect(isReportRunError(caught)).toBe(true);
    expect(storageMocks.deleteReportArtifact).not.toHaveBeenCalled();
    expect(dbMocks.artifactDeleteMany).not.toHaveBeenCalled();

    const updateCall = dbMocks.runUpdate.mock.calls.find((c) => c[0].data.status === "FAILED");
    expect(updateCall).toBeDefined();
  });

  it("rejects a PDF export request for a report type that does not support PDF", async () => {
    const { runReport, isReportRunError } = await import("./report-export-service");
    let caught: unknown;
    try {
      await runReport({
        request: { type: ReportType.COMPLAINT_DETAIL, filters: VALID_FILTERS, options: buildRequest().options },
        formats: [ReportFormat.PDF],
        requestedBy: "admin",
      });
    } catch (error) {
      caught = error;
    }
    expect(isReportRunError(caught)).toBe(true);
    if (isReportRunError(caught)) expect(caught.code).toBe("REPORT_FORMAT_UNSUPPORTED");
    expect(dbMocks.runCreate).not.toHaveBeenCalled();
  });
});
