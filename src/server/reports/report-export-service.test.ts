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

describe("runReport orchestration", () => {
  beforeEach(() => {
    Object.values(dbMocks).forEach((m) => m.mockReset());
    dataMocks.buildReportData.mockReset();
    pdfMocks.renderReportPdf.mockReset();
    xlsxMocks.renderReportXlsx.mockReset();
    storageMocks.storeReportArtifact.mockReset();
    storageMocks.deleteReportArtifact.mockReset();
    dbMocks.auditLogCreate.mockResolvedValue({ id: "audit_1" });
  });

  it("creates a ReportRun, stores artifacts, and marks COMPLETED on success", async () => {
    dbMocks.runCreate.mockResolvedValue({ id: "run_1" });
    dataMocks.buildReportData.mockResolvedValue({
      type: ReportType.EXECUTIVE_SUMMARY, title: "t", generatedAt: new Date().toISOString(),
      period: { from: "2026-07-01", to: "2026-07-31" }, filters: VALID_FILTERS,
      kpis: {}, sections: [], warnings: [], rowCount: 5,
    });
    pdfMocks.renderReportPdf.mockResolvedValue({ buffer: Buffer.from("pdf"), warnings: [] });
    storageMocks.storeReportArtifact.mockResolvedValue({ storageKey: "abc.pdf", fileSize: 3, sha256: "hash" });
    dbMocks.artifactCreate.mockResolvedValue({ id: "art_1", format: ReportFormat.PDF, fileName: "x.pdf", fileSize: 3, sha256: "hash" });
    dbMocks.runUpdate.mockResolvedValue({ id: "run_1" });

    const { runReport } = await import("./report-export-service");
    const now = new Date("2026-08-01T00:00:00Z");
    const result = await runReport({ request: buildRequest(), formats: [ReportFormat.PDF], requestedBy: "admin" }, now);

    expect(result.status).toBe("COMPLETED");
    expect(result.artifacts).toHaveLength(1);
    expect(dbMocks.runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "run_1" }, data: expect.objectContaining({ status: "COMPLETED" }) })
    );

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

  it("marks FAILED, deletes partial artifacts, and returns a safe error without a stack trace on render failure", async () => {
    dbMocks.runCreate.mockResolvedValue({ id: "run_2" });
    dataMocks.buildReportData.mockResolvedValue({
      type: ReportType.EXECUTIVE_SUMMARY, title: "t", generatedAt: new Date().toISOString(),
      period: { from: "2026-07-01", to: "2026-07-31" }, filters: VALID_FILTERS,
      kpis: {}, sections: [], warnings: [], rowCount: 0,
    });
    pdfMocks.renderReportPdf.mockResolvedValue({ buffer: Buffer.from("pdf"), warnings: [] });
    storageMocks.storeReportArtifact.mockResolvedValue({ storageKey: "abc.pdf", fileSize: 3, sha256: "hash" });
    dbMocks.artifactCreate.mockResolvedValue({ id: "art_1", format: ReportFormat.PDF, fileName: "x.pdf", fileSize: 3, sha256: "hash" });
    dbMocks.artifactDeleteMany.mockResolvedValue({ count: 1 });
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

    // The PDF artifact that WAS stored before the XLSX failure must be cleaned up,
    // both the file on disk and the orphaned ReportArtifact row.
    expect(storageMocks.deleteReportArtifact).toHaveBeenCalledWith("abc.pdf");
    expect(dbMocks.artifactDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["art_1"] } } });

    const updateCall = dbMocks.runUpdate.mock.calls.find((c) => c[0].data.status === "FAILED");
    expect(updateCall).toBeDefined();
    expect(updateCall![0].data.errorMessage).not.toContain("boom");

    const auditActions = dbMocks.auditLogCreate.mock.calls.map((c) => c[0].data.action);
    expect(auditActions).toContain("REPORT_RUN_FAILED");
  });

  it("marks FAILED with the original errorCode when reportArtifact.deleteMany itself throws during cleanup", async () => {
    dbMocks.runCreate.mockResolvedValue({ id: "run_3" });
    dataMocks.buildReportData.mockResolvedValue({
      type: ReportType.EXECUTIVE_SUMMARY, title: "t", generatedAt: new Date().toISOString(),
      period: { from: "2026-07-01", to: "2026-07-31" }, filters: VALID_FILTERS,
      kpis: {}, sections: [], warnings: [], rowCount: 0,
    });
    pdfMocks.renderReportPdf.mockResolvedValue({ buffer: Buffer.from("pdf"), warnings: [] });
    storageMocks.storeReportArtifact.mockResolvedValue({ storageKey: "abc.pdf", fileSize: 3, sha256: "hash" });
    dbMocks.artifactCreate.mockResolvedValue({ id: "art_1", format: ReportFormat.PDF, fileName: "x.pdf", fileSize: 3, sha256: "hash" });
    storageMocks.deleteReportArtifact.mockResolvedValue(undefined);
    dbMocks.artifactDeleteMany.mockRejectedValue(new Error("db connection lost"));
    xlsxMocks.renderReportXlsx.mockRejectedValue(new Error("internal exceljs boom"));
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

    // The cleanup failure is captured as audit metadata, not silently dropped.
    const failedAudit = dbMocks.auditLogCreate.mock.calls.find((c) => c[0].data.action === "REPORT_RUN_FAILED");
    expect(failedAudit).toBeDefined();
    expect(failedAudit![0].data.metadata.cleanupFailures).toEqual([
      { step: "artifact_rows", message: "db connection lost" },
    ]);
  });

  it("still deletes rows and marks FAILED when file deletion fails but row deletion succeeds", async () => {
    dbMocks.runCreate.mockResolvedValue({ id: "run_4" });
    dataMocks.buildReportData.mockResolvedValue({
      type: ReportType.EXECUTIVE_SUMMARY, title: "t", generatedAt: new Date().toISOString(),
      period: { from: "2026-07-01", to: "2026-07-31" }, filters: VALID_FILTERS,
      kpis: {}, sections: [], warnings: [], rowCount: 0,
    });
    pdfMocks.renderReportPdf.mockResolvedValue({ buffer: Buffer.from("pdf"), warnings: [] });
    storageMocks.storeReportArtifact.mockResolvedValue({ storageKey: "abc.pdf", fileSize: 3, sha256: "hash" });
    dbMocks.artifactCreate.mockResolvedValue({ id: "art_1", format: ReportFormat.PDF, fileName: "x.pdf", fileSize: 3, sha256: "hash" });
    storageMocks.deleteReportArtifact.mockRejectedValue(new Error("ENOENT-like disk error"));
    dbMocks.artifactDeleteMany.mockResolvedValue({ count: 1 });
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
    // Row deletion still runs and succeeds even though file deletion failed.
    expect(dbMocks.artifactDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["art_1"] } } });
    const updateCall = dbMocks.runUpdate.mock.calls.find((c) => c[0].data.status === "FAILED");
    expect(updateCall).toBeDefined();
  });

  it("marks FAILED when both file deletion and row deletion fail", async () => {
    dbMocks.runCreate.mockResolvedValue({ id: "run_5" });
    dataMocks.buildReportData.mockResolvedValue({
      type: ReportType.EXECUTIVE_SUMMARY, title: "t", generatedAt: new Date().toISOString(),
      period: { from: "2026-07-01", to: "2026-07-31" }, filters: VALID_FILTERS,
      kpis: {}, sections: [], warnings: [], rowCount: 0,
    });
    pdfMocks.renderReportPdf.mockResolvedValue({ buffer: Buffer.from("pdf"), warnings: [] });
    storageMocks.storeReportArtifact.mockResolvedValue({ storageKey: "abc.pdf", fileSize: 3, sha256: "hash" });
    dbMocks.artifactCreate.mockResolvedValue({ id: "art_1", format: ReportFormat.PDF, fileName: "x.pdf", fileSize: 3, sha256: "hash" });
    storageMocks.deleteReportArtifact.mockRejectedValue(new Error("disk error"));
    dbMocks.artifactDeleteMany.mockRejectedValue(new Error("db error"));
    xlsxMocks.renderReportXlsx.mockRejectedValue(new Error("boom"));
    dbMocks.runUpdate.mockResolvedValue({ id: "run_5" });

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
    const updateCall = dbMocks.runUpdate.mock.calls.find((c) => c[0].data.status === "FAILED");
    expect(updateCall).toBeDefined();
    const statuses = dbMocks.runUpdate.mock.calls.map((c) => c[0].data.status);
    expect(statuses).not.toContain("COMPLETED");

    const failedAudit = dbMocks.auditLogCreate.mock.calls.find((c) => c[0].data.action === "REPORT_RUN_FAILED");
    expect(failedAudit![0].data.metadata.cleanupFailures).toEqual(
      expect.arrayContaining([
        { step: "artifact_files", message: "disk error" },
        { step: "artifact_rows", message: "db error" },
      ])
    );
  });

  it("throws a critical composite error without losing the original errorCode when the FAILED-state update itself fails", async () => {
    dbMocks.runCreate.mockResolvedValue({ id: "run_6" });
    dataMocks.buildReportData.mockResolvedValue({
      type: ReportType.EXECUTIVE_SUMMARY, title: "t", generatedAt: new Date().toISOString(),
      period: { from: "2026-07-01", to: "2026-07-31" }, filters: VALID_FILTERS,
      kpis: {}, sections: [], warnings: [], rowCount: 0,
    });
    pdfMocks.renderReportPdf.mockResolvedValue({ buffer: Buffer.from("pdf"), warnings: [] });
    storageMocks.storeReportArtifact.mockResolvedValue({ storageKey: "abc.pdf", fileSize: 3, sha256: "hash" });
    dbMocks.artifactCreate.mockResolvedValue({ id: "art_1", format: ReportFormat.PDF, fileName: "x.pdf", fileSize: 3, sha256: "hash" });
    storageMocks.deleteReportArtifact.mockResolvedValue(undefined);
    dbMocks.artifactDeleteMany.mockResolvedValue({ count: 1 });
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
      // The original error's classification must survive even though the
      // FAILED-state persistence itself failed.
      expect(caught.code).toBe("REPORT_GENERATION_FAILED");
      expect(caught.cause).toBeDefined();
    }
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Critical"),
      "run_6",
      expect.any(Error)
    );
    // No failure audit log can be written since the run row update failed first.
    const auditActions = dbMocks.auditLogCreate.mock.calls.map((c) => c[0].data.action);
    expect(auditActions).not.toContain("REPORT_RUN_FAILED");

    consoleErrorSpy.mockRestore();
  });

  it("never writes a REPORT_RUN_COMPLETED audit log after an export failure", async () => {
    dbMocks.runCreate.mockResolvedValue({ id: "run_7" });
    dataMocks.buildReportData.mockResolvedValue({
      type: ReportType.EXECUTIVE_SUMMARY, title: "t", generatedAt: new Date().toISOString(),
      period: { from: "2026-07-01", to: "2026-07-31" }, filters: VALID_FILTERS,
      kpis: {}, sections: [], warnings: [], rowCount: 0,
    });
    pdfMocks.renderReportPdf.mockRejectedValue(new Error("boom"));
    dbMocks.runUpdate.mockResolvedValue({ id: "run_7" });

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
    dbMocks.runCreate.mockResolvedValue({ id: "run_8" });
    dataMocks.buildReportData.mockRejectedValue(new Error("boom before render"));
    dbMocks.runUpdate.mockResolvedValue({ id: "run_8" });

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
