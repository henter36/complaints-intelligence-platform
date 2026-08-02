import { z } from "zod";
import { ReportType } from "@prisma/client";
import { COMPARISON_MODES, REPORT_MODES } from "@/lib/reports/report-contract";

export { ReportType };

export const REPORT_MAX_RANGE_DAYS = 366;

export type ReportSectionId =
  | "period_summary"
  | "kpi_overview"
  | "comparison"
  | "trend"
  | "top_regions"
  | "top_departments"
  | "top_classifications"
  | "channel_distribution"
  | "priority_table"
  | "overdue_table"
  | "detail_table"
  | "group_breakdown";

export type ReportDefinition = {
  type: ReportType;
  title: string;
  description: string;
  supportedFilters: readonly string[];
  sections: readonly ReportSectionId[];
  defaultColumns: readonly string[];
  maxRows: number;
  supportsPdf: boolean;
  supportsXlsx: boolean;
  requiresPeriod: boolean;
};

const COMMON_FILTERS = [
  "from",
  "to",
  "region",
  "department",
  "facility",
  "classificationId",
  "categoryId",
  "priority",
  "severity",
  "channel",
  "status",
] as const;

const DETAIL_COLUMNS = [
  "complaintNumber",
  "receivedDate",
  "status",
  "subject",
  "region",
  "facility",
  "department",
  "classification",
  "priority",
  "channel",
  "dueDate",
  "closedAt",
  "isLate",
  "latenessDays",
  "resolutionDays",
] as const;

const OVERDUE_COLUMNS = [
  "complaintNumber",
  "subject",
  "priority",
  "department",
  "region",
  "classification",
  "dueDate",
  "latenessDays",
  "status",
] as const;

export const REPORT_DEFINITIONS: Record<ReportType, ReportDefinition> = {
  EXECUTIVE_SUMMARY: {
    type: ReportType.EXECUTIVE_SUMMARY,
    title: "تقرير الشكاوى",
    description: "نظرة شاملة على أداء الشكاوى خلال الفترة المحددة مع مقارنة بالفترة السابقة.",
    supportedFilters: COMMON_FILTERS,
    sections: [
      "period_summary",
      "kpi_overview",
      "comparison",
      "trend",
      "top_regions",
      "top_departments",
      "top_classifications",
      "channel_distribution",
      "overdue_table",
    ],
    defaultColumns: OVERDUE_COLUMNS,
    maxRows: 500,
    supportsPdf: true,
    supportsXlsx: true,
    requiresPeriod: true,
  },
  DEPARTMENT_PERFORMANCE: {
    type: ReportType.DEPARTMENT_PERFORMANCE,
    title: "تقرير أداء الإدارات",
    description: "مؤشرات الأداء التفصيلية لكل إدارة خلال الفترة المحددة.",
    supportedFilters: COMMON_FILTERS,
    sections: ["period_summary", "kpi_overview", "group_breakdown"],
    defaultColumns: [],
    maxRows: 1000,
    supportsPdf: true,
    supportsXlsx: true,
    requiresPeriod: true,
  },
  REGION_FACILITY_PERFORMANCE: {
    type: ReportType.REGION_FACILITY_PERFORMANCE,
    title: "تقرير أداء المناطق والمواقع",
    description: "مؤشرات الأداء مجمعة حسب المنطقة والموقع خلال الفترة المحددة.",
    supportedFilters: COMMON_FILTERS,
    sections: ["period_summary", "kpi_overview", "group_breakdown"],
    defaultColumns: [],
    maxRows: 1000,
    supportsPdf: true,
    supportsXlsx: true,
    requiresPeriod: true,
  },
  CLASSIFICATION_ANALYSIS: {
    type: ReportType.CLASSIFICATION_ANALYSIS,
    title: "تقرير التصنيفات",
    description: "توزيع الشكاوى حسب الفئات والتصنيفات مع اتجاهها ونسبتها من الإجمالي.",
    supportedFilters: COMMON_FILTERS,
    sections: ["period_summary", "kpi_overview", "group_breakdown", "trend"],
    defaultColumns: [],
    maxRows: 1000,
    supportsPdf: true,
    supportsXlsx: true,
    requiresPeriod: true,
  },
  COMPLAINT_DETAIL: {
    type: ReportType.COMPLAINT_DETAIL,
    title: "تقرير الشكاوى التفصيلي",
    description: "جدول تفصيلي للشكاوى المطابقة للفلاتر الحالية دون بيانات شخصية حساسة.",
    supportedFilters: COMMON_FILTERS,
    sections: ["period_summary", "kpi_overview", "detail_table"],
    defaultColumns: DETAIL_COLUMNS,
    maxRows: 10_000,
    supportsPdf: false,
    supportsXlsx: true,
    requiresPeriod: true,
  },
  OVERDUE_COMPLAINTS: {
    type: ReportType.OVERDUE_COMPLAINTS,
    title: "تقرير المتأخرات",
    description: "الشكاوى المفتوحة المتأخرة عن مهلة الاستحقاق مع عدد أيام التأخر.",
    supportedFilters: COMMON_FILTERS,
    sections: ["period_summary", "kpi_overview", "overdue_table"],
    defaultColumns: OVERDUE_COLUMNS,
    maxRows: 5000,
    supportsPdf: true,
    supportsXlsx: true,
    requiresPeriod: true,
  },
};

export function getReportDefinition(type: ReportType): ReportDefinition {
  return REPORT_DEFINITIONS[type];
}

export function listReportDefinitions(): ReportDefinition[] {
  return Object.values(REPORT_DEFINITIONS);
}

// ---------------------------------------------------------------------------
// Request contract (Zod)
// ---------------------------------------------------------------------------

const SAFE_TITLE_PATTERN = /^[^<>]*$/;

const isoDateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "صيغة التاريخ يجب أن تكون YYYY-MM-DD");

/** `new Date("2026-02-30")` silently rolls over to March 2 instead of
 * failing, so a regex-valid but calendar-invalid date must be caught
 * separately by comparing the parsed UTC components back to the input. */
function isCalendarValidIsoDate(input: string, parsed: Date): boolean {
  const [year, month, day] = input.split("-").map(Number);
  return (
    parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() + 1 === month
    && parsed.getUTCDate() === day
  );
}

export const reportFiltersSchema = z
  .object({
    from: isoDateOnly,
    to: isoDateOnly,
    region: z.string().trim().min(1).max(200).optional(),
    department: z.string().trim().min(1).max(200).optional(),
    facility: z.string().trim().min(1).max(200).optional(),
    classificationId: z.string().trim().min(1).max(200).optional(),
    categoryId: z.string().trim().min(1).max(200).optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
    severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
    channel: z.string().trim().min(1).max(200).optional(),
    status: z
      .enum(["NEW", "OPEN", "IN_PROGRESS", "AWAITING_RESPONSE", "RESOLVED", "CLOSED", "CANCELLED"])
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const from = new Date(value.from);
    const to = new Date(value.to);
    if (
      Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())
      || !isCalendarValidIsoDate(value.from, from) || !isCalendarValidIsoDate(value.to, to)
    ) {
      ctx.addIssue({ code: "custom", message: "تاريخ غير صالح" });
      return;
    }
    if (from > to) {
      ctx.addIssue({ code: "custom", message: "يجب أن يكون تاريخ البداية قبل أو يساوي تاريخ النهاية" });
      return;
    }
    const rangeDays = (to.getTime() - from.getTime()) / 86_400_000;
    if (rangeDays > REPORT_MAX_RANGE_DAYS) {
      ctx.addIssue({
        code: "custom",
        message: `أقصى مدة مسموحة للتقرير هي ${REPORT_MAX_RANGE_DAYS} يوماً`,
      });
    }
  });

export const reportOptionsSchema = z
  .object({
    includeComparison: z.boolean().default(false),
    includeCharts: z.boolean().default(true),
    includeDetailedRows: z.boolean().default(false),
    includeSensitiveFields: z.literal(false).default(false),
    maxRows: z.coerce.number().int().positive().max(10_000).optional(),
    columns: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    reportMode: z.enum(REPORT_MODES).optional(),
    comparisonMode: z.enum(COMPARISON_MODES).optional(),
  })
  .strict();

const DEFAULT_REPORT_OPTIONS = reportOptionsSchema.parse({});

export const reportRequestSchema = z
  .object({
    type: z.enum(ReportType, { error: () => "نوع التقرير غير معروف" }),
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(SAFE_TITLE_PATTERN, "لا يسمح بوسوم HTML في عنوان التقرير")
      .optional(),
    filters: reportFiltersSchema,
    options: reportOptionsSchema.optional().default(DEFAULT_REPORT_OPTIONS),
  })
  .strict();

export type ReportRequest = z.infer<typeof reportRequestSchema>;
export type ReportFilters = z.infer<typeof reportFiltersSchema>;
export type ReportOptions = z.infer<typeof reportOptionsSchema>;

export class ReportRequestValidationError extends Error {
  readonly code = "INVALID_REPORT_REQUEST";
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues[0] ?? "طلب التقرير غير صالح");
    this.name = "ReportRequestValidationError";
    this.issues = issues;
  }
}

export function isReportRequestValidationError(error: unknown): error is ReportRequestValidationError {
  return error instanceof ReportRequestValidationError;
}

export function parseReportRequest(input: unknown): ReportRequest {
  const parsed = reportRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new ReportRequestValidationError(parsed.error.issues.map((issue) => issue.message));
  }

  const definition = getReportDefinition(parsed.data.type);
  const effectiveMaxRows = Math.min(
    parsed.data.options.maxRows ?? definition.maxRows,
    definition.maxRows
  );
  const reportMode = parsed.data.type === ReportType.EXECUTIVE_SUMMARY
    ? parsed.data.options.reportMode ?? "STANDARD"
    : "STANDARD";
  const comparisonMode = parsed.data.options.comparisonMode
    ?? "PREVIOUS_EQUIVALENT_PERIOD";

  if (parsed.data.options.columns) {
    const allowed = new Set(definition.defaultColumns);
    const unknownColumns = parsed.data.options.columns.filter((column) => !allowed.has(column));
    if (unknownColumns.length > 0) {
      throw new ReportRequestValidationError([`أعمدة غير مسموحة: ${unknownColumns.join(", ")}`]);
    }
  }

  if (!definition.supportsPdf && !definition.supportsXlsx) {
    throw new ReportRequestValidationError(["نوع التقرير لا يدعم أي صيغة تصدير"]);
  }

  return {
    ...parsed.data,
    options: {
      ...parsed.data.options,
      maxRows: effectiveMaxRows,
      reportMode,
      comparisonMode,
    },
  };
}

export function buildComplaintQueryParams(filters: ReportFilters): URLSearchParams {
  const params = new URLSearchParams();
  params.set("from", filters.from);
  params.set("to", filters.to);
  if (filters.region) params.set("region", filters.region);
  if (filters.department) params.set("department", filters.department);
  if (filters.facility) params.set("facility", filters.facility);
  if (filters.classificationId) params.set("classificationId", filters.classificationId);
  if (filters.categoryId) params.set("categoryId", filters.categoryId);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.severity) params.set("severity", filters.severity);
  if (filters.channel) params.set("channel", filters.channel);
  if (filters.status) params.set("status", filters.status);
  return params;
}
