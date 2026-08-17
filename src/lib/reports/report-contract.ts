/**
 * Shared contract types for the enhanced reporting system.
 *
 * This file is the single source of truth for types that must be consistent
 * across data services, PDF renderers, XLSX renderers, and UI components.
 * Importing from this file (rather than from individual service files) prevents
 * circular dependencies and makes the contract explicitly stable.
 */

// ---------------------------------------------------------------------------
// Report mode
// ---------------------------------------------------------------------------

/**
 * Controls the presentation format of the report output.
 * Stored as a string literal in the options JSON column of ReportTemplate
 * and ReportRun — no schema migration required.
 */
export type ReportMode =
  | "STANDARD"                  // Existing full-section report
  | "DIGITAL_EXECUTIVE_BRIEF"   // 4-page 16:9 digital slides
  | "FULL_ANALYTICAL"           // Unlimited-page portrait deep-dive on the readable report canvas
  | "PRINT_EXECUTIVE_BRIEF"     // 4-page print-oriented complaints report
  | "PRINT_EXECUTIVE_BRIEF_V2"; // 4-page print report — redesigned V2 layout

export const REPORT_MODES = [
  "STANDARD",
  "DIGITAL_EXECUTIVE_BRIEF",
  "FULL_ANALYTICAL",
  "PRINT_EXECUTIVE_BRIEF",
  "PRINT_EXECUTIVE_BRIEF_V2",
] as const satisfies readonly ReportMode[];

export function isReportMode(value: unknown): value is ReportMode {
  return typeof value === "string" && (REPORT_MODES as readonly string[]).includes(value);
}

export type ComparisonMode =
  | "PREVIOUS_EQUIVALENT_PERIOD"
  | "SAME_PERIOD_LAST_YEAR";

export const COMPARISON_MODES = [
  "PREVIOUS_EQUIVALENT_PERIOD",
  "SAME_PERIOD_LAST_YEAR",
] as const satisfies readonly ComparisonMode[];

export function isComparisonMode(value: unknown): value is ComparisonMode {
  return typeof value === "string"
    && (COMPARISON_MODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Executive brief page plan
// ---------------------------------------------------------------------------

export type ExecutiveBriefPreviewPage = 1 | 2 | 3 | 4;

export type ExecutiveBriefPagePlanEntry = {
  page: ExecutiveBriefPreviewPage;
  title: string;
  sectionIds: readonly string[];
};

/**
 * Shared page ownership for the four-page complaints report. Renderers own the
 * visual layout, while data builders and previews share this stable metadata.
 */
export const EXECUTIVE_BRIEF_PAGE_PLAN = [
  {
    page: 1,
    title: "الغلاف",
    sectionIds: [],
  },
  {
    page: 2,
    title: "ملخص المؤشرات والاتجاه الزمني",
    sectionIds: ["kpi_overview", "region_trend_chart", "comparison"],
  },
  {
    page: 3,
    title: "المناطق",
    sectionIds: ["region_changes", "top_regions"],
  },
  {
    page: 4,
    title: "التصنيفات والإدارات والاستنتاجات",
    sectionIds: ["top_classifications", "top_departments", "dept_class_rises", "executive_summary_text", "overdue_table"],
  },
] as const satisfies readonly ExecutiveBriefPagePlanEntry[];

export type ExecutiveBriefSectionPlacement = {
  previewPage: ExecutiveBriefPreviewPage;
  previewOrder: number;
};

export function getExecutiveBriefSectionPlacement(
  sectionId: string
): ExecutiveBriefSectionPlacement | null {
  for (const pagePlan of EXECUTIVE_BRIEF_PAGE_PLAN) {
    const previewOrder = (pagePlan.sectionIds as readonly string[]).indexOf(sectionId);
    if (previewOrder >= 0) {
      return { previewPage: pagePlan.page, previewOrder };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Executive brief KPI card (with comparison + assessment)
// ---------------------------------------------------------------------------

export type KpiAssessment = "positive" | "negative" | "neutral" | "warning";

/**
 * Extended KPI card used in executive brief layouts. Includes the previous
 * period value and a pre-computed directional assessment so the renderer
 * can choose colours without re-applying business logic.
 */
export type ExecutiveBriefKpiCard = {
  key: string;
  label: string;
  value: number | null;
  previousValue: number | null;
  difference: number | null;
  changeRate: number | null;
  format: "number" | "percent" | "days";
  /** Directional interpretation from the operational perspective (not just
   *  the numeric direction). e.g., fewer overdue = "positive". */
  assessment: KpiAssessment;
};

// ---------------------------------------------------------------------------
// Region reference row (Left-Join against all known regions)
// ---------------------------------------------------------------------------

/**
 * A row in the "all regions" reference table. Regions with zero complaints
 * in the current period are included (Left Join semantics) with currentCount=0.
 */
export type RegionReferenceRow = {
  regionName: string;
  currentCount: number;
  previousCount: number;
  difference: number;
  changeRate: number | null;
  complianceRate: number | null;
  averageResolutionDays: number | null;
  openCount?: number;
  closedCount?: number;
  currentlyLate: number;
  direction: string;
};

// ---------------------------------------------------------------------------
// Classification brief row
// ---------------------------------------------------------------------------

/**
 * One classification in the "top N classifications" executive brief analysis.
 * Grouped by classificationId (not display name) to avoid double-counting when
 * the same logical classification appears under two Arabic-name variants.
 */
export type ClassificationBriefRow = {
  categoryId: string | null;
  categoryName: string;
  classificationId: string;
  classificationName: string;
  /** Display path: categoryName / classificationName (or single name when equal). */
  classificationPath: string;
  currentCount: number;
  previousCount: number;
  difference: number;
  changeRate: number | null;
  shareOfTotal: number;
};

export type ExecutiveEntityRow = {
  name: string;
  total: number;
  open: number;
  closed: number;
  currentlyLate: number;
  shareOfTotal: number;
};

// ---------------------------------------------------------------------------
// Classification trend row (V2-only "أبرز اتجاهات التصنيفات عبر الفترات")
// ---------------------------------------------------------------------------

/** The six pattern labels spec §1 requires — see classificationTrendPatternLabel(). */
export type ClassificationTrendPatternLabel =
  | "استمرار مرتفع"
  | "تصاعد مستمر"
  | "تحسن مستدام"
  | "عودة للارتفاع بعد تحسن"
  | "مشكلة ناشئة"
  | "متذبذب"
  | "نمط ملحوظ";

/**
 * One facility×classification's multi-period trend, sourced directly from
 * the pattern-analysis engine's own AnalyticalFinding[] (never recomputed
 * here) — replaces the old current/previous-only ClassificationChangeRow.
 * `facility` and `classification` are split from the finding's own
 * entityName ("facility — classification") into independent columns so a
 * long facility or classification name is never silently concatenated and
 * truncated together (spec §3).
 */
export type ClassificationTrendRow = {
  facility: string;
  classification: string;
  currentCount: number;
  difference: number;
  /** Last up to 5 period counts, oldest→newest, e.g. "38، 42، 43، 46" — NOT the full streak (spec §4). */
  trail: string;
  /** Real streak length, which may exceed the number of values shown in `trail`. */
  streakPeriods: number;
  patternLabel: ClassificationTrendPatternLabel;
  priorityScore: number;
};

// ---------------------------------------------------------------------------
// Facility follow-up / improvement rows (V2-only page 4 facility sections)
// ---------------------------------------------------------------------------

export type FacilityPriorityBandLabel = "مرتفعة" | "متوسطة" | "منخفضة";

/**
 * A facility ranked by follow-up priority (spec §3, revised §1/§10/§11) —
 * replaces the old volume-only "أعلى السجون". `totalComplaints` is always
 * sourced from the SAME per-facility current-period total the pattern engine
 * itself computed internally (never a separately-computed snapshot number),
 * so it can never contradict the finding that drove this row onto the list.
 * `isHistoricalOnly` is true only for the narrow, explicitly-justified case
 * where the facility's real current-period total is 0 but a chronic/relapse
 * finding with genuine multi-period history still warrants follow-up.
 */
export type FacilityFollowUpRow = {
  facility: string;
  totalComplaints: number;
  isHistoricalOnly: boolean;
  topIssueLabel: string;
  patternLabel: ClassificationTrendPatternLabel | "—";
  streakPeriods: number | null;
  /** Distinct repeat complainants at this facility, or null when no REPEAT_COMPLAINANT finding applies. */
  repeatComplainants: number | null;
  /** Total repeated complaints tied to those complainants, or null. */
  repeatComplaints: number | null;
  /** Distinct complainants behind a mass/collective complaint, or null when no MASS_COMPLAINT finding applies. */
  spreadComplainants: number | null;
  /** Total complaints behind that mass/collective complaint, or null. */
  spreadComplaints: number | null;
  priorityBand: FacilityPriorityBandLabel;
  priorityScore: number;
  /** Tie-break inputs (spec §11) — not rendered directly. */
  isChronic: boolean;
  distinctComplainantsForRanking: number;
};

/** A facility with a real, multi-period, sustained decline (spec §4) — replaces the old lowest-volume "أقل السجون". */
export type FacilityImprovementRow = {
  facility: string;
  startValue: number;
  currentValue: number;
  decrease: number;
  streakPeriods: number;
  classificationLabel: string;
};

// ---------------------------------------------------------------------------
// Comparative timeline chart (current vs previous, relative day axis)
// ---------------------------------------------------------------------------

/**
 * A data-point on the relative-day axis of the comparative timeline chart.
 * `relativeDay` starts at 1 (first day of each period) regardless of the
 * absolute calendar date, allowing a direct visual overlay of both periods.
 */
export type ComparativeTimelinePoint = { relativeDay: number; count: number; label?: string };

export type ComparativeTimelineSeries = {
  label: string;
  points: ComparativeTimelinePoint[];
};

export type ComparativeTimelineData = {
  current: ComparativeTimelineSeries;
  previous: ComparativeTimelineSeries | null;
  periodDays: number;
  aggregation?: "daily" | "weekly" | "monthly";
};

// ---------------------------------------------------------------------------
// V2 monthly complaint trend (backward-looking history window)
// ---------------------------------------------------------------------------

/**
 * One calendar-month point on the V2 executive brief timeline chart.
 * received/closed are flow metrics (events during the month).
 * open/late at month-end are stock metrics (snapshot at month boundary).
 */
export type MonthlyComplaintTrendPoint = {
  monthKey: string;
  monthLabel: string;
  receivedCount: number;
  closedDuringMonthCount: number;
  openAtMonthEndCount: number;
  lateAtMonthEndCount: number;
};

// ---------------------------------------------------------------------------
// Concentration analysis
// ---------------------------------------------------------------------------

/** Share of total complaints held by the top-1, top-3, and top-5 entities. */
export type ConcentrationBand = {
  entityType: "region" | "classification" | "department";
  top1SharePercent: number;
  top3SharePercent: number;
  top5SharePercent: number;
  totalEntities: number;
};

// ---------------------------------------------------------------------------
// Net backlog flow
// ---------------------------------------------------------------------------

/**
 * Summarises the net change in the open-complaint backlog during the period.
 * inflow  = complaints received in [from, to]
 * outflow = status transitions to CLOSED/RESOLVED in [from, to]
 * net     = inflow – outflow  (positive → backlog grew, negative → backlog shrank)
 */
export type NetBacklogFlow = {
  inflow: number;
  outflow: number;
  net: number;
  periodDays: number;
};

// ---------------------------------------------------------------------------
// Performance vs volume (department or region rows)
// ---------------------------------------------------------------------------

export type PerfVolumeRow = {
  entityName: string;
  totalComplaints: number;
  complianceRate: number | null;
  averageResolutionDays: number | null;
  currentlyLate: number;
  share: number;
};

// ---------------------------------------------------------------------------
// Matrix section (classification × department / classification × region)
// ---------------------------------------------------------------------------

/**
 * A two-dimensional cross-tabulation section. Row and column headers are
 * ordered by their respective totals (descending).
 */
export type ReportMatrixSection = {
  id: string;
  kind: "matrix";
  title: string;
  description?: string;
  rowLabel: string;
  columnLabel: string;
  rowHeaders: string[];
  columnHeaders: string[];
  cells: number[][];
  rowTotals: number[];
  columnTotals: number[];
  grandTotal: number;
  totalRows: number;        // total rows before truncation
  totalColumns: number;     // total columns before truncation
  truncatedRows: boolean;   // rows were truncated
  truncatedColumns: boolean; // columns were truncated
  truncated: boolean;       // = truncatedRows || truncatedColumns (back-compat)
  maxRows: number;
  maxColumns: number;
  previewPage?: ExecutiveBriefPreviewPage;
  previewOrder?: number;
};

// ---------------------------------------------------------------------------
// Period snapshot metrics — flow (during the period) vs. stock (at period end)
// ---------------------------------------------------------------------------

/**
 * The four period-snapshot indicators. `receivedDuringPeriod` and
 * `closedDuringPeriod` are flow metrics (events inside [from, toExclusive)).
 * `openAtEnd` and `lateAtEnd` are stock metrics (state at the instant
 * `toExclusive`) and are NOT derivable as receivedDuringPeriod − closedDuringPeriod.
 */
export type PeriodSnapshotMetrics = {
  receivedDuringPeriod: number;
  closedDuringPeriod: number;
  openAtEnd: number;
  lateAtEnd: number;
};

/** Cover-page period metrics: current period plus (when available) the previous period. */
export type ExecutivePeriodMetrics = {
  current: PeriodSnapshotMetrics;
  previous: PeriodSnapshotMetrics | null;
};

/** Region-level stock at current period end (currentCount/previousCount stay Inflow-based elsewhere). */
export type RegionSnapshotAtEndRow = {
  regionName: string;
  openAtEnd: number;
  lateAtEnd: number;
};

/** Department-level flow + stock metrics for the current period. */
export type DepartmentPeriodMetricsRow = {
  departmentName: string;
} & PeriodSnapshotMetrics;

/** Classification-level stock at current period end, covering every classification (not just top N). */
export type ClassificationSnapshotAtEndRow = {
  classificationId: string;
  openAtEnd: number;
  lateAtEnd: number;
};

// ---------------------------------------------------------------------------
// Continuity row (re-occurrence of classification in a department)
// ---------------------------------------------------------------------------

export type ContinuityRow = {
  departmentName: string;
  classificationName: string;
  classificationPath: string;
  currentCount: number;
  previousCount: number;
  appearsInBothPeriods: boolean;
  recurrenceType: "persistent" | "new" | "resolved";
};
