import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  buildComplaintWhere,
  parseComplaintQuery,
  type ComplaintQuery,
} from "@/server/complaints/complaint-query-service";
import {
  buildCurrentOperationalFacilityWhere,
  combineComplaintWhere,
  isFacilityEventEligible,
  loadFacilityOperationalRegistry,
} from "@/server/facilities/facility-operational-scope-service";
import { loadPatternAnalysisForFilters } from "@/server/analytics/pattern/pattern-report-integration-service";
import {
  buildRepeatComplainantDirectory,
  buildRepeatComplainantConclusions,
  enrichFacilitiesWithPatternSignals,
  isTechnicalDuplicate,
  type RepeatComplainantDirectory,
  type RepeatComplainantDirectoryOptions,
  type RepeatDirectoryRecord,
} from "@/lib/analytics/repeat-complainant-directory";

/**
 * ONE lean `findMany` (no N+1) — mirrors the exact select/eligibility
 * pattern already established by `pattern-period-series-service.ts` and
 * `operational-analytics-service.ts` (`parseComplaintQuery` + `buildComplaintWhere`
 * + current operational facility scope), so this feature never invents a
 * parallel filtering convention.
 */
const repeatSelect = {
  id: true,
  complaintDate: true,
  receivedAt: true,
  region: true,
  facility: true,
  classificationId: true,
  classification: { select: { nameAr: true } },
  complainantIdentifier: true,
  isPotentialDuplicate: true,
  duplicateOfId: true,
} satisfies Prisma.ComplaintSelect;

type RepeatComplaintRow = Prisma.ComplaintGetPayload<{ select: typeof repeatSelect }>;

function effectiveDateOf(row: RepeatComplaintRow): Date {
  return row.complaintDate ?? row.receivedAt;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Shared by the summary and people services — the ONE place that queries complaints for this feature. */
export async function fetchScopedRecords(
  query: ComplaintQuery,
  now: Date
): Promise<{ records: RepeatDirectoryRecord[]; totalComplaintsInScope: number }> {
  const [facilityWhere, facilityRegistry] = await Promise.all([
    buildCurrentOperationalFacilityWhere(),
    loadFacilityOperationalRegistry(),
  ]);
  const where = combineComplaintWhere(buildComplaintWhere(query, now), facilityWhere);
  const rows = await db.complaint.findMany({ where, select: repeatSelect });

  const records: RepeatDirectoryRecord[] = [];
  for (const row of rows) {
    if (!row.id) continue;
    const effectiveDate = effectiveDateOf(row);
    if (!isFacilityEventEligible(facilityRegistry, row.facility, effectiveDate)) continue;
    records.push({
      complaintId: row.id,
      complainantIdentifier: row.complainantIdentifier,
      region: row.region,
      facility: row.facility?.trim() || "غير محدد",
      classificationId: row.classificationId,
      classificationLabel: row.classification?.nameAr ?? null,
      effectiveDate: toIsoDate(effectiveDate),
      isPotentialDuplicate: row.isPotentialDuplicate,
      duplicateOfId: row.duplicateOfId,
    });
  }

  // A technical import duplicate is never a real complaint — excluded from
  // the volume denominator too, same convention `buildRepeatComplainantDirectory`
  // itself already applies internally to facility-level totals.
  const totalComplaintsInScope = records.filter((r) => !isTechnicalDuplicate(r)).length;
  return { records, totalComplaintsInScope };
}

export type RepeatComplainantSummary = {
  kpis: RepeatComplainantDirectory["kpis"];
  regions: RepeatComplainantDirectory["regions"];
  facilities: RepeatComplainantDirectory["facilities"];
  conclusions: string[];
};

function parseDirectoryOptions(params: URLSearchParams): RepeatComplainantDirectoryOptions {
  const minComplaints = params.get("minComplaints");
  const minDistinctTypes = params.get("minDistinctTypes");
  return {
    minComplaintsPerPerson: minComplaints ? Number(minComplaints) : undefined,
    sameTypeOnly: params.get("sameTypeOnly") === "true",
    minDistinctTypes: minDistinctTypes ? Number(minDistinctTypes) : undefined,
  };
}

/**
 * Summary endpoint data: KPIs + facility/region rollups only — never the
 * full person list (spec: don't make the whole Analytics load wait on every
 * person's detail; those are fetched lazily per facility, see
 * `repeat-complainant-people-service.ts`).
 */
export async function getRepeatComplainantSummary(
  params: URLSearchParams,
  now: Date = new Date()
): Promise<RepeatComplainantSummary> {
  const query = parseComplaintQuery(params);
  const options = parseDirectoryOptions(params);
  const { records, totalComplaintsInScope } = await fetchScopedRecords(query, now);
  const directory = buildRepeatComplainantDirectory(records, totalComplaintsInScope, undefined, options);

  // Integration with the existing pattern-analysis engine (spec §16) — reused
  // verbatim, never recomputed. Scoped by the same region filter as the request.
  const fromParam = params.get("from");
  const toParam = params.get("to");
  let facilities = directory.facilities;
  if (fromParam && toParam) {
    const currentFrom = new Date(`${fromParam}T00:00:00.000Z`);
    const currentToExclusive = new Date(new Date(`${toParam}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000);
    if (!Number.isNaN(currentFrom.getTime()) && !Number.isNaN(currentToExclusive.getTime())) {
      const patternAnalysis = await loadPatternAnalysisForFilters(currentFrom, currentToExclusive, {
        region: params.get("regionId") ?? params.get("region"),
      });
      const highPriorityFacilities = new Set(
        patternAnalysis.findings
          .filter((f) => f.priorityScore >= 70)
          .map((f) => f.drilldownFilters.facility)
          .filter((v): v is string => typeof v === "string")
      );
      facilities = enrichFacilitiesWithPatternSignals(directory.facilities, patternAnalysis.findings, highPriorityFacilities);
    }
  }

  const topFacilities = params.get("topFacilities");
  if (topFacilities) facilities = facilities.slice(0, Number(topFacilities));

  const enrichedDirectory: RepeatComplainantDirectory = { ...directory, facilities };
  return {
    kpis: directory.kpis,
    regions: directory.regions,
    facilities,
    conclusions: buildRepeatComplainantConclusions(enrichedDirectory),
  };
}
