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
  RepeatPersonRow,
  ComplaintTypeCount,
} from "./repeat-complainant-directory";

export type RepeatComplainantSummaryData = {
  kpis: RepeatComplainantKpis;
  regions: RepeatRegionSummaryRow[];
  facilities: RepeatFacilitySummaryRow[];
  conclusions: string[];
};

export type RepeatComplainantPeopleData = {
  people: RepeatPersonRow[];
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

function isPersonRow(value: unknown): value is RepeatPersonRow {
  return (
    isRecord(value)
    && typeof value.complainantIdentifierMasked === "string"
    && typeof value.complainantIdentifierRaw === "string"
    && typeof value.region === "string"
    && typeof value.facility === "string"
    && isFiniteNumber(value.totalComplaints)
    && isFiniteNumber(value.sameTypeRepeatCount)
    && isFiniteNumber(value.distinctComplaintTypesCount)
    && Array.isArray(value.topComplaintTypes)
    && value.topComplaintTypes.every(isComplaintTypeCount)
    && typeof value.lastComplaintDate === "string"
    && isFiniteNumber(value.periodsPresent)
    && typeof value.spansMultiplePeriods === "boolean"
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
