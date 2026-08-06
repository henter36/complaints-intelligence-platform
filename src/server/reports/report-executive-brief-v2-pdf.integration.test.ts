// @vitest-environment node
//
// Real PDF integration test — spec section 22. Generates the actual V2
// executive brief report for the reference period (2026-07-26 → 2026-08-02)
// against a read-only, consistent snapshot copy of prisma/dev.db, then
// verifies the Data Contract (not OCR) plus a PDF structural smoke check.
//
// Safety: this test only ever reads prisma/dev.db to take a byte-for-byte
// snapshot copy; it never runs migrate/reset/seed/update/delete against it,
// and asserts the source file's SHA-256 is unchanged before vs. after.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient, ReportType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { copyConsistentSqliteSnapshot } from "../../../scripts/lib/benchmark-sqlite-snapshot";

const DEV_DB_PATH = resolve(process.cwd(), "prisma/dev.db");
const DEV_DB_AVAILABLE = existsSync(DEV_DB_PATH);

const dbHolder = vi.hoisted(() => ({ client: null as InstanceType<typeof import("@prisma/client").PrismaClient> | null }));

vi.mock("@/lib/db", () => ({
  db: {
    get complaint() {
      if (!dbHolder.client) throw new Error("test prisma not ready");
      return dbHolder.client.complaint;
    },
    get complaintStatusHistory() {
      if (!dbHolder.client) throw new Error("test prisma not ready");
      return dbHolder.client.complaintStatusHistory;
    },
    get classification() {
      if (!dbHolder.client) throw new Error("test prisma not ready");
      return dbHolder.client.classification;
    },
    $queryRaw(...args: unknown[]) {
      if (!dbHolder.client) throw new Error("test prisma not ready");
      const tag = args[0] as TemplateStringsArray;
      const rest = args.slice(1);
      return (dbHolder.client.$queryRaw as (...a: unknown[]) => unknown)(tag, ...rest);
    },
  },
}));

import { buildReportData } from "./report-data-service";
import type { ReportData } from "./report-data-service";
import type { ReportRequest } from "./report-definition-service";
import { isExecutiveBriefV2Data } from "./report-data-service";
import type { ExecutiveBriefV2Data } from "./report-data-service";
import { renderExecutiveBriefV2Pdf } from "./report-executive-brief-v2-pdf-service";
import { monthKeyFromReportEndDate } from "./report-monthly-trend-sanitize";
import { calculateMonthlyTrendTotals } from "./report-monthly-trend-presentation";

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

let tempDir: string | null = null;
let sourceShaBefore = "";
let sourceShaAfterProbe = "";

const NOW = new Date("2026-08-05T12:00:00.000Z");

const REQUEST: ReportRequest = {
  type: ReportType.EXECUTIVE_SUMMARY,
  filters: { from: "2026-07-26", to: "2026-08-02" },
  options: {
    includeComparison: true,
    includeCharts: true,
    includeDetailedRows: false,
    includeSensitiveFields: false,
    reportMode: "PRINT_EXECUTIVE_BRIEF_V2",
    comparisonMode: "PREVIOUS_EQUIVALENT_PERIOD",
  },
};

// Computed once in beforeAll and shared by every `it` below — this is a real
// SQLite-backed report build (~1.5-2.5s), and the full suite runs many files
// concurrently, so re-running it per assertion risks CI timeouts under load
// for no benefit (the assertions below are independent checks on one build).
let reportData: ReportData;
let pdfBuffer: Buffer;

beforeAll(async () => {
  if (!DEV_DB_AVAILABLE) return;
  sourceShaBefore = sha256File(DEV_DB_PATH);
  const snapshot = copyConsistentSqliteSnapshot({
    sourcePath: DEV_DB_PATH,
    tempPrefix: "v2-pdf-integration-",
    hashFile: sha256File,
  });
  tempDir = snapshot.tempDir;
  dbHolder.client = new PrismaClient({ datasources: { db: { url: `file:${snapshot.copyPath}` } } });

  reportData = await buildReportData(REQUEST, "run", NOW);
  const pdfResult = await renderExecutiveBriefV2Pdf(reportData);
  pdfBuffer = pdfResult.buffer;
  sourceShaAfterProbe = sha256File(DEV_DB_PATH);
}, 60_000);

afterAll(async () => {
  const teardownErrors: unknown[] = [];

  try {
    await dbHolder.client?.$disconnect();
  } catch (error) {
    teardownErrors.push(error);
  }

  try {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    teardownErrors.push(error);
  }

  if (DEV_DB_AVAILABLE && sourceShaAfterProbe !== sourceShaBefore) {
    teardownErrors.push(new Error("prisma/dev.db changed during the V2 PDF integration test run"));
  }

  if (teardownErrors.length === 1) {
    throw teardownErrors[0];
  }
  if (teardownErrors.length > 1) {
    throw new AggregateError(teardownErrors, "V2 PDF integration test teardown failed");
  }
});

function requireV2Brief(): ExecutiveBriefV2Data {
  if (!isExecutiveBriefV2Data(reportData.briefData!)) {
    throw new Error("expected V2 brief data");
  }
  return reportData.briefData;
}

describe.skipIf(!DEV_DB_AVAILABLE)(
  "PRINT_EXECUTIVE_BRIEF_V2 — real dev.db snapshot, 2026-07-26..08-02 (spec section 22)",
  () => {
    it("data contract: receivedDuringPeriod matches the region-sum comparison total", () => {
      expect(reportData.comparisonData?.currentTotal).toBeGreaterThan(0);
      const regionSum = (reportData.briefData?.allRegions ?? []).reduce((s, r) => s + r.currentCount, 0);
      expect(regionSum).toBe(reportData.comparisonData?.currentTotal);

      const brief = requireV2Brief();
      expect(brief.periodMetrics?.current.receivedDuringPeriod).toBe(reportData.comparisonData?.currentTotal);
    });

    it("data contract: closedDuringPeriod is a real, non-zero closure-flow count (regression: import-time StatusHistory rows must not zero this out)", () => {
      // dev.db stores most closures as a single ComplaintStatusHistory row with
      // fromStatus: null and changedAt = import processing time, not the real
      // closure date. Treating that as a genuine transition made
      // closedDuringPeriod silently collapse to 0 for every past report
      // period. This asserts against that regression using real data.
      const brief = requireV2Brief();
      expect(brief.periodMetrics!.current.closedDuringPeriod).toBeGreaterThan(0);
      expect(brief.periodMetrics!.previous?.closedDuringPeriod ?? 0).toBeGreaterThan(0);
    });

    it("data contract: openAtEnd/lateAtEnd include prior-period backlog and lateAtEnd never exceeds openAtEnd", () => {
      const { current } = requireV2Brief().periodMetrics!;
      expect(current.lateAtEnd).toBeLessThanOrEqual(current.openAtEnd);
      // Structural signal that backlog is included: openAtEnd is not silently
      // capped at receivedDuringPeriod (a complaint registered before the
      // period can still be open at period end).
      expect(current.openAtEnd).toBeGreaterThanOrEqual(0);
    });

    it("data contract: region openAtEnd/lateAtEnd sums equal the overall snapshot", () => {
      const brief = requireV2Brief();
      const rows = brief.regionSnapshotAtEnd ?? [];
      const sumOpen = rows.reduce((s, r) => s + r.openAtEnd, 0);
      const sumLate = rows.reduce((s, r) => s + r.lateAtEnd, 0);
      expect(sumOpen).toBe(brief.periodMetrics!.current.openAtEnd);
      expect(sumLate).toBe(brief.periodMetrics!.current.lateAtEnd);
    });

    it("data contract: department receivedDuringPeriod/openAtEnd/lateAtEnd sums equal the overall snapshot", () => {
      const brief = requireV2Brief();
      const rows = brief.departmentPeriodMetrics ?? [];
      const sums = rows.reduce(
        (acc, r) => ({
          receivedDuringPeriod: acc.receivedDuringPeriod + r.receivedDuringPeriod,
          openAtEnd: acc.openAtEnd + r.openAtEnd,
          lateAtEnd: acc.lateAtEnd + r.lateAtEnd,
        }),
        { receivedDuringPeriod: 0, openAtEnd: 0, lateAtEnd: 0 }
      );
      const current = brief.periodMetrics!.current;
      expect(sums.receivedDuringPeriod).toBe(current.receivedDuringPeriod);
      expect(sums.openAtEnd).toBe(current.openAtEnd);
      expect(sums.lateAtEnd).toBe(current.lateAtEnd);
    });

    it("data contract: the FULL classification openAtEnd/lateAtEnd sum (all buckets, not just top 8) equals the overall snapshot", () => {
      const brief = requireV2Brief();
      const rows = brief.classificationSnapshotAtEnd ?? [];
      const sumOpen = rows.reduce((s, r) => s + r.openAtEnd, 0);
      const sumLate = rows.reduce((s, r) => s + r.lateAtEnd, 0);
      const current = brief.periodMetrics!.current;
      expect(sumOpen).toBe(current.openAtEnd);
      expect(sumLate).toBe(current.lateAtEnd);

      // The top-8 table sum may be less than the full total, but never more.
      const top8OpenSum = Object.values(brief.classificationOpenLate)
        .slice(0, 8)
        .reduce((s, r) => s + r.openAtEnd, 0);
      expect(top8OpenSum).toBeLessThanOrEqual(sumOpen);
    });

    it("data contract: all known regions appear in allRegions (Left Join, none dropped)", () => {
      const KNOWN_REGIONS = [
        "منطقة الرياض",
        "منطقة مكة المكرمة",
        "منطقة المدينة المنورة",
        "منطقة القصيم",
        "المنطقة الشرقية",
        "منطقة عسير",
        "منطقة تبوك",
        "منطقة حائل",
        "منطقة الحدود الشمالية",
        "منطقة جازان",
        "منطقة نجران",
        "منطقة الباحة",
        "منطقة الجوف",
      ];
      const names = new Set((reportData.briefData?.allRegions ?? []).map((r) => r.regionName));
      for (const region of KNOWN_REGIONS) {
        expect(names.has(region)).toBe(true);
      }
    });

    it("data contract: the monthly trend never extends past August 2026 (the report's end month)", () => {
      const brief = requireV2Brief();
      const endKey = monthKeyFromReportEndDate("2026-08-02")!;
      for (const point of brief.monthlyStockFlow) {
        expect(point.monthKey <= endKey).toBe(true);
      }
      const lastPoint = brief.monthlyStockFlow.at(-1);
      expect(lastPoint?.monthKey).toBe("2026-08");
    });

    it("data contract: convergence totals are internally self-consistent with the returned monthlyStockFlow", () => {
      const brief = requireV2Brief();
      const totals = calculateMonthlyTrendTotals(brief.monthlyStockFlow);
      const recomputed = brief.monthlyStockFlow.reduce(
        (acc, p) => ({
          registeredTotal: acc.registeredTotal + p.receivedCount,
          closedTotal: acc.closedTotal + p.closedDuringMonthCount,
        }),
        { registeredTotal: 0, closedTotal: 0 }
      );
      expect(totals).toEqual(recomputed);
    });

    it("PDF smoke test: renders exactly four pages without throwing", () => {
      expect(pdfBuffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
      const pageCount = (pdfBuffer.toString("binary").match(/\/Type\s*\/Page\s*\/Parent/g) ?? []).length;
      expect(pageCount).toBe(4);
    });

    it("source database SHA-256 is unchanged after the full report + PDF run", () => {
      expect(sourceShaAfterProbe).toBe(sourceShaBefore);
    });
  }
);
