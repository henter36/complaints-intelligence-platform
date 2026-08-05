/**
 * Operational analytics contracts.
 * These fields are for analytics/filters/data-quality only — not reports/PDF/XLSX/CSV.
 */

export const OPERATIONAL_UNSPECIFIED = "__UNSPECIFIED__";
export const OPERATIONAL_UNSPECIFIED_LABEL = "غير محدد";

export const DATA_FRESHNESS_BUCKETS = [
  "fresh_1d",
  "stale_1_3d",
  "stale_3_7d",
  "stale_7d_plus",
  "missing",
] as const;

export type DataFreshnessBucket = (typeof DATA_FRESHNESS_BUCKETS)[number];

export const TEXT_SIGNAL_SOURCES = [
  "COMPLAINT_DESCRIPTION",
  "SOURCE_DETAIL",
  "ACTION_DESCRIPTION",
] as const;

export type TextSignalSource = (typeof TEXT_SIGNAL_SOURCES)[number];

export type OperationalAnalyticsFilters = {
  from?: string;
  to?: string;
  regionId?: string;
  departmentId?: string;
  classificationId?: string;
  categoryId?: string;
  channel?: string;
  status?: string;
  sourceOrigin?: string;
  sourceStatus?: string;
  sourceActionStatus?: string;
  wingCode?: string;
  sourceUpdatedFrom?: string;
  sourceUpdatedTo?: string;
  sourceModifiedFrom?: string;
  sourceModifiedTo?: string;
  hasActionTaken?: boolean;
  hasActionDescription?: boolean;
  hasResolution?: boolean;
  dataFreshnessBucket?: DataFreshnessBucket;
  /** Staff actor metrics — off by default; UI must not request without authorization. */
  includeStaffActors?: boolean;
};

export type OperationalBucketMetrics = {
  key: string;
  label: string;
  count: number;
  percentage: number;
  open: number;
  closed: number;
  currentlyLate: number;
  averageResolutionDays: number | null;
  previousCount: number | null;
  change: number | null;
  drillDownFilters: Record<string, string>;
};

export type SourceOriginDistribution = {
  items: OperationalBucketMetrics[];
  total: number;
};

export type SourceStatusDistribution = {
  items: OperationalBucketMetrics[];
  total: number;
  unspecifiedCount: number;
};

export type ActionStatusDistribution = {
  items: OperationalBucketMetrics[];
  total: number;
  unspecifiedCount: number;
};

export type ActionTakenQuality = {
  nonEmptyCount: number;
  emptyCount: number;
  uniqueCount: number;
  topNormalized: Array<{ label: string; count: number; percentage: number }>;
  rareValueShare: number;
  longTextShare: number;
  spellingVariantHints: Array<{ normalized: string; variants: string[]; totalCount: number }>;
};

export type DataFreshnessMetrics = {
  lastSourceUpdatedAt: string | null;
  lastSourceUpdatedAtRiyadh: string | null;
  oldestSourceUpdatedAt: string | null;
  oldestSourceUpdatedAtRiyadh: string | null;
  averageAgeDays: number | null;
  freshShare: number;
  staleShare: number;
  buckets: Array<{
    bucket: DataFreshnessBucket;
    label: string;
    count: number;
    percentage: number;
    drillDownFilters: Record<string, string>;
  }>;
  missingUpdatedAt: number;
  missingModifiedAt: number;
  modifiedBeforeUpdated: number;
  updatedVsModifiedDiffHoursAvg: number | null;
};

export type WingOperationalMetrics = {
  items: Array<{
    key: string;
    label: string;
    count: number;
    percentage: number;
    open: number;
    closed: number;
    currentlyLate: number;
    topClassification: string | null;
    topClassificationCount: number;
    drillDownFilters: Record<string, string>;
  }>;
  unspecifiedCount: number;
  total: number;
};

export type OperationalDataQualitySignal = {
  id: string;
  label: string;
  count: number;
  percentage: number;
  severity: "info" | "warning" | "critical";
  explanation: string;
  drillDownFilters: Record<string, string>;
};

export type StaffActorMetrics = {
  enabled: boolean;
  reason?: string;
  closers?: Array<{ maskedId: string; closeCount: number }>;
  updaters?: Array<{ maskedId: string; updateCount: number }>;
  emptyClosedBy: number;
  emptyUpdatedBy: number;
};

export type OperationalAnalyticsSummary = {
  totalInScope: number;
  generatedAt: string;
  timezoneDisplay: "Asia/Riyadh";
  sourceOrigin: SourceOriginDistribution;
  sourceStatus: SourceStatusDistribution;
  sourceActionStatus: ActionStatusDistribution;
  channelIndependentCheck: {
    sourceOriginKeys: number;
    channelKeys: number;
    note: string;
  };
  actionTakenQuality: ActionTakenQuality;
  wing: WingOperationalMetrics;
  freshness: DataFreshnessMetrics;
  dataQuality: OperationalDataQualitySignal[];
  staffActors: StaffActorMetrics;
  performanceMs: Record<string, number>;
};
