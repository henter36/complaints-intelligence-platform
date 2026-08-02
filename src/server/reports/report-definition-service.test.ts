import { describe, expect, it } from "vitest";
import { ReportType } from "@prisma/client";
import {
  getReportDefinition,
  isReportRequestValidationError,
  listReportDefinitions,
  parseReportRequest,
  REPORT_DEFINITIONS,
  reportOptionsSchema,
} from "./report-definition-service";

const VALID_FILTERS = { from: "2026-07-01", to: "2026-07-31" };

describe("report definitions", () => {
  it("defines all six report types with export capability metadata", () => {
    const types = listReportDefinitions().map((d) => d.type).sort();
    expect(types).toEqual(
      [
        "CLASSIFICATION_ANALYSIS",
        "COMPLAINT_DETAIL",
        "DEPARTMENT_PERFORMANCE",
        "EXECUTIVE_SUMMARY",
        "OVERDUE_COMPLAINTS",
        "REGION_FACILITY_PERFORMANCE",
      ].sort()
    );
    for (const definition of listReportDefinitions()) {
      expect(definition.supportsPdf || definition.supportsXlsx).toBe(true);
      expect(definition.maxRows).toBeGreaterThan(0);
      expect(definition.requiresPeriod).toBe(true);
    }
  });

  it("caps COMPLAINT_DETAIL at 10,000 rows and disables PDF export", () => {
    const detail = getReportDefinition(ReportType.COMPLAINT_DETAIL);
    expect(detail.maxRows).toBe(10_000);
    expect(detail.supportsPdf).toBe(false);
    expect(detail.supportsXlsx).toBe(true);
  });
});

describe("reportOptionsSchema — reportMode field", () => {
  it.each([
    "STANDARD",
    "DIGITAL_EXECUTIVE_BRIEF",
    "FULL_ANALYTICAL",
    "PRINT_EXECUTIVE_BRIEF",
  ] as const)("accepts %s", (reportMode) => {
    expect(reportOptionsSchema.safeParse({ reportMode }).success).toBe(true);
  });

  it("rejects an invalid reportMode value", () => {
    expect(reportOptionsSchema.safeParse({ reportMode: "INVALID_MODE" }).success).toBe(false);
  });

  it("allows reportMode to be absent", () => {
    const result = reportOptionsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reportMode).toBeUndefined();
  });

  it("treats an absent executive reportMode as STANDARD", () => {
    const request = parseReportRequest({
      type: "EXECUTIVE_SUMMARY",
      filters: VALID_FILTERS,
    });
    expect(request.options.reportMode).toBe("STANDARD");
  });

  it("resets an unsupported hidden mode on non-executive reports", () => {
    const request = parseReportRequest({
      type: "DEPARTMENT_PERFORMANCE",
      filters: VALID_FILTERS,
      options: { reportMode: "DIGITAL_EXECUTIVE_BRIEF" },
    });
    expect(request.options.reportMode).toBe("STANDARD");
  });
});

describe("reportOptionsSchema — comparisonMode field", () => {
  it.each([
    "PREVIOUS_EQUIVALENT_PERIOD",
    "SAME_PERIOD_LAST_YEAR",
  ] as const)("accepts %s", (comparisonMode) => {
    const request = parseReportRequest({
      type: "EXECUTIVE_SUMMARY",
      filters: VALID_FILTERS,
      options: { comparisonMode },
    });
    expect(request.options.comparisonMode).toBe(comparisonMode);
  });

  it("defaults to the immediately previous equal-duration period", () => {
    const request = parseReportRequest({
      type: "EXECUTIVE_SUMMARY",
      filters: VALID_FILTERS,
    });
    expect(request.options.comparisonMode).toBe("PREVIOUS_EQUIVALENT_PERIOD");
  });

  it("rejects an invalid comparison mode", () => {
    expect(() => parseReportRequest({
      type: "EXECUTIVE_SUMMARY",
      filters: VALID_FILTERS,
      options: { comparisonMode: "IMPORT_BATCH" },
    })).toThrow();
  });
});

describe("report request contract validation", () => {
  it("accepts a valid request", () => {
    const request = parseReportRequest({
      type: "EXECUTIVE_SUMMARY",
      filters: VALID_FILTERS,
      options: { includeComparison: true },
    });
    expect(request.type).toBe(ReportType.EXECUTIVE_SUMMARY);
    expect(request.options.maxRows).toBeLessThanOrEqual(REPORT_DEFINITIONS.EXECUTIVE_SUMMARY.maxRows);
  });

  it("rejects an unknown report type", () => {
    expect(() => parseReportRequest({ type: "NOT_A_TYPE", filters: VALID_FILTERS })).toThrow();
  });

  it("rejects when from is after to", () => {
    let threw = false;
    try {
      parseReportRequest({ type: "EXECUTIVE_SUMMARY", filters: { from: "2026-07-31", to: "2026-07-01" } });
    } catch (error) {
      threw = true;
      expect(isReportRequestValidationError(error)).toBe(true);
    }
    expect(threw).toBe(true);
  });

  it("rejects a period longer than the maximum allowed range", () => {
    expect(() =>
      parseReportRequest({
        type: "EXECUTIVE_SUMMARY",
        filters: { from: "2020-01-01", to: "2026-01-01" },
      })
    ).toThrow();
  });

  it("rejects HTML/script content in the title", () => {
    expect(() =>
      parseReportRequest({
        type: "EXECUTIVE_SUMMARY",
        title: "<script>alert(1)</script>",
        filters: VALID_FILTERS,
      })
    ).toThrow();
  });

  it("accepts a plain-text title", () => {
    const request = parseReportRequest({
      type: "EXECUTIVE_SUMMARY",
      title: "تقرير يوليو",
      filters: VALID_FILTERS,
    });
    expect(request.title).toBe("تقرير يوليو");
  });

  it("rejects unknown columns for COMPLAINT_DETAIL", () => {
    expect(() =>
      parseReportRequest({
        type: "COMPLAINT_DETAIL",
        filters: VALID_FILTERS,
        options: { columns: ["notAColumn"] },
      })
    ).toThrow();
  });

  it("accepts a column subset that matches defaultColumns", () => {
    const request = parseReportRequest({
      type: "COMPLAINT_DETAIL",
      filters: VALID_FILTERS,
      options: { columns: ["complaintNumber", "status"] },
    });
    expect(request.options.columns).toEqual(["complaintNumber", "status"]);
  });

  it("caps maxRows to the report definition's ceiling even if a higher value is requested", () => {
    const request = parseReportRequest({
      type: "OVERDUE_COMPLAINTS",
      filters: VALID_FILTERS,
      options: { maxRows: 9000 },
    });
    expect(REPORT_DEFINITIONS.OVERDUE_COMPLAINTS.maxRows).toBeLessThan(9000);
    expect(request.options.maxRows).toBe(REPORT_DEFINITIONS.OVERDUE_COMPLAINTS.maxRows);
  });

  it("rejects an unbounded maxRows value outright", () => {
    expect(() =>
      parseReportRequest({
        type: "COMPLAINT_DETAIL",
        filters: VALID_FILTERS,
        options: { maxRows: 999_999 },
      })
    ).toThrow();
  });

  it("rejects unrecognized top-level fields (strict schema)", () => {
    expect(() =>
      parseReportRequest({
        type: "EXECUTIVE_SUMMARY",
        filters: VALID_FILTERS,
        sqlQuery: "SELECT * FROM Complaint",
      })
    ).toThrow();
  });

  it("rejects an invalid status enum value", () => {
    expect(() =>
      parseReportRequest({
        type: "EXECUTIVE_SUMMARY",
        filters: { ...VALID_FILTERS, status: "REJECTED_LEGACY" },
      })
    ).toThrow();
  });
});
