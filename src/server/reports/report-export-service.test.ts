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
