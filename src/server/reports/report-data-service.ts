import { ReportType } from "@prisma/client";
import {
  getComplaintKpis,
  getPreviousPeriodRange,
  type ComplaintGroupMetrics,
  type ComplaintKpiSummary,
} from "@/server/complaints/complaint-kpi-service";
import { listComplaints, type ComplaintListItem } from "@/server/complaints/complaint-query-service";
import {
  buildComplaintQueryParams,
  getReportDefinition,
  type ReportFilters,
  type ReportRequest,
} from "./report-definition-service";
import {
  buildComparisonResult,
  comparisonWarningMessage,
  type ComparisonResult,
  type DeptClassRiseRow,
  type RegionChangeRow,
  type RegionTrendData,
} from "./report-comparison";
import {
  getExecutiveBriefSectionPlacement,
  isReportMode,
} from "@/lib/reports/report-contract";
import type {
  ReportMatrixSection,
  ReportMode,
  ComparisonMode,
  ExecutiveBriefKpiCard,
  RegionReferenceRow,
  ClassificationBriefRow,
  ComparativeTimelineData,
  ExecutiveEntityRow,
  ConcentrationBand,
  NetBacklogFlow,
  PerfVolumeRow,
  ContinuityRow,
  ExecutiveBriefPreviewPage,
  MonthlyComplaintTrendPoint,
  ExecutivePeriodMetrics,
  RegionSnapshotAtEndRow,
  DepartmentPeriodMetricsRow,
  ClassificationSnapshotAtEndRow,
} from "@/lib/reports/report-contract";
// Types that are only re-exported (not used locally) — direct re-export avoids a redundant import.
export type { KpiAssessment, ComparativeTimelinePoint, ComparativeTimelineSeries } from "@/lib/reports/report-contract";
import {
  buildExecutiveBriefData,
  buildExecutiveBriefV2Data,
  buildFullAnalyticalData,
} from "./report-executive-brief-data-service";

const DAY_MS = 24 * 60 * 60 * 1000;

export class ReportRowLimitExceededError extends Error {
  readonly code = "REPORT_ROW_LIMIT_EXCEEDED";
  readonly total: number;
  readonly limit: number;

  constructor(total: number, limit: number) {
    super("عدد الشكاوى المطابقة يتجاوز الحد المسموح لهذا التقرير");
    this.name = "ReportRowLimitExceededError";
    this.total = total;
    this.limit = limit;
  }
}

export function isReportRowLimitExceededError(error: unknown): error is ReportRowLimitExceededError {
  return error instanceof ReportRowLimitExceededError;
}

export type ReportKpiCard = {
  key: string;
  label: string;
  value: number | null;
  format: "number" | "percent" | "days" | "hours";
};

export type ReportTableColumn = {
  key: string;
  label: string;
  format?: "number" | "signed-number" | "percent" | "date" | "text";
};

export type ReportTable = {
  id: string;
  title: string;
  columns: ReportTableColumn[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  totalMatched: number;
};

export type ChartSeries = {
  name: string;
  points: { x: string; y: number }[];
  isOther?: boolean;
  /** When "right", render against a secondary Y-axis (legacy dual-axis charts only). */
  axis?: "left" | "right";
  /**
   * Explicit mark type within a chart. Defaults to the section chartType.
   * Use bar+line combo on a single shared Y-axis (e.g. monthly stock/flow).
   */
  renderAs?: "bar" | "line";
  /** Optional stroke dash pattern for line marks (e.g. "6,4"). */
  dash?: string;
};

type ReportSectionPreviewMetadata = {
  previewPage?: ExecutiveBriefPreviewPage;
  previewOrder?: number;
};

export type ReportChartSection = ReportSectionPreviewMetadata & {
  id: string;
  kind: "chart";
  chartType: "line" | "bar";
  title: string;
  description?: string;
  xAxisLabel?: string;
  yAxisLabel?: string;
  series: ChartSeries[];
  emptyState?: string;
  truncated?: boolean;
  truncatedMessage?: string;
  unit?: string;
};

export type ReportTextSection = ReportSectionPreviewMetadata & {
  id: string;
  kind: "text";
  title: string;
  points: string[];
};

export type ReportSection =
  | ({ id: string; kind: "kpi"; title: string; cards: ReportKpiCard[] } & ReportSectionPreviewMetadata)
  | ({ id: string; kind: "table"; title: string; table: ReportTable } & ReportSectionPreviewMetadata)
  | ReportTextSection
  | ReportChartSection
  | ReportMatrixSection;

export type ReportData = {
  type: ReportType;
  title: string;
  generatedAt: string;
  period: { from: string; to: string };
  // ISO dates (YYYY-MM-DD) for the reference period used in the comparison,
  // for display on the cover page. null when no comparison period exists.
  previousPeriod?: { from: string; to: string } | null;
  // The run id (when produced by a real report run) so the PDF footer/cover can
  // display a short traceable identifier. Optional for preview/tests.
  reportRunId?: string;
  filters: ReportFilters;
  kpis: ComplaintKpiSummary;
  sections: ReportSection[];
  warnings: string[];
  rowCount: number;
  // The raw comparison result is threaded through so the XLSX service can emit
  // dedicated worksheets without recomputing it. It is undefined for report
  // types that do not run a comparison (only EXECUTIVE_SUMMARY populates it).
  comparisonData?: ComparisonResult;
  // Mode-specific extended data (only present for the new report modes).
  reportMode?: ReportMode;
  comparisonMode?: ComparisonMode;
  briefData?: ExecutiveBriefData | ExecutiveBriefV2Data | FullAnalyticalData;
};

/** Extended payload for DIGITAL_EXECUTIVE_BRIEF and PRINT_EXECUTIVE_BRIEF modes. */
export type ExecutiveBriefData = {
  briefKpis: ExecutiveBriefKpiCard[];
  allRegions: RegionReferenceRow[];
  topClassifications: ClassificationBriefRow[];
  comparativeTimeline: ComparativeTimelineData;
  concentrationBands: ConcentrationBand[];
  topDepartments?: ExecutiveEntityRow[];
  conclusions?: string[];
  notes?: string[];
  /** Deduplicated union of comparison warnings and period-snapshot warnings (e.g. an uncertain complaint state). */
  warnings?: string[];
  /** Cover-page flow/stock metrics: receivedDuringPeriod, closedDuringPeriod, openAtEnd, lateAtEnd. */
  periodMetrics?: ExecutivePeriodMetrics;
  /** Per-region openAtEnd/lateAtEnd at current period end (region currentCount/previousCount stay Inflow-based). */
  regionSnapshotAtEnd?: RegionSnapshotAtEndRow[];
  /** Per-department receivedDuringPeriod/closedDuringPeriod/openAtEnd/lateAtEnd for the current period. */
  departmentPeriodMetrics?: DepartmentPeriodMetricsRow[];
  /** Per-classification openAtEnd/lateAtEnd at current period end, covering every classification. */
  classificationSnapshotAtEnd?: ClassificationSnapshotAtEndRow[];
};

/** Extended payload for PRINT_EXECUTIVE_BRIEF_V2 (super-set of ExecutiveBriefData). */
export type ExecutiveBriefV2Data = ExecutiveBriefData & {
  allTimeTotal: number;
  monthlyStockFlow: MonthlyComplaintTrendPoint[];
  /** Per-classificationId open and late counts at current period end. */
  classificationOpenLate: Record<string, { openAtEnd: number; lateAtEnd: number }>;
  /** V2-only: facilities with the highest complaint volume this period (page 4 "أعلى السجون"). Not used by other report modes. */
  topFacilities?: ExecutiveEntityRow[];
  /** V2-only: facilities with the lowest (non-zero) complaint volume this period (page 4 "أقل السجون"). Never overlaps topFacilities. */
  bottomFacilities?: ExecutiveEntityRow[];
};

/** Extended payload for FULL_ANALYTICAL mode (super-set of ExecutiveBriefData). */
export type FullAnalyticalData = ExecutiveBriefData & {
  netBacklogFlow: NetBacklogFlow;
  perfVolumeRows: PerfVolumeRow[];
  continuityRows: ContinuityRow[];
};

/** Returns true when the brief data includes V2-specific fields. */
export function isExecutiveBriefV2Data(
  data: ExecutiveBriefData | ExecutiveBriefV2Data | FullAnalyticalData
): data is ExecutiveBriefV2Data {
  return (
    "allTimeTotal" in data &&
    "monthlyStockFlow" in data &&
    "classificationOpenLate" in data
  );
}

/** Returns true when all FULL_ANALYTICAL-only payload fields are present. */
export function isFullAnalyticalData(
  data: ExecutiveBriefData | FullAnalyticalData
): data is FullAnalyticalData {
  return "netBacklogFlow" in data && "perfVolumeRows" in data && "continuityRows" in data;
}

// Re-export contract types so consumers only need to import from this file.
export type {
  ReportMatrixSection,
  ReportMode,
  ComparisonMode,
  ExecutiveBriefKpiCard,
  RegionReferenceRow,
  ClassificationBriefRow,
  ComparativeTimelineData,
  ConcentrationBand,
  NetBacklogFlow,
  PerfVolumeRow,
  ContinuityRow,
  ExecutivePeriodMetrics,
  RegionSnapshotAtEndRow,
  DepartmentPeriodMetricsRow,
  ClassificationSnapshotAtEndRow,
};
const PREVIEW_TABLE_ROW_CAP = 100;

function kpi(key: string, label: string, value: number | null, format: ReportKpiCard["format"] = "number"): ReportKpiCard {
  return { key, label, value, format };
}

function groupTable(id: string, title: string, groups: ComplaintGroupMetrics[]): ReportTable {
  return {
    id,
    title,
    columns: [
      { key: "name", label: "الاسم", format: "text" },
      { key: "total", label: "الإجمالي", format: "number" },
      { key: "open", label: "المفتوحة", format: "number" },
      { key: "closed", label: "المغلقة", format: "number" },
      { key: "currentlyLate", label: "المتأخرة حالياً", format: "number" },
      { key: "closedLate", label: "المغلقة بعد المهلة", format: "number" },
      { key: "withinDueDate", label: "ضمن المهلة", format: "number" },
      { key: "complianceRate", label: "نسبة الالتزام%", format: "percent" },
      { key: "averageResolutionDays", label: "متوسط زمن الإغلاق (يوم)", format: "number" },
      { key: "highPriorityOpen", label: "عالية الأولوية المفتوحة", format: "number" },
      { key: "unclassified", label: "غير مصنفة", format: "number" },
    ],
    rows: groups.map((group) => ({ ...group })),
    truncated: false,
    totalMatched: groups.length,
  };
}

/** Executive PDF-friendly 6-column view of a group distribution. The full
 * 11-column `groupTable` remains for XLSX and other report types. */
function groupTableExecutive(id: string, title: string, groups: ComplaintGroupMetrics[]): ReportTable {
  return {
    id,
    title,
    columns: [
      { key: "name", label: "الاسم", format: "text" },
      { key: "total", label: "الإجمالي", format: "number" },
      { key: "open", label: "المفتوحة", format: "number" },
      { key: "currentlyLate", label: "المتأخرة حالياً", format: "number" },
      { key: "complianceRate", label: "نسبة الالتزام%", format: "percent" },
      { key: "averageResolutionDays", label: "متوسط الإغلاق (يوم)", format: "number" },
    ],
    rows: groups.map((group) => ({ ...group })),
    truncated: false,
    totalMatched: groups.length,
  };
}

const DIRECTION_SYMBOL: Record<string, string> = {
  ارتفاع: "↑ ارتفاع",
  انخفاض: "↓ انخفاض",
  جديد: "★ جديد",
  "دون تغير": "= دون تغير",
  "دون شكاوى": "○ دون شكاوى",
};

function regionTrendChartSection(trend: RegionTrendData): ReportChartSection {
  return {
    id: "region_trend_chart",
    kind: "chart",
    chartType: "line",
    title: "الاتجاه الزمني لإجمالي الشكاوى",
    description: "عدد الشكاوى خلال الفترة الحالية وفق التجميع الزمني المناسب.",
    xAxisLabel: "اليوم",
    yAxisLabel: "عدد الشكاوى",
    unit: "شكوى",
    emptyState: "لا توجد بيانات لعرضها في الرسم البياني.",
    truncated: trend.truncated,
    truncatedMessage: undefined,
    series: trend.series.map((series) => ({
      name: series.regionName,
      isOther: series.regionName === trend.otherSeriesName,
      points: series.points.map((point) => ({ x: point.date, y: point.count })),
    })),
  };
}

function regionChangesTable(rows: RegionChangeRow[]): ReportTable {
  return {
    id: "region_changes",
    title: "التغير في عدد الشكاوى حسب المنطقة",
    columns: [
      { key: "regionName", label: "المنطقة", format: "text" },
      { key: "currentCount", label: "الحالي", format: "number" },
      { key: "previousCount", label: "السابق", format: "number" },
      { key: "difference", label: "الفرق", format: "signed-number" },
      { key: "changeRate", label: "نسبة التغير%", format: "percent" },
      { key: "direction", label: "الاتجاه", format: "text" },
    ],
    rows: rows.map((row) => ({
      regionName: row.regionName,
      currentCount: row.currentCount,
      previousCount: row.previousCount,
      difference: row.difference,
      changeRate: row.changeRate,
      direction: DIRECTION_SYMBOL[row.direction] ?? row.direction,
    })),
    truncated: false,
    totalMatched: rows.length,
  };
}

function deptClassRisesTable(rows: DeptClassRiseRow[], totalMatched: number): ReportTable {
  return {
    id: "dept_class_rises",
    title: "الإدارات والتصنيفات التي شهدت ارتفاعًا عن الأسبوع السابق",
    columns: [
      { key: "departmentName", label: "الإدارة", format: "text" },
      { key: "classificationPath", label: "التصنيف", format: "text" },
      { key: "currentCount", label: "الحالي", format: "number" },
      { key: "previousCount", label: "السابق", format: "number" },
      { key: "difference", label: "الفرق", format: "signed-number" },
      { key: "changeRate", label: "نسبة التغير%", format: "percent" },
      { key: "classificationContribution", label: "مساهمة التصنيف%", format: "percent" },
    ],
    rows: rows.map((row) => ({
      departmentName: row.departmentName,
      classificationPath: row.classificationPath ?? row.classificationName,
      currentCount: row.currentCount,
      previousCount: row.previousCount,
      difference: row.difference,
      changeRate: row.changeRate,
      classificationContribution: row.classificationContribution,
    })),
    truncated: totalMatched > rows.length,
    totalMatched: Math.max(totalMatched, rows.length),
  };
}

function complaintRows(items: ComplaintListItem[]): Record<string, unknown>[] {
  return items.map((item) => ({
    complaintNumber: item.complaintNumber,
    receivedDate: item.receivedDate,
    status: item.status,
    subject: item.subject,
    region: item.regionName ?? "",
    facility: item.facility ?? "",
    department: item.departmentName ?? "",
    classification: item.classification?.name ?? "",
    priority: item.priority,
    channel: item.channel ?? "",
    dueDate: item.dueDate,
    closedAt: item.closedAt,
    isLate: item.isLate,
    latenessDays: item.latenessDays ?? 0,
    resolutionDays: item.resolutionDays,
  }));
}

const DETAIL_TABLE_COLUMNS: ReportTableColumn[] = [
  { key: "complaintNumber", label: "رقم الشكوى", format: "text" },
  { key: "receivedDate", label: "تاريخ الورود", format: "date" },
  { key: "status", label: "الحالة", format: "text" },
  { key: "subject", label: "الموضوع", format: "text" },
  { key: "region", label: "المنطقة", format: "text" },
  { key: "facility", label: "الموقع", format: "text" },
  { key: "department", label: "الإدارة", format: "text" },
  { key: "classification", label: "التصنيف", format: "text" },
  { key: "priority", label: "الأولوية", format: "text" },
  { key: "channel", label: "القناة", format: "text" },
  { key: "dueDate", label: "الاستحقاق", format: "date" },
  { key: "closedAt", label: "الإغلاق", format: "date" },
  { key: "latenessDays", label: "أيام التأخر", format: "number" },
];

const OVERDUE_TABLE_COLUMNS: ReportTableColumn[] = [
  { key: "complaintNumber", label: "رقم الشكوى", format: "text" },
  { key: "subject", label: "الموضوع", format: "text" },
  { key: "priority", label: "الأولوية", format: "text" },
  { key: "department", label: "الإدارة", format: "text" },
  { key: "region", label: "المنطقة", format: "text" },
  { key: "classification", label: "التصنيف", format: "text" },
  { key: "dueDate", label: "الاستحقاق", format: "date" },
  { key: "latenessDays", label: "أيام التأخر", format: "number" },
  { key: "status", label: "الحالة", format: "text" },
];

async function fetchOverdueTable(
  filters: ReportFilters,
  limit: number,
  mode: "preview" | "run"
): Promise<ReportTable> {
  const params = buildComplaintQueryParams(filters);
  params.set("isLate", "true");
  params.set("sortBy", "dueDate");
  params.set("sortOrder", "asc");
  const cap = mode === "preview" ? Math.min(limit, PREVIEW_TABLE_ROW_CAP) : limit;
  const result = await listComplaints(params, { limit: cap });
  return {
    id: "overdue_table",
    title: "الشكاوى المتأخرة",
    columns: OVERDUE_TABLE_COLUMNS,
    rows: complaintRows(result.items),
    truncated: result.pagination.total > result.items.length,
    totalMatched: result.pagination.total,
  };
}

async function fetchDetailTable(
  filters: ReportFilters,
  limit: number,
  mode: "preview" | "run",
  hardLimit: number
): Promise<ReportTable> {
  const params = buildComplaintQueryParams(filters);
  const cap = mode === "preview" ? Math.min(limit, PREVIEW_TABLE_ROW_CAP) : limit;
  const result = await listComplaints(params, { limit: cap });

  if (mode === "run" && result.pagination.total > hardLimit) {
    throw new ReportRowLimitExceededError(result.pagination.total, hardLimit);
  }

  return {
    id: "detail_table",
    title: "تفاصيل الشكاوى",
    columns: DETAIL_TABLE_COLUMNS,
    rows: complaintRows(result.items),
    truncated: result.pagination.total > result.items.length,
    totalMatched: result.pagination.total,
  };
}

function topGroups(groups: ComplaintGroupMetrics[], n = 5): ComplaintGroupMetrics[] {
  return groups.slice(0, n);
}

function executiveKpiSection(result: Awaited<ReturnType<typeof getComplaintKpis>>): ReportSection {
  return {
    id: "kpi_overview",
    kind: "kpi",
    title: "المؤشرات الرئيسية",
    cards: [
      kpi("total", "إجمالي الشكاوى", result.volume.total),
      kpi("open", "المفتوحة", result.kpis.openComplaints.currentValue),
      kpi("closed", "المغلقة", result.kpis.closedComplaints.currentValue),
      kpi("currentlyLate", "المتأخرة حالياً", result.kpis.currentlyLateComplaints.currentValue),
      kpi("closedLate", "المغلقة بعد المهلة", result.kpis.closedLateComplaints.currentValue),
      kpi("withinDueDate", "ضمن المهلة", result.kpis.closedWithinDueDate.currentValue),
      kpi("onTimeRate", "نسبة الالتزام بالمهلة", result.performance.onTimeRate, "percent"),
      kpi("avgResolutionDays", "متوسط زمن الإغلاق (يوم)", result.performance.averageResolutionDays),
      kpi("medianResolutionDays", "الوسيط (يوم)", result.performance.medianResolutionDays),
      kpi("unclassified", "غير المصنفة", result.kpis.unclassifiedComplaints.currentValue),
      kpi("highPriorityOpen", "عالية الأولوية المفتوحة", result.kpis.highPriorityOpenComplaints.currentValue),
    ],
  };
}

type ExecutiveSummaryCore = {
  data: ReportData;
  kpiResult: Awaited<ReturnType<typeof getComplaintKpis>>;
  comparison: ComparisonResult;
};

async function buildExecutiveSummaryCore(
  request: ReportRequest,
  mode: "preview" | "run",
  now: Date
): Promise<ExecutiveSummaryCore> {
  const { filters, options } = request;
  const params = buildComplaintQueryParams(filters);
  const result = await getComplaintKpis(params, now, {
    comparisonMode: options.comparisonMode ?? "PREVIOUS_EQUIVALENT_PERIOD",
    includeComparison: options.includeComparison,
  });
  const comparison = await buildComparisonResult(filters, now, {
    comparisonMode: options.comparisonMode ?? "PREVIOUS_EQUIVALENT_PERIOD",
    includeComparison: options.includeComparison,
  });
  const warnings: string[] = comparison.warnings.map(comparisonWarningMessage);

  const sections: ReportSection[] = [];

  if (comparison.executiveSummaryPoints.length > 0) {
    sections.push({
      id: "executive_summary_text",
      kind: "text",
      title: "الملخص",
      points: comparison.executiveSummaryPoints,
    });
  }

  sections.push(executiveKpiSection(result));

  if (options.includeComparison) {
    sections.push({
      id: "comparison",
      kind: "kpi",
      title: "مقارنة بالفترة السابقة",
      cards: [
        kpi("previousTotal", "إجمالي الفترة السابقة", result.trend.previousTotal),
        kpi("growthRate", "نسبة التغير%", result.trend.growthRate, "percent"),
      ],
    });
  }

  sections.push(
    regionTrendChartSection(comparison.regionTrend),
    {
      id: "region_changes",
      kind: "table" as const,
      title: "التغير في عدد الشكاوى حسب المنطقة",
      table: regionChangesTable(comparison.regionChanges),
    },
    {
      id: "dept_class_rises",
      kind: "table" as const,
      title: "الإدارات والتصنيفات التي شهدت ارتفاعًا عن الأسبوع السابق",
      table: deptClassRisesTable(comparison.deptClassRises, comparison.deptClassRisesTotal),
    },
    {
      id: "top_regions",
      kind: "table" as const,
      title: "أعلى المناطق",
      table: groupTableExecutive("top_regions", "أعلى المناطق", topGroups(result.distributions.byRegion)),
    },
    {
      id: "top_departments",
      kind: "table" as const,
      title: "أعلى الإدارات",
      table: groupTableExecutive("top_departments", "أعلى الإدارات", topGroups(result.distributions.byDepartment)),
    },
    {
      id: "top_classifications",
      kind: "table" as const,
      title: "أعلى التصنيفات",
      table: groupTableExecutive(
        "top_classifications",
        "أعلى التصنيفات",
        topGroups(result.distributions.byClassification)
      ),
    }
  );

  if (options.includeDetailedRows) {
    const overdueLimit = Math.min(options.maxRows ?? 50, 50);
    const overdueTable = await fetchOverdueTable(filters, overdueLimit, "preview");
    sections.push({ id: "overdue_table", kind: "table", title: "أهم الشكاوى المتأخرة", table: overdueTable });
    if (overdueTable.truncated) {
      warnings.push("تم اختصار جدول الشكاوى المتأخرة إلى أعلى الحالات فقط.");
    }
  }

  const previousPeriod = comparison.previousPeriod
    ? {
        from: comparison.previousPeriod.from.toISOString().slice(0, 10),
        to: new Date(comparison.previousPeriod.toExclusive.getTime() - DAY_MS).toISOString().slice(0, 10),
      }
    : null;

  const sectionsWithPreviewMetadata = sections.map((section) => {
    const placement = getExecutiveBriefSectionPlacement(section.id);
    return placement ? { ...section, ...placement } : section;
  });

  const data: ReportData = {
    type: ReportType.EXECUTIVE_SUMMARY,
    title: request.title ?? getReportDefinition(ReportType.EXECUTIVE_SUMMARY).title,
    generatedAt: now.toISOString(),
    period: { from: filters.from, to: filters.to },
    previousPeriod,
    filters,
    kpis: result.kpis,
    sections: sectionsWithPreviewMetadata,
    warnings,
    rowCount: 0,
    comparisonData: comparison,
    comparisonMode: options.comparisonMode ?? "PREVIOUS_EQUIVALENT_PERIOD",
  };
  return { data, kpiResult: result, comparison };
}

async function buildExecutiveSummary(
  request: ReportRequest,
  mode: "preview" | "run",
  now: Date
): Promise<ReportData> {
  const { data } = await buildExecutiveSummaryCore(request, mode, now);
  return data;
}

/** Builds the executive summary with one of the new report modes attached. */
async function buildExecutiveSummaryWithMode(
  request: ReportRequest,
  mode: "preview" | "run",
  now: Date,
  reportMode: ReportMode
): Promise<ReportData> {
  const { data: base, kpiResult: result, comparison } = await buildExecutiveSummaryCore(request, mode, now);

  const modeTitle: Record<ReportMode, string> = {
    STANDARD: getReportDefinition(ReportType.EXECUTIVE_SUMMARY).title,
    DIGITAL_EXECUTIVE_BRIEF: "تقرير الشكاوى",
    PRINT_EXECUTIVE_BRIEF: "تقرير الشكاوى",
    PRINT_EXECUTIVE_BRIEF_V2: "تقرير الشكاوى",
    FULL_ANALYTICAL: "تقرير الشكاوى",
  };

  const title = request.title ?? modeTitle[reportMode];

  if (reportMode === "STANDARD") {
    return { ...base, title, reportMode };
  }

  // Only enhanced modes need the reference-period KPI distributions.
  let previousResult: Awaited<ReturnType<typeof getComplaintKpis>> | undefined;
  if (comparison.previousPeriod) {
    const prevParams = buildComplaintQueryParams(request.filters);
    prevParams.set("from", comparison.previousPeriod.from.toISOString().slice(0, 10));
    prevParams.set(
      "to",
      new Date(comparison.previousPeriod.toExclusive.getTime() - DAY_MS).toISOString().slice(0, 10)
    );
    previousResult = await getComplaintKpis(prevParams, now, { includeComparison: false });
  }

  if (reportMode === "FULL_ANALYTICAL") {
    const fullData = await buildFullAnalyticalData(
      request.filters,
      result,
      comparison,
      previousResult,
      now
    );
    return { ...base, title, reportMode, briefData: fullData };
  }

  // PRINT_EXECUTIVE_BRIEF_V2
  if (reportMode === "PRINT_EXECUTIVE_BRIEF_V2") {
    const briefData = await buildExecutiveBriefV2Data(
      request.filters,
      result,
      comparison,
      previousResult,
      now
    );
    return { ...base, title, reportMode, briefData };
  }

  // DIGITAL_EXECUTIVE_BRIEF / PRINT_EXECUTIVE_BRIEF
  const briefData = await buildExecutiveBriefData(
    request.filters,
    result,
    comparison,
    previousResult,
    now
  );
  return { ...base, title, reportMode, briefData };
}

async function buildGroupPerformanceReport(
  request: ReportRequest,
  now: Date,
  result: Awaited<ReturnType<typeof getComplaintKpis>>,
  groups: { id: string; title: string; groups: ComplaintGroupMetrics[] }[]
): Promise<ReportData> {
  const { filters } = request;

  const sections: ReportSection[] = [
    {
      id: "kpi_overview",
      kind: "kpi",
      title: "المؤشرات الرئيسية",
      cards: [
        kpi("total", "إجمالي الشكاوى", result.volume.total),
        kpi("open", "المفتوحة", result.kpis.openComplaints.currentValue),
        kpi("closed", "المغلقة", result.kpis.closedComplaints.currentValue),
        kpi("onTimeRate", "نسبة الالتزام بالمهلة", result.performance.onTimeRate, "percent"),
      ],
    },
    ...groups.map((g) => ({
      id: g.id,
      kind: "table" as const,
      title: g.title,
      table: groupTable(g.id, g.title, g.groups),
    })),
  ];

  return {
    type: request.type,
    title: request.title ?? getReportDefinition(request.type).title,
    generatedAt: now.toISOString(),
    period: { from: filters.from, to: filters.to },
    filters,
    kpis: result.kpis,
    sections,
    warnings: [],
    rowCount: 0,
  };
}

async function buildClassificationAnalysis(request: ReportRequest, now: Date): Promise<ReportData> {
  const { filters } = request;
  const params = buildComplaintQueryParams(filters);
  const result = await getComplaintKpis(params, now);

  const from = new Date(filters.from);
  const to = new Date(filters.to);
  const previousRange = getPreviousPeriodRange(from, to);

  let trendRows: Record<string, unknown>[] = result.distributions.byClassification.map((group) => ({
    name: group.name,
    total: group.total,
    previousTotal: null,
    changePercent: null,
    shareOfTotal: result.volume.total > 0 ? Math.round((group.total / result.volume.total) * 1000) / 10 : 0,
  }));

  if (previousRange) {
    const previousParams = buildComplaintQueryParams(filters);
    previousParams.set("from", previousRange.from.toISOString().slice(0, 10));
    previousParams.set("to", previousRange.to.toISOString().slice(0, 10));
    const previousResult = await getComplaintKpis(previousParams, now);
    const previousByName = new Map(previousResult.distributions.byClassification.map((g) => [g.name, g.total]));
    trendRows = result.distributions.byClassification.map((group) => {
      const previousTotal = previousByName.get(group.name) ?? 0;
      const changePercent =
        previousTotal > 0 ? Math.round(((group.total - previousTotal) / previousTotal) * 1000) / 10 : null;
      return {
        name: group.name,
        total: group.total,
        previousTotal,
        changePercent,
        shareOfTotal: result.volume.total > 0 ? Math.round((group.total / result.volume.total) * 1000) / 10 : 0,
      };
    });
  }

  const sections: ReportSection[] = [
    {
      id: "kpi_overview",
      kind: "kpi",
      title: "المؤشرات الرئيسية",
      cards: [
        kpi("total", "إجمالي الشكاوى", result.volume.total),
        kpi("unclassified", "غير المصنفة", result.kpis.unclassifiedComplaints.currentValue),
      ],
    },
    {
      id: "group_breakdown",
      kind: "table",
      title: "الفئات والتصنيفات",
      table: groupTable("classification_breakdown", "الفئات والتصنيفات", result.distributions.byClassification),
    },
    {
      id: "trend",
      kind: "table",
      title: "الاتجاه مقارنة بالفترة السابقة",
      table: {
        id: "classification_trend",
        title: "الاتجاه مقارنة بالفترة السابقة",
        columns: [
          { key: "name", label: "التصنيف", format: "text" },
          { key: "total", label: "العدد الحالي", format: "number" },
          { key: "previousTotal", label: "العدد السابق", format: "number" },
          { key: "changePercent", label: "نسبة التغير%", format: "percent" },
          { key: "shareOfTotal", label: "النسبة من الإجمالي%", format: "percent" },
        ],
        rows: trendRows,
        truncated: false,
        totalMatched: trendRows.length,
      },
    },
  ];

  return {
    type: ReportType.CLASSIFICATION_ANALYSIS,
    title: request.title ?? getReportDefinition(ReportType.CLASSIFICATION_ANALYSIS).title,
    generatedAt: now.toISOString(),
    period: { from: filters.from, to: filters.to },
    filters,
    kpis: result.kpis,
    sections,
    warnings: [],
    rowCount: 0,
  };
}

async function buildComplaintDetailReport(
  request: ReportRequest,
  mode: "preview" | "run",
  now: Date
): Promise<ReportData> {
  const { filters, options } = request;
  const definition = getReportDefinition(ReportType.COMPLAINT_DETAIL);
  const params = buildComplaintQueryParams(filters);
  const kpisResult = await getComplaintKpis(params, now);
  const warnings: string[] = [];

  const limit = options.maxRows ?? definition.maxRows;
  const table = await fetchDetailTable(filters, limit, mode, definition.maxRows);
  if (table.truncated) {
    warnings.push(
      mode === "preview"
        ? "المعاينة تعرض جزءاً من النتائج فقط. استخدم التصدير للحصول على البيانات كاملة."
        : "تم اختصار عدد الصفوف وفق الحد الأقصى المسموح."
    );
  }

  const sections: ReportSection[] = [
    {
      id: "kpi_overview",
      kind: "kpi",
      title: "ملخص",
      cards: [
        kpi("total", "إجمالي الشكاوى المطابقة", kpisResult.volume.total),
        kpi("rowsIncluded", "عدد الصفوف في التقرير", table.rows.length),
      ],
    },
    { id: "detail_table", kind: "table", title: "تفاصيل الشكاوى", table },
  ];

  return {
    type: ReportType.COMPLAINT_DETAIL,
    title: request.title ?? definition.title,
    generatedAt: now.toISOString(),
    period: { from: filters.from, to: filters.to },
    filters,
    kpis: kpisResult.kpis,
    sections,
    warnings,
    rowCount: table.rows.length,
  };
}

async function buildOverdueComplaintsReport(
  request: ReportRequest,
  mode: "preview" | "run",
  now: Date
): Promise<ReportData> {
  const { filters, options } = request;
  const definition = getReportDefinition(ReportType.OVERDUE_COMPLAINTS);
  const params = buildComplaintQueryParams(filters);
  const kpisResult = await getComplaintKpis(params, now);
  const warnings: string[] = [];

  const limit = options.maxRows ?? definition.maxRows;
  const table = await fetchOverdueTable(filters, limit, mode);

  if (mode === "run" && table.totalMatched > definition.maxRows) {
    throw new ReportRowLimitExceededError(table.totalMatched, definition.maxRows);
  }
  if (table.truncated) {
    warnings.push(
      mode === "preview"
        ? "المعاينة تعرض جزءاً من الشكاوى المتأخرة فقط."
        : "تم اختصار عدد الصفوف وفق الحد الأقصى المسموح."
    );
  }

  const sections: ReportSection[] = [
    {
      id: "kpi_overview",
      kind: "kpi",
      title: "ملخص",
      cards: [
        kpi("currentlyLate", "المتأخرة حالياً", kpisResult.kpis.currentlyLateComplaints.currentValue),
        kpi("overdueNoAction", "متأخرة دون إجراء", kpisResult.performance.overdueNoAction),
      ],
    },
    { id: "overdue_table", kind: "table", title: "الشكاوى المتأخرة", table },
  ];

  return {
    type: ReportType.OVERDUE_COMPLAINTS,
    title: request.title ?? definition.title,
    generatedAt: now.toISOString(),
    period: { from: filters.from, to: filters.to },
    filters,
    kpis: kpisResult.kpis,
    sections,
    warnings,
    rowCount: table.rows.length,
  };
}

export async function buildReportData(
  request: ReportRequest,
  mode: "preview" | "run",
  now: Date = new Date()
): Promise<ReportData> {
  switch (request.type) {
    case ReportType.EXECUTIVE_SUMMARY: {
      if (isReportMode(request.options.reportMode)) {
        return buildExecutiveSummaryWithMode(request, mode, now, request.options.reportMode);
      }
      return buildExecutiveSummary(request, mode, now);
    }
    case ReportType.DEPARTMENT_PERFORMANCE: {
      const params = buildComplaintQueryParams(request.filters);
      const result = await getComplaintKpis(params, now);
      return buildGroupPerformanceReport(request, now, result, [
        { id: "group_breakdown", title: "أداء الإدارات", groups: result.distributions.byDepartment },
      ]);
    }
    case ReportType.REGION_FACILITY_PERFORMANCE: {
      const params = buildComplaintQueryParams(request.filters);
      const result = await getComplaintKpis(params, now);
      return buildGroupPerformanceReport(request, now, result, [
        { id: "group_breakdown_region", title: "أداء المناطق", groups: result.distributions.byRegion },
        { id: "group_breakdown_facility", title: "أداء المواقع", groups: result.distributions.byFacility },
      ]);
    }
    case ReportType.CLASSIFICATION_ANALYSIS:
      return buildClassificationAnalysis(request, now);
    case ReportType.COMPLAINT_DETAIL:
      return buildComplaintDetailReport(request, mode, now);
    case ReportType.OVERDUE_COMPLAINTS:
      return buildOverdueComplaintsReport(request, mode, now);
    default: {
      const exhaustiveCheck: never = request.type;
      throw new Error(`Unsupported report type: ${exhaustiveCheck}`);
    }
  }
}
