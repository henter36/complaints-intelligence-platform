import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReportType } from "@prisma/client";

const dbMocks = vi.hoisted(() => ({
  templateCreate: vi.fn(),
  templateFindUnique: vi.fn(),
  templateUpdate: vi.fn(),
  runCount: vi.fn(),
  auditLogCreate: vi.fn(),
}));

const exportMocks = vi.hoisted(() => ({ runReport: vi.fn() }));

vi.mock("./report-export-service", () => ({
  runReport: exportMocks.runReport,
}));

vi.mock("@/lib/db", () => ({
  db: {
    reportTemplate: {
      create: dbMocks.templateCreate,
      findUnique: dbMocks.templateFindUnique,
      update: dbMocks.templateUpdate,
    },
    reportRun: {
      count: dbMocks.runCount,
    },
    auditLog: {
      create: dbMocks.auditLogCreate,
    },
  },
}));

describe("resolveTemplateRunFilters", () => {
  it("re-anchors a stored date span to end today, preserving its length", async () => {
    const { resolveTemplateRunFilters } = await import("./report-template-service");
    const now = new Date("2026-08-15T10:00:00Z"); // 13:00 Riyadh, still Aug 15 local
    const resolved = resolveTemplateRunFilters({ from: "2026-07-01", to: "2026-07-31" }, now);
    // span was 30 days; anchored to end "today" in Riyadh (2026-08-15)
    expect(resolved.to).toBe("2026-08-15");
    expect(resolved.from).toBe("2026-07-16");
  });

  it("preserves non-time scope filters unchanged", async () => {
    const { resolveTemplateRunFilters } = await import("./report-template-service");
    const resolved = resolveTemplateRunFilters(
      { from: "2026-07-01", to: "2026-07-31", region: "الرياض", department: "الدعم" },
      new Date("2026-08-15T10:00:00Z")
    );
    expect(resolved.region).toBe("الرياض");
    expect(resolved.department).toBe("الدعم");
  });
});

describe("report template mutation guards", () => {
  beforeEach(() => {
    dbMocks.templateCreate.mockReset();
    dbMocks.templateFindUnique.mockReset();
    dbMocks.templateUpdate.mockReset();
    dbMocks.runCount.mockReset();
    dbMocks.auditLogCreate.mockReset().mockResolvedValue({ id: "audit_1" });
    exportMocks.runReport.mockReset();
  });

  it("rejects an HTML-bearing template name", async () => {
    const { createReportTemplate, isReportTemplateError } = await import("./report-template-service");
    let caught: unknown;
    try {
      await createReportTemplate(
        {
          name: "<img src=x onerror=alert(1)>",
          reportType: ReportType.EXECUTIVE_SUMMARY,
          filters: { from: "2026-07-01", to: "2026-07-31" },
        },
        "admin"
      );
    } catch (error) {
      caught = error;
    }
    expect(isReportTemplateError(caught)).toBe(true);
    expect(dbMocks.templateCreate).not.toHaveBeenCalled();
  });

  it("locks reportType changes once the template has at least one run", async () => {
    dbMocks.templateFindUnique.mockResolvedValue({
      id: "tpl_1",
      name: "قالب",
      reportType: ReportType.EXECUTIVE_SUMMARY,
      filters: { from: "2026-07-01", to: "2026-07-31" },
      options: {},
      isActive: true,
      schedules: [],
    });
    dbMocks.runCount.mockResolvedValue(2);

    const { updateReportTemplate, isReportTemplateError } = await import("./report-template-service");
    let caught: unknown;
    try {
      await updateReportTemplate("tpl_1", { reportType: ReportType.OVERDUE_COMPLAINTS }, "admin");
    } catch (error) {
      caught = error;
    }
    expect(isReportTemplateError(caught)).toBe(true);
    if (isReportTemplateError(caught)) {
      expect(caught.code).toBe("REPORT_TEMPLATE_TYPE_LOCKED");
    }
    expect(dbMocks.templateUpdate).not.toHaveBeenCalled();
  });

  it("allows reportType changes when the template has never run", async () => {
    dbMocks.templateFindUnique.mockResolvedValue({
      id: "tpl_1",
      name: "قالب",
      reportType: ReportType.EXECUTIVE_SUMMARY,
      filters: { from: "2026-07-01", to: "2026-07-31" },
      options: {},
      isActive: true,
      schedules: [],
    });
    dbMocks.runCount.mockResolvedValue(0);
    dbMocks.templateUpdate.mockResolvedValue({ id: "tpl_1", reportType: ReportType.OVERDUE_COMPLAINTS });

    const { updateReportTemplate } = await import("./report-template-service");
    await updateReportTemplate("tpl_1", { reportType: ReportType.OVERDUE_COMPLAINTS }, "admin");
    expect(dbMocks.templateUpdate).toHaveBeenCalled();
  });

  it("throws REPORT_TEMPLATE_NOT_FOUND for a missing template id", async () => {
    dbMocks.templateFindUnique.mockResolvedValue(null);
    const { getReportTemplateOrThrow, isReportTemplateError } = await import("./report-template-service");
    let caught: unknown;
    try {
      await getReportTemplateOrThrow("missing");
    } catch (error) {
      caught = error;
    }
    expect(isReportTemplateError(caught)).toBe(true);
  });

  it("preserves report and comparison modes when running a saved template", async () => {
    dbMocks.templateFindUnique.mockResolvedValue({
      id: "tpl_mode",
      name: "قالب رقمي",
      reportType: ReportType.EXECUTIVE_SUMMARY,
      filters: { from: "2026-07-01", to: "2026-07-31" },
      options: {
        reportMode: "DIGITAL_EXECUTIVE_BRIEF",
        comparisonMode: "SAME_PERIOD_LAST_YEAR",
      },
      isActive: true,
      schedules: [],
    });
    exportMocks.runReport.mockResolvedValue({ status: "COMPLETED", artifacts: [], warnings: [] });
    const { runReportTemplate } = await import("./report-template-service");
    const scheduledFor = new Date("2026-08-02T06:00:00.000Z");
    await runReportTemplate("tpl_mode", "admin", { scheduledFor });
    expect(exportMocks.runReport).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          options: expect.objectContaining({
            reportMode: "DIGITAL_EXECUTIVE_BRIEF",
            comparisonMode: "SAME_PERIOD_LAST_YEAR",
          }),
        }),
        scheduledFor,
      }),
      expect.any(Date)
    );
  });
});
