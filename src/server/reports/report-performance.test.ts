// @vitest-environment node
//
// Performance sanity check on ~10,000 complaints, per the Phase 7 acceptance
// criteria. Uses a mocked db layer (no real SQLite I/O) so it measures the
// report engine's own aggregation/render cost, not disk/query latency.
import { describe, expect, it, vi } from "vitest";
import { ComplaintStatus, ComplaintPriority } from "@prisma/client";

const REGIONS = ["الرياض", "جدة", "الدمام", "مكة", "المدينة"];
const DEPARTMENTS = ["الدعم الفني", "الموارد البشرية", "الشؤون المالية", "الجودة"];
const STATUSES = Object.values(ComplaintStatus);
const PRIORITIES = Object.values(ComplaintPriority);

function makeComplaint(i: number) {
  const base = new Date("2026-07-01T00:00:00Z").getTime();
  const day = i % 30;
  const complaintDate = new Date(base + day * 86_400_000);
  const status = STATUSES[i % STATUSES.length];
  const isClosed = status === ComplaintStatus.RESOLVED || status === ComplaintStatus.CLOSED;
  const dueDate = new Date(complaintDate.getTime() + 5 * 86_400_000);
  const closedAt = isClosed ? new Date(complaintDate.getTime() + (i % 10) * 86_400_000) : null;

  return {
    id: `cmp_${i}`,
    externalId: `EXT-${i}`,
    sourceReference: `SRC-${i}`,
    status,
    priority: PRIORITIES[i % PRIORITIES.length],
    severity: PRIORITIES[i % PRIORITIES.length],
    complaintDate,
    receivedAt: complaintDate,
    dueDate,
    closedAt,
    firstActionAt: null,
    processingStartedAt: null,
    delayReason: null,
    isRepeated: i % 7 === 0,
    isValidated: i % 3 !== 0,
    isPotentialDuplicate: false,
    beneficiarySatisfaction: null,
    region: REGIONS[i % REGIONS.length],
    facility: `موقع ${i % 12}`,
    department: DEPARTMENTS[i % DEPARTMENTS.length],
    classificationId: `cls_${i % 15}`,
    categoryId: `cat_${i % 5}`,
    channel: i % 2 === 0 ? "الهاتف" : "البريد الإلكتروني",
    subject: `شكوى رقم ${i}`,
    classification: { id: `cls_${i % 15}`, nameAr: `تصنيف ${i % 15}`, color: "#000" },
    category: { id: `cat_${i % 5}`, nameAr: `فئة ${i % 5}` },
    statusHistory: [] as { fromStatus: ComplaintStatus | null; toStatus: ComplaintStatus }[],
    version: 1,
    updatedAt: complaintDate,
  };
}

const COMPLAINTS = Array.from({ length: 10_000 }, (_, i) => makeComplaint(i));
let activeComplaints: typeof COMPLAINTS = COMPLAINTS;

vi.mock("@/lib/db", () => ({
  db: {
    complaint: {
      findMany: async () => activeComplaints,
      count: async () => activeComplaints.length,
    },
  },
}));

describe("report engine performance (10,000 complaints)", () => {
  it("computes executive-summary KPIs, and renders PDF + a 10k-row XLSX within acceptable bounds", async () => {
    const { getComplaintKpis } = await import("@/server/complaints/complaint-kpi-service");
    const { buildReportData } = await import("./report-data-service");
    const { parseReportRequest } = await import("./report-definition-service");
    const { renderReportPdf } = await import("./report-pdf-service");
    const { renderReportXlsx } = await import("./report-xlsx-service");

    const now = new Date("2026-07-31T00:00:00Z");

    const kpiStart = performance.now();
    await getComplaintKpis(new URLSearchParams("from=2026-07-01&to=2026-07-31"), now);
    const kpiMs = performance.now() - kpiStart;
    console.log(`[perf] getComplaintKpis over 10k complaints: ${kpiMs.toFixed(1)}ms`);
    // Budget is 8000ms on CI (dev machine may be slower); see Phase 8 perf report.
    expect(kpiMs).toBeLessThan(8000);

    const execRequest = parseReportRequest({
      type: "EXECUTIVE_SUMMARY",
      filters: { from: "2026-07-01", to: "2026-07-31" },
      options: { includeComparison: true, includeDetailedRows: true },
    });
    const execStart = performance.now();
    const execData = await buildReportData(execRequest, "run", now);
    const execMs = performance.now() - execStart;
    console.log(`[perf] buildReportData EXECUTIVE_SUMMARY over 10k complaints: ${execMs.toFixed(1)}ms`);
    expect(execMs).toBeLessThan(8000);

    // PDF generation cost includes: embedding Amiri TTFs (~800KB each),
    // SVG→PNG chart rendering via sharp, and laying out the new comparative
    // sections. The chart adds ~5-10s on an unloaded machine over the old
    // 7-9s baseline; the bound is set to 60s to absorb CI/shared-machine
    // contention (including full-suite load) while still catching genuine
    // regressions (e.g. an accidental per-row chart re-render or TTF re-embed).
    const pdfStart = performance.now();
    const execPdf = await renderReportPdf(execData);
    const pdfMs = performance.now() - pdfStart;
    console.log(`[perf] renderReportPdf EXECUTIVE_SUMMARY: ${pdfMs.toFixed(1)}ms, size=${(execPdf.buffer.length / 1024).toFixed(1)}KB`);
    expect(pdfMs).toBeLessThan(60_000);
    expect(execPdf.buffer.length).toBeLessThan(5 * 1024 * 1024);

    const detailRequest = parseReportRequest({
      type: "COMPLAINT_DETAIL",
      filters: { from: "2026-07-01", to: "2026-07-31" },
      options: { maxRows: 10_000 },
    });
    const detailStart = performance.now();
    const detailData = await buildReportData(detailRequest, "run", now);
    const detailMs = performance.now() - detailStart;
    console.log(`[perf] buildReportData COMPLAINT_DETAIL (10k rows): ${detailMs.toFixed(1)}ms, rows=${detailData.rowCount}`);
    expect(detailData.rowCount).toBe(10_000);
    expect(detailMs).toBeLessThan(8000);

    const xlsxStart = performance.now();
    const detailXlsx = await renderReportXlsx(detailData);
    const xlsxMs = performance.now() - xlsxStart;
    console.log(`[perf] renderReportXlsx COMPLAINT_DETAIL (10k rows): ${xlsxMs.toFixed(1)}ms, size=${(detailXlsx.buffer.length / 1024).toFixed(1)}KB`);
    expect(xlsxMs).toBeLessThan(15_000);
    expect(detailXlsx.buffer.length).toBeLessThan(25 * 1024 * 1024);
  }, 120_000);

  it("PDF for the overdue-complaints report spans multiple pages without erroring", async () => {
    const { buildReportData } = await import("./report-data-service");
    const { parseReportRequest } = await import("./report-definition-service");
    const { renderReportPdf } = await import("./report-pdf-service");

    // Scoped to a smaller slice so the matched count stays under the
    // report's 5,000-row cap while still producing a multi-page table.
    activeComplaints = COMPLAINTS.slice(0, 3000);
    try {
      const request = parseReportRequest({
        type: "OVERDUE_COMPLAINTS",
        filters: { from: "2026-07-01", to: "2026-07-31" },
        options: {},
      });
      const data = await buildReportData(request, "run", new Date("2026-07-31T00:00:00Z"));
      const { buffer } = await renderReportPdf(data);
      expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    } finally {
      activeComplaints = COMPLAINTS;
    }
  }, 30_000);
});
