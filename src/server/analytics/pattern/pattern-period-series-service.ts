import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { enumerateConsecutivePeriods, type HalfOpenDateRange } from "@/lib/reports/period-range";
import {
  isFacilityEventEligible,
  loadFacilityOperationalRegistry,
} from "@/server/facilities/facility-operational-scope-service";

/**
 * Single query, in-memory bucketing across a multi-period analysis window.
 * This is the one place that talks to the database for the pattern-analysis
 * engine (spec §23: avoid N+1 queries across many facilities/classifications
 * /periods) — every detector downstream works off `PatternSeriesRecord[]`.
 */

const UNSPECIFIED_FACILITY = "غير محدد";

const patternSelect = {
  id: true,
  complaintDate: true,
  receivedAt: true,
  facility: true,
  classificationId: true,
  classification: { select: { id: true, nameAr: true } },
  subject: true,
  complainantIdentifier: true,
  wingCode: true,
  isPotentialDuplicate: true,
  duplicateOfId: true,
} satisfies Prisma.ComplaintSelect;

type PatternComplaint = Prisma.ComplaintGetPayload<{ select: typeof patternSelect }>;

export type PatternSeriesRecord = {
  complaintId: string;
  periodIndex: number;
  facility: string;
  classificationId: string | null;
  classificationLabel: string | null;
  subject: string;
  complainantIdentifier: string | null;
  wingCode: string | null;
  isPotentialDuplicate: boolean;
  duplicateOfId: string | null;
};

export type PatternSeries = {
  periods: HalfOpenDateRange[];
  records: PatternSeriesRecord[];
};

function complaintEffectiveDate(complaint: PatternComplaint): Date {
  return complaint.complaintDate ?? complaint.receivedAt;
}

function resolvePeriodIndex(date: Date, periods: HalfOpenDateRange[]): number | null {
  for (let i = 0; i < periods.length; i++) {
    if (date >= periods[i].from && date < periods[i].toExclusive) return i;
  }
  return null;
}

export type LoadPatternSeriesOptions = {
  /** Optional non-date filters (region, department, ...) reserved for future scoping; unused today. */
  facility?: string;
};

/**
 * `currentFrom`/`currentToExclusive` describe the most recent (current)
 * period; `windowPeriods` trailing periods of that same duration are
 * fetched in one query and bucketed in memory.
 */
export async function loadPatternSeries(
  currentFrom: Date,
  currentToExclusive: Date,
  windowPeriods: number,
  _options: LoadPatternSeriesOptions = {}
): Promise<PatternSeries> {
  const periods = enumerateConsecutivePeriods(currentFrom, currentToExclusive, windowPeriods);
  if (periods.length === 0) return { periods: [], records: [] };

  const earliestFrom = periods[0].from;

  const [rows, facilityRegistry] = await Promise.all([
    db.complaint.findMany({
      where: {
        isDeleted: false,
        OR: [
          { complaintDate: { gte: earliestFrom, lt: currentToExclusive } },
          { complaintDate: null, receivedAt: { gte: earliestFrom, lt: currentToExclusive } },
        ],
      },
      select: patternSelect,
    }),
    loadFacilityOperationalRegistry(),
  ]);

  const records: PatternSeriesRecord[] = [];
  for (const row of rows) {
    if (!row.id) continue; // defensive: a row without its primary key can't be cited as evidence
    const effectiveDate = complaintEffectiveDate(row);
    if (!isFacilityEventEligible(facilityRegistry, row.facility, effectiveDate)) continue;
    const periodIndex = resolvePeriodIndex(effectiveDate, periods);
    if (periodIndex === null) continue;

    records.push({
      complaintId: row.id,
      periodIndex,
      facility: row.facility?.trim() || UNSPECIFIED_FACILITY,
      classificationId: row.classificationId,
      classificationLabel: row.classification?.nameAr ?? null,
      subject: row.subject,
      complainantIdentifier: row.complainantIdentifier,
      wingCode: row.wingCode,
      isPotentialDuplicate: row.isPotentialDuplicate,
      duplicateOfId: row.duplicateOfId,
    });
  }

  return { periods, records };
}
