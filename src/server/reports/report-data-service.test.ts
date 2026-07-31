import { ComplaintPriority, ComplaintStatus, ReportType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  count: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    complaint: {
      findMany: dbMocks.findMany,
      count: dbMocks.count,
    },
  },
}));

function complaint(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmp_1",
    externalId: "EXT-1",
    sourceReference: "SRC-1",
    status: ComplaintStatus.OPEN,
    priority: ComplaintPriority.HIGH,
    severity: ComplaintPriority.HIGH,
    complaintDate: new Date("2026-07-05T00:00:00Z"),
    receivedAt: new Date("2026-07-05T00:00:00Z"),
    dueDate: new Date("2026-07-01T00:00:00Z"),
    closedAt: null,
    firstActionAt: null,
    processingStartedAt: null,
    delayReason: null,
    isRepeated: false,
    isValidated: true,
    isPotentialDuplicate: false,
    beneficiarySatisfaction: null,
    region: "الرياض",
    facility: "المركز الرئيسي",
    department: "الدعم الفني",
    classificationId: "cls_1",
    categoryId: "cat_1",
    channel: "الهاتف",
    subject: "شكوى تجريبية",
    classification: { id: "cls_1", nameAr: "تصنيف", color: "#000" },
    category: { id: "cat_1", nameAr: "فئة" },
    statusHistory: [],
    version: 1,
    updatedAt: new Date("2026-07-05T00:00:00Z"),
    ...overrides,
  };
}

const VALID_FILTERS = { from: "2026-07-01", to: "2026-07-31" };

describe("report data service — parity with the central KPI service", () => {
  beforeEach(async () => {
    vi.resetModules();
    dbMocks.findMany.mockReset();
    dbMocks.count.mockReset();
  });

  it("EXECUTIVE_SUMMARY reuses getComplaintKpis verbatim (no independent formulas)", async () => {
    const complaints = [
      complaint({ id: "cmp_1", status: ComplaintStatus.OPEN }),
      complaint({ id: "cmp_2", status: ComplaintStatus.CLOSED, closedAt: new Date("2026-07-10T00:00:00Z") }),
    ];
    dbMocks.findMany.mockResolvedValue(complaints);
    dbMocks.count.mockResolvedValue(complaints.length);

    const { buildReportData } = await import("./report-data-service");
    const { getComplaintKpis } = await import("@/server/complaints/complaint-kpi-service");
    const { parseReportRequest, buildComplaintQueryParams } = await import("./report-definition-service");

    const request = parseReportRequest({ type: "EXECUTIVE_SUMMARY", filters: VALID_FILTERS });
    const now = new Date("2026-07-31T00:00:00Z");

    const directKpis = await getComplaintKpis(buildComplaintQueryParams(request.filters), now);
    const report = await buildReportData(request, "preview", now);

    // The report's headline KPI object must be identical to the central
    // service's output for the same filters — Dashboard/Analytics parity.
    expect(report.kpis).toEqual(directKpis.kpis);
  });

  it("EXECUTIVE_SUMMARY no longer emits a channel_distribution section", async () => {
    dbMocks.findMany.mockResolvedValue([complaint()]);
    dbMocks.count.mockResolvedValue(1);

    const { buildReportData } = await import("./report-data-service");
    const { parseReportRequest } = await import("./report-definition-service");

    const request = parseReportRequest({ type: "EXECUTIVE_SUMMARY", filters: VALID_FILTERS });
    const report = await buildReportData(request, "preview", new Date("2026-07-31T00:00:00Z"));

    const ids = report.sections.map((section) => section.id);
    expect(ids).not.toContain("channel_distribution");
    expect(ids).toContain("region_trend_chart");
    expect(ids).toContain("region_changes");
    expect(ids).toContain("dept_class_rises");
    // Comparison data is threaded through for the XLSX/PDF renderers.
    expect(report.comparisonData).toBeDefined();
  });

  it("DEPARTMENT_PERFORMANCE group breakdown matches getComplaintKpis distributions.byDepartment", async () => {
    const complaints = [
      complaint({ id: "cmp_1", department: "الدعم الفني" }),
      complaint({ id: "cmp_2", department: "الدعم الفني", status: ComplaintStatus.CLOSED, closedAt: new Date("2026-07-15T00:00:00Z") }),
      complaint({ id: "cmp_3", department: "الموارد البشرية" }),
    ];
    dbMocks.findMany.mockResolvedValue(complaints);
    dbMocks.count.mockResolvedValue(complaints.length);

    const { buildReportData } = await import("./report-data-service");
    const { getComplaintKpis } = await import("@/server/complaints/complaint-kpi-service");
    const { parseReportRequest, buildComplaintQueryParams } = await import("./report-definition-service");

    const request = parseReportRequest({ type: "DEPARTMENT_PERFORMANCE", filters: VALID_FILTERS });
    const now = new Date("2026-07-31T00:00:00Z");

    const direct = await getComplaintKpis(buildComplaintQueryParams(request.filters), now);
    const report = await buildReportData(request, "preview", now);

    const table = report.sections.find((s) => s.id === "group_breakdown");
    expect(table?.kind).toBe("table");
    if (table?.kind === "table") {
      expect(table.table.rows).toEqual(direct.distributions.byDepartment);
    }
  });
});

describe("report data service — row limits", () => {
  beforeEach(() => {
    vi.resetModules();
    dbMocks.findMany.mockReset();
    dbMocks.count.mockReset();
  });

  it("rejects COMPLAINT_DETAIL run when matched rows exceed the report's hard limit", async () => {
    dbMocks.findMany.mockResolvedValue([complaint()]);
    dbMocks.count.mockResolvedValue(10_001); // exceeds COMPLAINT_DETAIL maxRows (10,000)

    const { buildReportData, isReportRowLimitExceededError } = await import("./report-data-service");
    const { parseReportRequest } = await import("./report-definition-service");

    const request = parseReportRequest({ type: "COMPLAINT_DETAIL", filters: VALID_FILTERS });

    let caught: unknown;
    try {
      await buildReportData(request, "run", new Date("2026-07-31T00:00:00Z"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(isReportRowLimitExceededError(caught)).toBe(true);
  });

  it("truncates (does not reject) in preview mode and reports a warning instead", async () => {
    dbMocks.findMany.mockResolvedValue([complaint()]);
    dbMocks.count.mockResolvedValue(10_001);

    const { buildReportData } = await import("./report-data-service");
    const { parseReportRequest } = await import("./report-definition-service");

    const request = parseReportRequest({ type: "COMPLAINT_DETAIL", filters: VALID_FILTERS });
    const report = await buildReportData(request, "preview", new Date("2026-07-31T00:00:00Z"));

    expect(report.warnings.length).toBeGreaterThan(0);
  });

  it("does not include complainant PII fields in COMPLAINT_DETAIL rows", async () => {
    dbMocks.findMany.mockResolvedValue([complaint()]);
    dbMocks.count.mockResolvedValue(1);

    const { buildReportData } = await import("./report-data-service");
    const { parseReportRequest } = await import("./report-definition-service");

    const request = parseReportRequest({ type: "COMPLAINT_DETAIL", filters: VALID_FILTERS });
    const report = await buildReportData(request, "preview", new Date("2026-07-31T00:00:00Z"));

    const detailTable = report.sections.find((s) => s.id === "detail_table");
    expect(detailTable?.kind).toBe("table");
    if (detailTable?.kind === "table") {
      const columnKeys = detailTable.table.columns.map((c) => c.key);
      expect(columnKeys).not.toContain("complainantName");
      expect(columnKeys).not.toContain("complainantPhone");
      expect(columnKeys).not.toContain("complainantIdentifier");
      for (const row of detailTable.table.rows) {
        expect(row).not.toHaveProperty("complainantName");
        expect(row).not.toHaveProperty("complainantPhone");
      }
    }
  });
});

describe("report data service — OVERDUE_COMPLAINTS", () => {
  beforeEach(() => {
    vi.resetModules();
    dbMocks.findMany.mockReset();
    dbMocks.count.mockReset();
  });

  it("forces isLate=true regardless of caller filters", async () => {
    dbMocks.findMany.mockResolvedValue([]);
    dbMocks.count.mockResolvedValue(0);

    const { buildReportData } = await import("./report-data-service");
    const { parseReportRequest } = await import("./report-definition-service");

    const request = parseReportRequest({ type: "OVERDUE_COMPLAINTS", filters: VALID_FILTERS });
    await buildReportData(request, "preview", new Date("2026-07-31T00:00:00Z"));

    // Among the findMany calls (one for the KPI aggregation, one for the
    // overdue detail table), at least one must carry the isLate=true where
    // clause (dueDate < now AND status in the open-status set) that
    // complaint-query-service.ts's applyBooleanFilters produces for
    // isLate=true — proving the report actually constrains to late
    // complaints rather than just calling the DB layer with any filter.
    const isLateWhereApplied = dbMocks.findMany.mock.calls.some(([args]) => {
      const andClauses: unknown[] = Array.isArray(args?.where?.AND) ? args.where.AND : [];
      return andClauses.some(
        (clause: any) => clause?.dueDate?.lt !== undefined && Array.isArray(clause?.status?.in)
      );
    });
    expect(isLateWhereApplied).toBe(true);
  });
});
