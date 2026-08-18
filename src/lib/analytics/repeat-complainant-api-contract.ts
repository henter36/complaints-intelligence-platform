/**
 * Response contracts for /api/analytics/repeat-complainants and its /people
 * sub-resource, mirrored on the same runtime-validated pattern as
 * `analytics-api-contract.ts` — a well-formed 200 body missing fields the UI
 * relies on must never be mistaken for real data.
 */

import { isRecord } from "./analytics-api-contract";
import type {
  RepeatComplainantKpis,
  RepeatFacilitySummaryRow,
  RepeatRegionSummaryRow,
  ComplaintTypeCount,
  PersonFacilityMembership,
} from "./repeat-complainant-directory";
// Types only — erased at compile time, so no server runtime (node:crypto,
// Prisma, node:fs font loading) ever reaches the client bundle. Same
// established cross-layer-import-is-safe convention as
// `repeat-complainant-directory.ts`'s own `maskIdentifier` import.
import type { RepeatPersonRowForClient } from "@/server/analytics/repeat-complainants/repeat-complainant-analytics-service";
import type {
  RepeatComplainantPersonDetail,
  PersonComplaintRow,
  PersonComplaintTypeGroup,
  PersonTimelinePoint,
} from "@/server/analytics/repeat-complainants/repeat-complainant-person-detail-service";

export type RepeatComplainantSummaryData = {
  kpis: RepeatComplainantKpis;
  regions: RepeatRegionSummaryRow[];
  facilities: RepeatFacilitySummaryRow[];
  conclusions: string[];
};

export type RepeatComplainantPeopleData = {
  people: RepeatPersonRowForClient[];
  total: number;
  page: number;
  pageSize: number;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isComplaintTypeCount(value: unknown): value is ComplaintTypeCount {
  return (
    isRecord(value)
    && typeof value.classificationId === "string"
    && typeof value.label === "string"
    && isFiniteNumber(value.count)
  );
}

function isTopComplaintType(value: unknown): value is { label: string; count: number } | null {
  if (value === null) return true;
  return isRecord(value) && typeof value.label === "string" && isFiniteNumber(value.count);
}

function isKpis(value: unknown): value is RepeatComplainantKpis {
  if (!isRecord(value)) return false;
  const topFacility = value.topFacility;
  const isTopFacility =
    topFacility === null
    || (isRecord(topFacility)
      && typeof topFacility.facility === "string"
      && typeof topFacility.region === "string"
      && isFiniteNumber(topFacility.repeatedPeopleCount));
  return (
    isFiniteNumber(value.repeatedPeopleCount)
    && isFiniteNumber(value.repeatedComplaintsCount)
    && isFiniteNumber(value.repeatedShareOfPeriodPercent)
    && isTopFacility
    && isTopComplaintType(value.topComplaintType)
  );
}

function isFacilityRow(value: unknown): value is RepeatFacilitySummaryRow {
  return (
    isRecord(value)
    && typeof value.region === "string"
    && typeof value.facility === "string"
    && isFiniteNumber(value.repeatedPeopleCount)
    && isFiniteNumber(value.repeatedComplaintsCount)
    && isFiniteNumber(value.facilityTotalComplaints)
    && isFiniteNumber(value.repeatRatePercent)
    && isTopComplaintType(value.topComplaintType)
    && isFiniteNumber(value.highestRepeatByOnePerson)
    && isFiniteNumber(value.priorityScore)
    && typeof value.priorityBand === "string"
    && isRecord(value.drilldownFilters)
    && typeof value.linkedChronicIssue === "boolean"
    && typeof value.linkedMassComplaint === "boolean"
    && typeof value.linkedHighPriorityFacility === "boolean"
  );
}

function isRegionRow(value: unknown): value is RepeatRegionSummaryRow {
  return (
    isRecord(value)
    && typeof value.region === "string"
    && isFiniteNumber(value.repeatedPeopleCount)
    && isFiniteNumber(value.repeatedComplaintsCount)
    && isFiniteNumber(value.facilitiesAffectedCount)
    && isTopComplaintType(value.topComplaintType)
    && isRecord(value.drilldownFilters)
  );
}

export function isRepeatComplainantSummaryData(value: unknown): value is RepeatComplainantSummaryData {
  return (
    isRecord(value)
    && isKpis(value.kpis)
    && Array.isArray(value.regions)
    && value.regions.every(isRegionRow)
    && Array.isArray(value.facilities)
    && value.facilities.every(isFacilityRow)
    && Array.isArray(value.conclusions)
    && value.conclusions.every((c) => typeof c === "string")
  );
}

function isPersonFacilityMembership(value: unknown): value is PersonFacilityMembership {
  return (
    isRecord(value)
    && typeof value.region === "string"
    && typeof value.facility === "string"
    && isFiniteNumber(value.complaintsCount)
  );
}

function isPersonRow(value: unknown): value is RepeatPersonRowForClient {
  return (
    isRecord(value)
    && typeof value.complainantIdentifierMasked === "string"
    && typeof value.complainantToken === "string"
    && (value.complainantName === null || typeof value.complainantName === "string")
    && typeof value.region === "string"
    && typeof value.facility === "string"
    && isFiniteNumber(value.facilitiesCount)
    && Array.isArray(value.facilities)
    && value.facilities.every(isPersonFacilityMembership)
    && isFiniteNumber(value.totalComplaints)
    && isFiniteNumber(value.sameTypeRepeatCount)
    && isFiniteNumber(value.distinctComplaintTypesCount)
    && Array.isArray(value.topComplaintTypes)
    && value.topComplaintTypes.every(isComplaintTypeCount)
    && typeof value.firstComplaintDate === "string"
    && typeof value.lastComplaintDate === "string"
    && isFiniteNumber(value.periodsPresent)
    && typeof value.spansMultiplePeriods === "boolean"
    && typeof value.recentActivity === "boolean"
    && (value.pattern === "CONCENTRATED" || value.pattern === "DIVERSE")
    && Array.isArray(value.complaintIds)
    && isRecord(value.drilldownFilters)
  );
}

export function isRepeatComplainantPeopleData(value: unknown): value is RepeatComplainantPeopleData {
  return (
    isRecord(value)
    && Array.isArray(value.people)
    && value.people.every(isPersonRow)
    && isFiniteNumber(value.total)
    && isFiniteNumber(value.page)
    && isFiniteNumber(value.pageSize)
  );
}

export type RepeatComplainantSearchData = { people: RepeatPersonRowForClient[] };

/** /api/analytics/repeat-complainants/search response: `{ people: [...] }`. */
export function isRepeatComplainantSearchData(value: unknown): value is RepeatComplainantSearchData {
  return isRecord(value) && Array.isArray(value.people) && value.people.every(isPersonRow);
}

function isPersonComplaintRow(value: unknown): value is PersonComplaintRow {
  return (
    isRecord(value)
    && typeof value.complaintId === "string"
    && typeof value.complaintNumber === "string"
    && typeof value.date === "string"
    && typeof value.region === "string"
    && typeof value.facility === "string"
    && typeof value.classificationId === "string"
    && typeof value.classificationLabel === "string"
    && typeof value.subject === "string"
    && (value.descriptionSnippet === null || typeof value.descriptionSnippet === "string")
    && typeof value.status === "string"
    && typeof value.monthKey === "string"
  );
}

function isPersonComplaintTypeGroup(value: unknown): value is PersonComplaintTypeGroup {
  return (
    isRecord(value)
    && typeof value.classificationId === "string"
    && typeof value.label === "string"
    && Array.isArray(value.complaints)
    && value.complaints.every(isPersonComplaintRow)
  );
}

function isPersonTimelinePoint(value: unknown): value is PersonTimelinePoint {
  return (
    isRecord(value)
    && typeof value.monthKey === "string"
    && typeof value.monthLabel === "string"
    && isFiniteNumber(value.count)
  );
}

/** /api/analytics/repeat-complainants/person — full detail for one person, fetched on demand. */
export function isRepeatComplainantPersonDetail(value: unknown): value is RepeatComplainantPersonDetail {
  return (
    isRecord(value)
    && isPersonRow(value.person)
    && Array.isArray(value.complaints)
    && value.complaints.every(isPersonComplaintRow)
    && Array.isArray(value.complaintsByType)
    && value.complaintsByType.every(isPersonComplaintTypeGroup)
    && Array.isArray(value.timeline)
    && value.timeline.every(isPersonTimelinePoint)
  );
}

/** Builds the complaints-explorer drillthrough query for a repeat-complainant row (facility, region, or person). */
export function buildRepeatComplainantDrilldownQuery(
  filters: Record<string, string | null | undefined>,
  extra: { from?: string; to?: string } = {}
): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value) query[key] = value;
  }
  if (extra.from) query.from = extra.from;
  if (extra.to) query.to = extra.to;
  return query;
}
