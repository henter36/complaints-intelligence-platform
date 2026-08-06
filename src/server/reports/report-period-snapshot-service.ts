/**
 * Period-snapshot metrics for executive reports.
 *
 * Distinguishes two kinds of measures that earlier report code conflated:
 *  - Flow metrics (events that happened during [from, toExclusive)):
 *    `receivedDuringPeriod`, `closedDuringPeriod`.
 *  - Stock metrics (state as of the instant `toExclusive`):
 *    `openAtEnd`, `lateAtEnd`.
 *
 * Stock metrics require reconstructing each complaint's status at a historical
 * instant from `ComplaintStatusHistory`, not from its current `status` column —
 * a complaint closed after the period end is still "open at period end", and a
 * complaint whose current status is CLOSED because it closed *before* the period
 * even started must not be replayed as if it just closed now.
 */

import type { ComplaintStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  COMPLAINT_SLA_DURATION_MS,
  resolveComplaintCreatedAt,
  resolveComplaintEffectiveClosedAt,
} from "@/server/complaints/complaint-sla-timing";
import { isClosedComplaintStatus, isOpenComplaintStatus } from "@/server/complaints/status";
import { buildComplaintWhere, parseComplaintQuery } from "@/server/complaints/complaint-query-service";
import { buildComplaintQueryParams, type ReportFilters } from "./report-definition-service";
import type { PeriodRange } from "./report-comparison";
import { classificationKey } from "@/lib/reports/classification-keys";
import { normalizeRegionName } from "@/lib/reports/region-normalization";

const UNSPECIFIED_DEPARTMENT_LABEL = "غير محدد";

function isValidDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ReportPeriodSnapshot = {
  period: PeriodRange;
  receivedDuringPeriod: number;
  closedDuringPeriod: number;
  openAtEnd: number;
  lateAtEnd: number;
};

export type ReportPeriodGroupSnapshot = {
  receivedDuringPeriod: number;
  closedDuringPeriod: number;
  openAtEnd: number;
  lateAtEnd: number;
};

export type ExecutiveReportSnapshotData = {
  current: ReportPeriodSnapshot;
  previous: ReportPeriodSnapshot | null;
  byRegion: Record<string, ReportPeriodGroupSnapshot>;
  byDepartment: Record<string, ReportPeriodGroupSnapshot>;
  byClassification: Record<string, ReportPeriodGroupSnapshot>;
  warnings: string[];
};

export type ComplaintStatusHistoryEntry = {
  fromStatus: ComplaintStatus | null;
  toStatus: ComplaintStatus;
  changedAt: Date;
};

export type ComplaintOpenStateInput = {
  status: ComplaintStatus;
  complaintDate: Date | null;
  receivedAt: Date;
  closedAt: Date | null;
  sourceUpdatedAt: Date | null;
  statusHistory: readonly ComplaintStatusHistoryEntry[];
  measuredAt: Date;
};

export type ComplaintOpenStateResult = {
  isOpen: boolean;
  /** The resolved status enum when known; null when only isOpen could be established. */
  resolvedStatus: ComplaintStatus | null;
  /** False means the state could not be determined reliably — callers must not guess. */
  certain: boolean;
};

// ---------------------------------------------------------------------------
// Historical status resolution (section 6)
// ---------------------------------------------------------------------------

/**
 * Resolves whether a complaint was open at a historical instant `measuredAt`.
 *
 * Evidence order:
 *  1. The latest ComplaintStatusHistory entry strictly before measuredAt — its
 *     toStatus is the state at measuredAt.
 *  2. When no such entry exists, the earliest entry at/after measuredAt whose
 *     fromStatus is known — that fromStatus was the state at measuredAt.
 *  3. A conservative fallback using the current status + effective closure
 *     date, for legacy records with no usable status history.
 *  4. When none of the above can determine the state reliably, `certain` is
 *     false and callers must exclude the complaint rather than guess.
 */
export function resolveComplaintOpenStateAt(
  options: ComplaintOpenStateInput
): ComplaintOpenStateResult {
  const measuredMs = options.measuredAt.getTime();

  let priorEntry: ComplaintStatusHistoryEntry | null = null;
  let nextEntry: ComplaintStatusHistoryEntry | null = null;
  for (const entry of options.statusHistory) {
    if (!isValidDate(entry.changedAt)) continue;
    const changedMs = entry.changedAt.getTime();
    if (changedMs < measuredMs) {
      if (!priorEntry || changedMs > priorEntry.changedAt.getTime()) {
        priorEntry = entry;
      }
    } else if (!nextEntry || changedMs < nextEntry.changedAt.getTime()) {
      nextEntry = entry;
    }
  }

  if (priorEntry) {
    const status = priorEntry.toStatus;
    return { isOpen: isOpenComplaintStatus(status), resolvedStatus: status, certain: true };
  }

  if (nextEntry && nextEntry.fromStatus !== null) {
    const status = nextEntry.fromStatus;
    return { isOpen: isOpenComplaintStatus(status), resolvedStatus: status, certain: true };
  }

  return resolveOpenStateFallback(options, measuredMs);
}

/** Conservative fallback for complaints with no usable ComplaintStatusHistory. */
function resolveOpenStateFallback(
  options: ComplaintOpenStateInput,
  measuredMs: number
): ComplaintOpenStateResult {
  if (isOpenComplaintStatus(options.status)) {
    // A stray closedAt in the past (data artifact, since status is open) is
    // treated as ambiguous rather than silently assumed still-open.
    const hasPriorClosureEvidence =
      options.closedAt !== null && options.closedAt.getTime() < measuredMs;
    if (hasPriorClosureEvidence) {
      return { isOpen: false, resolvedStatus: null, certain: false };
    }
    return { isOpen: true, resolvedStatus: options.status, certain: true };
  }

  if (isClosedComplaintStatus(options.status)) {
    const effectiveClosedAt = resolveComplaintEffectiveClosedAt({
      status: options.status,
      complaintDate: options.complaintDate,
      receivedAt: options.receivedAt,
      closedAt: options.closedAt,
      lastUpdatedAt: options.sourceUpdatedAt,
    });
    if (effectiveClosedAt === null) {
      return { isOpen: false, resolvedStatus: null, certain: false };
    }
    if (effectiveClosedAt.getTime() >= measuredMs) {
      return { isOpen: true, resolvedStatus: null, certain: true };
    }
    return { isOpen: false, resolvedStatus: options.status, certain: true };
  }

  // CANCELLED (or any future terminal status outside open/closed groups):
  // never open unless step 1/2 history already proved otherwise above.
  return { isOpen: false, resolvedStatus: options.status, certain: true };
}

// ---------------------------------------------------------------------------
// Pure aggregation over an already-loaded candidate set
// ---------------------------------------------------------------------------

export type SnapshotCandidate = {
  id: string;
  status: ComplaintStatus;
  complaintDate: Date | null;
  receivedAt: Date;
  closedAt: Date | null;
  sourceUpdatedAt: Date | null;
  region: string | null;
  department: string | null;
  classificationId: string | null;
  statusHistory: readonly ComplaintStatusHistoryEntry[];
};

function isWithinPeriod(instant: Date, period: PeriodRange): boolean {
  if (!isValidDate(instant)) return false;
  const t = instant.getTime();
  return t >= period.from.getTime() && t < period.toExclusive.getTime();
}

/**
 * A StatusHistory entry only documents a genuine closure *event* when it has
 * a known `fromStatus` — that means the complaint actually moved from some
 * status into a closed one. A `fromStatus: null` entry is a creation record
 * (e.g. `Created from confirmed import`, `changedAt` = import processing
 * time): it records that the complaint *entered the system already closed*,
 * not that a closure happened at that instant. Counting those as closure
 * events would misdate every imported closed complaint to its import
 * timestamp instead of leaving it to the effective-closed-date fallback.
 *
 * A `changedAt` that fails to parse to a valid instant is treated the same
 * way as a missing `fromStatus`: not genuine. Otherwise a corrupt timestamp
 * would make {@link hasGenuineClosureTransition} report true and permanently
 * disable the effective-closed-date fallback for that complaint, even though
 * the corrupt entry itself can never satisfy {@link isWithinPeriod}.
 */
function isGenuineClosureTransition(entry: ComplaintStatusHistoryEntry): boolean {
  return (
    entry.fromStatus !== null
    && isClosedComplaintStatus(entry.toStatus)
    && isValidDate(entry.changedAt)
  );
}

/** Minimal shape {@link wasComplaintClosedInWindow} needs — any richer candidate (e.g. {@link SnapshotCandidate}) satisfies it structurally. */
export type ClosureResolutionInput = {
  status: ComplaintStatus;
  complaintDate: Date | null;
  receivedAt: Date;
  closedAt: Date | null;
  sourceUpdatedAt: Date | null;
  statusHistory: readonly ComplaintStatusHistoryEntry[];
};

function hasGenuineClosureTransition(complaint: ClosureResolutionInput): boolean {
  return complaint.statusHistory.some(isGenuineClosureTransition);
}

/**
 * Resolves whether a complaint closed within [from, toExclusive), using the
 * same evidence order as {@link resolveComplaintOpenStateAt}: a genuine
 * StatusHistory closure transition first, and — only when the complaint has
 * no such transition anywhere in its history — the central effective-closed-
 * date fallback. Each complaint yields at most one true/false answer per
 * window, so a caller iterating complaints can never double-count. Reused by
 * both the period snapshot and the monthly trend chart so closure-event
 * detection cannot drift between the two.
 */
export function wasComplaintClosedInWindow(
  complaint: ClosureResolutionInput,
  window: PeriodRange
): boolean {
  if (hasGenuineClosureTransition(complaint)) {
    return complaint.statusHistory.some(
      (entry) => isGenuineClosureTransition(entry) && isWithinPeriod(entry.changedAt, window)
    );
  }
  const effectiveClosedAt = resolveComplaintEffectiveClosedAt({
    status: complaint.status,
    complaintDate: complaint.complaintDate,
    receivedAt: complaint.receivedAt,
    closedAt: complaint.closedAt,
    lastUpdatedAt: complaint.sourceUpdatedAt,
  });
  return effectiveClosedAt !== null && isWithinPeriod(effectiveClosedAt, window);
}

type OpenLateState = { isOpen: boolean; isLate: boolean; certain: boolean };

function resolveOpenAndLateAtEnd(complaint: SnapshotCandidate, period: PeriodRange): OpenLateState {
  const createdAt = resolveComplaintCreatedAt(complaint);
  if (!createdAt || createdAt.getTime() >= period.toExclusive.getTime()) {
    return { isOpen: false, isLate: false, certain: true };
  }
  const state = resolveComplaintOpenStateAt({
    status: complaint.status,
    complaintDate: complaint.complaintDate,
    receivedAt: complaint.receivedAt,
    closedAt: complaint.closedAt,
    sourceUpdatedAt: complaint.sourceUpdatedAt,
    statusHistory: complaint.statusHistory,
    measuredAt: period.toExclusive,
  });
  if (!state.certain) return { isOpen: false, isLate: false, certain: false };
  if (!state.isOpen) return { isOpen: false, isLate: false, certain: true };
  const isLate = period.toExclusive.getTime() > createdAt.getTime() + COMPLAINT_SLA_DURATION_MS;
  return { isOpen: true, isLate, certain: true };
}

/** Optional status filter applied at the given period's end, per the report's status filter. */
function matchesStatusFilterAtEnd(
  complaint: SnapshotCandidate,
  period: PeriodRange,
  statusFilter: ComplaintStatus
): boolean {
  const state = resolveComplaintOpenStateAt({
    status: complaint.status,
    complaintDate: complaint.complaintDate,
    receivedAt: complaint.receivedAt,
    closedAt: complaint.closedAt,
    sourceUpdatedAt: complaint.sourceUpdatedAt,
    statusHistory: complaint.statusHistory,
    measuredAt: period.toExclusive,
  });
  if (!state.certain) return false;
  if (state.resolvedStatus !== null) return state.resolvedStatus === statusFilter;
  // resolvedStatus unknown but isOpen known (rare fallback branch): only a
  // broad open-group filter can still be evaluated meaningfully.
  return state.isOpen && isOpenComplaintStatus(statusFilter);
}

/**
 * Shared across every aggregation pass within one {@link computeExecutiveReportSnapshot}
 * call (current period, previous period, byRegion, byDepartment, byClassification) —
 * a single complaint can be evaluated as "uncertain" in more than one of those
 * passes, and `uncertainComplaintIds` ensures it only ever contributes one
 * warning line, not one per pass.
 */
type SnapshotAggregationContext = {
  statusFilter?: ComplaintStatus;
  warnings: string[];
  uncertainComplaintIds: Set<string>;
};

function addUncertainComplaintWarning(context: SnapshotAggregationContext, complaintId: string): void {
  if (context.uncertainComplaintIds.has(complaintId)) return;
  context.uncertainComplaintIds.add(complaintId);
  context.warnings.push(
    `تعذر تحديد حالة الشكوى ${complaintId} عند إحدى نقاط القياس بثقة؛ استُبعدت من مؤشرات المفتوحة والمتأخرة ذات الصلة.`
  );
}

/** Builds one period's four indicators over a (possibly status-filtered) candidate set. */
function buildPeriodGroupSnapshot(
  complaints: readonly SnapshotCandidate[],
  period: PeriodRange,
  context: SnapshotAggregationContext
): ReportPeriodGroupSnapshot {
  const scoped = context.statusFilter
    ? complaints.filter((c) => matchesStatusFilterAtEnd(c, period, context.statusFilter!))
    : complaints;

  let receivedDuringPeriod = 0;
  let openAtEnd = 0;
  let lateAtEnd = 0;
  for (const complaint of scoped) {
    const createdAt = resolveComplaintCreatedAt(complaint);
    if (createdAt && isWithinPeriod(createdAt, period)) {
      receivedDuringPeriod += 1;
    }
    const state = resolveOpenAndLateAtEnd(complaint, period);
    if (!state.certain) {
      addUncertainComplaintWarning(context, complaint.id);
      continue;
    }
    if (state.isOpen) {
      openAtEnd += 1;
      if (state.isLate) lateAtEnd += 1;
    }
  }

  const closedDuringPeriod = scoped.reduce(
    (count, complaint) => (wasComplaintClosedInWindow(complaint, period) ? count + 1 : count),
    0
  );

  return {
    receivedDuringPeriod,
    closedDuringPeriod,
    openAtEnd,
    lateAtEnd,
  };
}

function buildPeriodSnapshot(
  complaints: readonly SnapshotCandidate[],
  period: PeriodRange,
  context: SnapshotAggregationContext
): ReportPeriodSnapshot {
  return { period, ...buildPeriodGroupSnapshot(complaints, period, context) };
}

function regionGroupKey(complaint: SnapshotCandidate): string {
  return normalizeRegionName(complaint.region);
}

function departmentGroupKey(complaint: SnapshotCandidate): string {
  return complaint.department ?? UNSPECIFIED_DEPARTMENT_LABEL;
}

function classificationGroupKey(complaint: SnapshotCandidate): string {
  return classificationKey(complaint.classificationId);
}

function groupComplaints(
  complaints: readonly SnapshotCandidate[],
  keyFn: (complaint: SnapshotCandidate) => string
): Map<string, SnapshotCandidate[]> {
  const byKey = new Map<string, SnapshotCandidate[]>();
  for (const complaint of complaints) {
    const key = keyFn(complaint);
    const list = byKey.get(key);
    if (list) {
      list.push(complaint);
    } else {
      byKey.set(key, [complaint]);
    }
  }
  return byKey;
}

function buildGroupedSnapshot(
  complaints: readonly SnapshotCandidate[],
  period: PeriodRange,
  keyFn: (complaint: SnapshotCandidate) => string,
  context: SnapshotAggregationContext
): Record<string, ReportPeriodGroupSnapshot> {
  const byKey = groupComplaints(complaints, keyFn);
  const result: Record<string, ReportPeriodGroupSnapshot> = {};
  for (const [key, group] of byKey) {
    result[key] = buildPeriodGroupSnapshot(group, period, context);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reconciliation (section 20)
// ---------------------------------------------------------------------------

export class SnapshotReconciliationError extends Error {}

/**
 * Verifies that summing a dimension's grouped snapshots reproduces the
 * overall snapshot for receivedDuringPeriod, openAtEnd, and lateAtEnd (the
 * three indicators section 20 requires to reconcile exactly). Throws rather
 * than silently rounding away drift.
 */
export function assertPeriodGroupReconciliation(input: {
  dimensionLabel: string;
  overall: ReportPeriodGroupSnapshot;
  groups: Record<string, ReportPeriodGroupSnapshot>;
}): void {
  const sums = Object.values(input.groups).reduce(
    (acc, group) => ({
      receivedDuringPeriod: acc.receivedDuringPeriod + group.receivedDuringPeriod,
      openAtEnd: acc.openAtEnd + group.openAtEnd,
      lateAtEnd: acc.lateAtEnd + group.lateAtEnd,
    }),
    { receivedDuringPeriod: 0, openAtEnd: 0, lateAtEnd: 0 }
  );

  const mismatches: string[] = [];
  if (sums.receivedDuringPeriod !== input.overall.receivedDuringPeriod) {
    mismatches.push(
      `receivedDuringPeriod ${sums.receivedDuringPeriod} != ${input.overall.receivedDuringPeriod}`
    );
  }
  if (sums.openAtEnd !== input.overall.openAtEnd) {
    mismatches.push(`openAtEnd ${sums.openAtEnd} != ${input.overall.openAtEnd}`);
  }
  if (sums.lateAtEnd !== input.overall.lateAtEnd) {
    mismatches.push(`lateAtEnd ${sums.lateAtEnd} != ${input.overall.lateAtEnd}`);
  }
  if (mismatches.length > 0) {
    throw new SnapshotReconciliationError(
      `${input.dimensionLabel} reconciliation drift: ${mismatches.join("; ")}`
    );
  }
}

function reconcileOrWarn(
  dimensionLabel: string,
  overall: ReportPeriodGroupSnapshot,
  groups: Record<string, ReportPeriodGroupSnapshot>,
  warnings: string[],
  strict: boolean
): void {
  try {
    assertPeriodGroupReconciliation({ dimensionLabel, overall, groups });
  } catch (error) {
    if (strict) throw error;
    warnings.push(
      `تعذر التحقق من تطابق مجموع ${dimensionLabel} مع الإجمالي؛ تم إنشاء التقرير مع تحذير للمراجعة.`
    );
  }
}

// ---------------------------------------------------------------------------
// DB loading — fixed query count, narrow projection (section 7)
// ---------------------------------------------------------------------------

const SNAPSHOT_CANDIDATE_SELECT = {
  id: true,
  status: true,
  complaintDate: true,
  receivedAt: true,
  closedAt: true,
  sourceUpdatedAt: true,
  region: true,
  department: true,
  classificationId: true,
  statusHistory: {
    select: { fromStatus: true, toStatus: true, changedAt: true },
  },
} satisfies Prisma.ComplaintSelect;

/** Non-date, non-status filters only — status is re-applied historically, not via the DB column. */
function snapshotBaseWhere(filters: ReportFilters, now: Date): Prisma.ComplaintWhereInput {
  const params = buildComplaintQueryParams(filters);
  params.delete("from");
  params.delete("to");
  params.delete("status");
  const query = parseComplaintQuery(params);
  return buildComplaintWhere(query, now);
}

/** effectiveCreatedAt < toExclusive — a superset covering both current and previous periods. */
function createdBeforeWhere(toExclusive: Date): Prisma.ComplaintWhereInput {
  return {
    OR: [
      { complaintDate: { lt: toExclusive } },
      { complaintDate: null, receivedAt: { lt: toExclusive } },
    ],
  };
}

/**
 * Combines the report's own filters, the isDeleted guard, and the
 * effective-created-before-period-end predicate under one `AND` array
 * instead of an object spread. `baseWhere` (and `createdBeforeWhere`) may
 * each carry their own top-level `OR`; spreading two objects that both set
 * `OR` silently drops the first one's clause (the second spread overwrites
 * the key). Wrapping each source clause as its own `AND` member keeps every
 * OR intact regardless of how many of the inputs use one.
 */
export function composeSnapshotCandidateWhere(
  baseWhere: Prisma.ComplaintWhereInput,
  currentPeriodToExclusive: Date
): Prisma.ComplaintWhereInput {
  return {
    AND: [baseWhere, { isDeleted: false }, createdBeforeWhere(currentPeriodToExclusive)],
  };
}

export async function loadReportPeriodSnapshotCandidates(
  filters: ReportFilters,
  now: Date,
  currentPeriodToExclusive: Date
): Promise<SnapshotCandidate[]> {
  const baseWhere = snapshotBaseWhere(filters, now);
  const where = composeSnapshotCandidateWhere(baseWhere, currentPeriodToExclusive);
  return db.complaint.findMany({ where, select: SNAPSHOT_CANDIDATE_SELECT });
}

// ---------------------------------------------------------------------------
// Pure orchestration core (no DB access — directly unit-testable)
// ---------------------------------------------------------------------------

export type SnapshotPeriods = { currentPeriod: PeriodRange; previousPeriod: PeriodRange | null };

/**
 * Pure aggregation entry point: given an already-loaded candidate set, builds
 * the full current/previous + per-dimension snapshot, with reconciliation
 * checks against the current period. Used directly by unit tests and by
 * {@link buildExecutiveReportSnapshotData} after it loads candidates from the DB.
 */
export function computeExecutiveReportSnapshot(
  candidates: readonly SnapshotCandidate[],
  periods: SnapshotPeriods,
  options: { statusFilter?: ComplaintStatus; strict?: boolean } = {}
): ExecutiveReportSnapshotData {
  const warnings: string[] = [];
  const strict = options.strict ?? process.env.NODE_ENV === "test";
  const snapshotOptions: SnapshotAggregationContext = {
    statusFilter: options.statusFilter,
    warnings,
    uncertainComplaintIds: new Set(),
  };

  const current = buildPeriodSnapshot(candidates, periods.currentPeriod, snapshotOptions);
  const previous = periods.previousPeriod
    ? buildPeriodSnapshot(candidates, periods.previousPeriod, snapshotOptions)
    : null;

  const byRegion = buildGroupedSnapshot(candidates, periods.currentPeriod, regionGroupKey, snapshotOptions);
  const byDepartment = buildGroupedSnapshot(
    candidates,
    periods.currentPeriod,
    departmentGroupKey,
    snapshotOptions
  );
  const byClassification = buildGroupedSnapshot(
    candidates,
    periods.currentPeriod,
    classificationGroupKey,
    snapshotOptions
  );

  const overallGroup: ReportPeriodGroupSnapshot = {
    receivedDuringPeriod: current.receivedDuringPeriod,
    closedDuringPeriod: current.closedDuringPeriod,
    openAtEnd: current.openAtEnd,
    lateAtEnd: current.lateAtEnd,
  };
  reconcileOrWarn("المناطق", overallGroup, byRegion, warnings, strict);
  reconcileOrWarn("الإدارات", overallGroup, byDepartment, warnings, strict);
  reconcileOrWarn("التصنيفات", overallGroup, byClassification, warnings, strict);

  return { current, previous, byRegion, byDepartment, byClassification, warnings };
}

// ---------------------------------------------------------------------------
// Public orchestrator (DB-backed)
// ---------------------------------------------------------------------------

export async function buildExecutiveReportSnapshotData(
  filters: ReportFilters,
  periods: SnapshotPeriods,
  now: Date = new Date()
): Promise<ExecutiveReportSnapshotData> {
  const candidates = await loadReportPeriodSnapshotCandidates(
    filters,
    now,
    periods.currentPeriod.toExclusive
  );
  return computeExecutiveReportSnapshot(candidates, periods, { statusFilter: filters.status });
}
