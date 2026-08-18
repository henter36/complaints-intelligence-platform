import {
  classificationKey,
  classificationDisplayName,
  UNCLASSIFIED_CLASSIFICATION_KEY,
} from "@/lib/reports/classification-keys";
import { normalizeRegionName, displayRegionName } from "@/lib/reports/region-normalization";
import { computePriorityScore, type PriorityBand } from "./priority-score";
import { PATTERN_ANALYSIS_CONFIG, type PatternAnalysisConfig } from "./pattern-analysis-config";
import type { AnalyticalFinding } from "./analytical-finding";
// This module runs server-side only (consumers that also run in the browser
// import ONLY its types via `import type`, which TypeScript erases at
// compile time — no runtime code from here, or from this import, ever
// reaches a client bundle). Reusing the codebase's one established PII
// masking convention (already relied on to keep identifiers out of AI
// payloads/fingerprints) instead of inventing a second masking format.
import { maskIdentifier } from "@/server/imports/privacy";

/**
 * General-purpose "repeat complainant directory" — deliberately distinct
 * from `repeat-complainant.ts`'s `detectRepeatComplainants` (which requires
 * the SAME topic to recur across >= 2 measurement periods, feeding the
 * multi-period pattern-analysis engine's chronic-issue prioritization).
 * This directory answers a broader, ad-hoc question over whatever date
 * range/filters the caller picked: "which people filed more than one
 * eligible complaint at all, regardless of topic or period" — the two are
 * intentionally not merged; see repeat-complainant-directory.test.ts.
 *
 * Person identity is `complainantIdentifier` ALONE — one person is one
 * identifier, even when their complaints land at several facilities (a
 * transferred inmate, for example). Facility/region are analytical
 * dimensions of that one person's complaints, tracked in `facilities[]`,
 * never part of identity. This is why a person's org-wide "repeated"
 * status and a facility's own "repeated at THIS facility" status are two
 * separate, independently-thresholded questions — see
 * `RepeatPersonRow.facilities`, `facilityMembershipMeetsThreshold`, and the
 * "org-level vs facility-level repeated person" tests below.
 */

export type RepeatDirectoryRecord = {
  complaintId: string;
  complainantIdentifier: string | null;
  /** As stored on the complaint (from the import source's "اسم مقدم الشكوى"/"اسم السجين" column) — never inferred from the identifier, never fabricated when absent. */
  complainantName: string | null;
  /** Raw region as stored on the complaint; normalized internally. */
  region: string | null;
  facility: string;
  classificationId: string | null;
  classificationLabel: string | null;
  /** ISO date (yyyy-mm-dd or full timestamp) — complaintDate ?? receivedAt, the same effective-date policy used everywhere else. */
  effectiveDate: string;
  isPotentialDuplicate: boolean;
  duplicateOfId: string | null;
};

/** A technical import duplicate is never a real complaint — excluded from every count, not just repeat evidence. */
export function isTechnicalDuplicate(record: Pick<RepeatDirectoryRecord, "isPotentialDuplicate" | "duplicateOfId">): boolean {
  return record.isPotentialDuplicate || Boolean(record.duplicateOfId);
}

/** Eligible as REPEAT evidence: a real (non-duplicate) complaint with a usable identifier. */
function isEligible(record: RepeatDirectoryRecord): boolean {
  if (isTechnicalDuplicate(record)) return false;
  if (!record.complainantIdentifier?.trim()) return false;
  return true;
}

/**
 * `****4821`-style masking (spec: never show the raw identifier in general
 * tables/cards/exports) — a fixed-length `****` prefix plus the last 4
 * characters, so the identifier's true LENGTH is never leaked either (the
 * established codebase convention — see `server/imports/privacy.ts`, already
 * relied on to keep identifiers out of AI payloads/fingerprints).
 */
export function maskComplainantIdentifier(identifier: string): string {
  return maskIdentifier(identifier);
}

/** yyyy-mm — this screen's own bucket for "a measurement period a person appeared in" (`periodsPresent`/`spansMultiplePeriods`/`recentActivity`). Deliberately calendar-MONTH, independent of the multi-period pattern-analysis engine's own (week/month/quarter) period bucketing — this directory answers a broader ad-hoc question over whatever date range the caller picked, not a fixed reporting cadence, so "شهر" is what these fields actually mean and is named accordingly; never conflate with `pattern-analysis`'s periods. */
function monthKeyOf(effectiveDate: string): string {
  return effectiveDate.slice(0, 7);
}

export type ComplaintTypeCount = { classificationId: string; label: string; count: number };

/** Behavioral pattern label — a description of the DATA, never a judgment about the person (spec). */
export type RepeatPersonPattern = "CONCENTRATED" | "DIVERSE";

/** Share of a person's complaints in their single most-common type at/above which the pattern is "concentrated". */
const CONCENTRATION_SHARE_THRESHOLD = 0.6;
/** Share of a person's complaints falling in their own most-recent month at/above which "نشاط حديث" applies. */
const RECENT_ACTIVITY_SHARE_THRESHOLD = 0.5;

/** One facility a person's complaints appeared at, within the queried scope. */
export type PersonFacilityMembership = {
  region: string;
  facility: string;
  complaintsCount: number;
};

export type RepeatPersonRow = {
  complainantIdentifierMasked: string;
  /** Internal-use only — never rendered as visible text, never put in a URL; used only for the explicit reveal toggle (client-state, never URL state) and to derive the drillthrough token server-side. */
  complainantIdentifierRaw: string;
  /** From the import source; null (never inferred/fabricated) when the source never recorded a name. Resolved as the MOST RECENT non-empty name by effectiveDate, deterministic tie-break by complaintId — never the last-scanned row (`findMany` order is not guaranteed chronological). */
  complainantName: string | null;
  /** The region of this person's PRIMARY facility (most complaints; ties broken alphabetically) — see `facilities` for the full breakdown when `facilitiesCount > 1`. */
  region: string;
  /** This person's PRIMARY facility (most complaints; ties broken alphabetically) — kept for backward-compatible single-facility display; see `facilities` for the full breakdown. */
  facility: string;
  /** Distinct facilities this person's complaints appeared at, within scope. 1 for the common case. */
  facilitiesCount: number;
  /** Every facility this person appears at, each with ITS OWN complaint count — sorted by complaintsCount descending (ties broken alphabetically by facility). `facilities[0]` is always the "primary" facility/region above. */
  facilities: PersonFacilityMembership[];
  /** ORG-WIDE total across every facility in `facilities` — the basis for "is this an org-level repeated person" (see module docstring). */
  totalComplaints: number;
  /** Complaints in this person's single most-repeated type ORG-WIDE, when that type recurs (>=2); 0 otherwise. */
  sameTypeRepeatCount: number;
  /** ORG-WIDE distinct type count, from the FULL classification distribution — never derived from the capped `topComplaintTypes` below (spec: a 6th+ type must never silently disappear from this count). */
  distinctComplaintTypesCount: number;
  /** Capped top 5 for DISPLAY only — never fed back into any count/aggregation (see `distinctComplaintTypesCount` and facility/region/org topComplaintType, all computed from the full distribution instead). */
  topComplaintTypes: ComplaintTypeCount[];
  firstComplaintDate: string;
  lastComplaintDate: string;
  /** Distinct calendar months this person's complaints fall in, ORG-WIDE, within the queried range. */
  periodsPresent: number;
  spansMultiplePeriods: boolean;
  /** Most of this person's complaints landed in their own most-recent month within the range ("نشاط حديث") — independent of `pattern`, not mutually exclusive with it. */
  recentActivity: boolean;
  pattern: RepeatPersonPattern;
  /** Capped list of complaint ids for evidence (across all facilities); drillthrough itself uses `complainantToken`, not this list. */
  complaintIds: string[];
  /** The PRIMARY facility/region only (backward-compatible single-facility drilldown) — never includes the identifier. Full-person, cross-facility drillthrough uses `complainantToken` alone (see `repeat-complainants-panel.tsx`). */
  drilldownFilters: { facility: string; region: string };
};

export type RepeatFacilitySummaryRow = {
  region: string;
  facility: string;
  /**
   * People who meet the repeat threshold AT THIS FACILITY specifically
   * (their complaint count AT this facility, not their org-wide total) —
   * the "facility-level repeated person" definition, independent of
   * `RepeatComplainantKpis.repeatedPeopleCount` (the org-level definition).
   * A person repeated org-wide by combining 1 complaint at each of two
   * facilities counts toward NEITHER facility's `repeatedPeopleCount`. See
   * the module docstring and repeat-complainant-directory.test.ts.
   */
  repeatedPeopleCount: number;
  repeatedComplaintsCount: number;
  facilityTotalComplaints: number;
  repeatRatePercent: number;
  topComplaintType: { label: string; count: number } | null;
  highestRepeatByOnePerson: number;
  priorityScore: number;
  priorityBand: PriorityBand;
  drilldownFilters: { facility: string; region: string };
  /** Set by `enrichFacilitiesWithPatternSignals` from the SAME pattern-analysis engine findings — never recomputed here. */
  linkedChronicIssue: boolean;
  linkedMassComplaint: boolean;
  linkedHighPriorityFacility: boolean;
};

export type RepeatRegionSummaryRow = {
  region: string;
  repeatedPeopleCount: number;
  repeatedComplaintsCount: number;
  facilitiesAffectedCount: number;
  topComplaintType: { label: string; count: number } | null;
  drilldownFilters: { region: string };
};

export type RepeatComplainantKpis = {
  /** Org-level repeated people: one row per identifier, regardless of how many facilities they appear at (see module docstring). */
  repeatedPeopleCount: number;
  repeatedComplaintsCount: number;
  /** repeatedComplaintsCount / totalComplaintsInScope * 100, share of ALL complaints in the filtered period. */
  repeatedShareOfPeriodPercent: number;
  topFacility: { facility: string; region: string; repeatedPeopleCount: number } | null;
  topComplaintType: { label: string; count: number } | null;
};

export type RepeatComplainantDirectory = {
  kpis: RepeatComplainantKpis;
  regions: RepeatRegionSummaryRow[];
  facilities: RepeatFacilitySummaryRow[];
  /**
   * Every ORG-LEVEL repeated person, unpaginated, sorted by `totalComplaints`
   * descending (ties broken by `complainantIdentifierMasked` for a stable,
   * deterministic order) — `buildRepeatComplainantConclusions` relies on
   * `people[0]` being the highest-repeating person BECAUSE of this sort,
   * not by recomputing a max; keep the two in sync if this ever changes.
   */
  people: RepeatPersonRow[];
};

type TypeCountEntry = { label: string; count: number };

/** One person's presence at one facility — complaint ids/dates/types scoped to JUST that facility. */
type FacilityMembership = {
  region: string;
  facility: string;
  complaintIds: string[];
  effectiveDates: string[];
  /** FULL distribution at this facility — never capped (spec §3/§4: facility/region topComplaintType must never be computed from a per-person top-5 that could drop a real type). */
  typeCountsFull: Map<string, TypeCountEntry>;
};

type NameCandidate = { name: string; effectiveDate: string; complaintId: string };

/** One person, ORG-WIDE — the unit of identity for this whole module. */
type PersonGroup = {
  complainantIdentifier: string;
  nameCandidates: NameCandidate[];
  /** Keyed by facility — this person's complaints, split out per facility they appeared at. */
  facilities: Map<string, FacilityMembership>;
};

const MAX_EVIDENCE_IDS = 50;
const MAX_TOP_TYPES = 5;

function classificationOf(record: RepeatDirectoryRecord): { key: string; label: string } {
  const key = classificationKey(record.classificationId);
  const label = key === UNCLASSIFIED_CLASSIFICATION_KEY
    ? classificationDisplayName(null)
    : classificationDisplayName(record.classificationLabel);
  return { key, label };
}

/** Deterministic tie-break comparator: ISO date ascending, then id ascending — never rely on `.sort()`'s default (lexicographic-on-stringified) behavior for anything but plain strings. */
function byDateThenId(a: NameCandidate, b: NameCandidate): number {
  const dateCompare = a.effectiveDate.localeCompare(b.effectiveDate);
  if (dateCompare !== 0) return dateCompare;
  return a.complaintId.localeCompare(b.complaintId);
}

/**
 * The most-recently-seen non-empty name for this person, chosen by
 * `effectiveDate` (never by scan/insertion order — `findMany` does not
 * guarantee chronological rows) with a deterministic `complaintId`
 * tie-break for same-date candidates. Names are never merged/guessed
 * across conflicting values — the latest one simply wins.
 */
function resolveComplainantName(candidates: readonly NameCandidate[]): string | null {
  if (candidates.length === 0) return null;
  const latest = [...candidates].sort(byDateThenId).at(-1)!;
  return latest.name;
}

function mergeTypeCounts(target: Map<string, TypeCountEntry>, source: ReadonlyMap<string, TypeCountEntry>): void {
  for (const [key, entry] of source) {
    const existing = target.get(key);
    if (existing) existing.count += entry.count;
    else target.set(key, { label: entry.label, count: entry.count });
  }
}

/** Highest-count entry in a type-count map, ties broken alphabetically by label — deterministic, and never built by capping/truncating a per-row top-N first (spec §3/§4). */
function topFromTypeCounts(map: ReadonlyMap<string, TypeCountEntry>): { label: string; count: number } | null {
  let best: { label: string; count: number } | null = null;
  for (const entry of map.values()) {
    if (!best || entry.count > best.count || (entry.count === best.count && entry.label.localeCompare(best.label) < 0)) {
      best = { label: entry.label, count: entry.count };
    }
  }
  return best;
}

/** Full type-count map sorted to a ranked list, ties broken alphabetically — used for the display-only `topComplaintTypes` cap. */
function rankTypeCounts(map: ReadonlyMap<string, TypeCountEntry>): ComplaintTypeCount[] {
  return [...map.entries()]
    .map(([classificationId, entry]) => ({ classificationId, label: entry.label, count: entry.count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function periodsSpannedBy(effectiveDates: readonly string[]): number {
  return new Set(effectiveDates.map(monthKeyOf)).size;
}

/** ORG-WIDE total across every facility this person appears at — the basis for org-level "repeated person" eligibility (spec §1/§10). */
function orgTotalComplaints(group: PersonGroup): number {
  let total = 0;
  for (const membership of group.facilities.values()) total += membership.complaintIds.length;
  return total;
}

/** ORG-WIDE full type distribution, merged across every facility this person appears at. */
function orgTypeCountsFull(group: PersonGroup): Map<string, TypeCountEntry> {
  const merged = new Map<string, TypeCountEntry>();
  for (const membership of group.facilities.values()) mergeTypeCounts(merged, membership.typeCountsFull);
  return merged;
}

function buildPersonRow(group: PersonGroup, typeCountsFull: ReadonlyMap<string, TypeCountEntry>): RepeatPersonRow {
  const memberships = [...group.facilities.values()];
  const allEffectiveDates = memberships.flatMap((m) => m.effectiveDates);
  const allComplaintIds = memberships.flatMap((m) => m.complaintIds);
  const totalComplaints = allComplaintIds.length;

  const rankedTypes = rankTypeCounts(typeCountsFull);
  const topComplaintTypes = rankedTypes.slice(0, MAX_TOP_TYPES);
  const topType = rankedTypes[0] ?? null;
  const sameTypeRepeatCount = topType && topType.count >= 2 ? topType.count : 0;
  const distinctComplaintTypesCount = typeCountsFull.size;

  const sortedDates = [...allEffectiveDates].sort((a, b) => a.localeCompare(b));
  const periodsPresent = periodsSpannedBy(allEffectiveDates);
  const firstComplaintDate = sortedDates[0] ?? "";
  const lastComplaintDate = sortedDates.at(-1) ?? "";
  const concentrationShare = totalComplaints > 0 ? (topType?.count ?? 0) / totalComplaints : 0;
  const mostRecentMonth = monthKeyOf(lastComplaintDate);
  const complaintsInMostRecentMonth = allEffectiveDates.filter((d) => monthKeyOf(d) === mostRecentMonth).length;
  const recentActivityShare = totalComplaints > 0 ? complaintsInMostRecentMonth / totalComplaints : 0;

  const facilities: PersonFacilityMembership[] = memberships
    .map((m) => ({ region: m.region, facility: m.facility, complaintsCount: m.complaintIds.length }))
    .sort((a, b) => b.complaintsCount - a.complaintsCount || a.facility.localeCompare(b.facility));
  const primary = facilities[0]!;

  return {
    complainantIdentifierMasked: maskComplainantIdentifier(group.complainantIdentifier),
    complainantIdentifierRaw: group.complainantIdentifier,
    complainantName: resolveComplainantName(group.nameCandidates),
    region: primary.region,
    facility: primary.facility,
    facilitiesCount: facilities.length,
    facilities,
    totalComplaints,
    sameTypeRepeatCount,
    distinctComplaintTypesCount,
    topComplaintTypes,
    firstComplaintDate,
    lastComplaintDate,
    periodsPresent,
    spansMultiplePeriods: periodsPresent >= 2,
    recentActivity: periodsPresent >= 2 && recentActivityShare >= RECENT_ACTIVITY_SHARE_THRESHOLD,
    pattern: concentrationShare >= CONCENTRATION_SHARE_THRESHOLD ? "CONCENTRATED" : "DIVERSE",
    complaintIds: allComplaintIds.slice(0, MAX_EVIDENCE_IDS),
    drilldownFilters: { facility: primary.facility, region: primary.region },
  };
}

/** Same eligibility test as org-level, but scoped to ONE facility membership — the "facility-level repeated person" definition (spec §2/§10). */
function facilityMembershipMeetsThreshold(
  membership: FacilityMembership,
  minComplaintsPerPerson: number,
  options: RepeatComplainantDirectoryOptions
): boolean {
  if (membership.complaintIds.length < minComplaintsPerPerson) return false;
  if (options.sameTypeOnly) {
    const top = topFromTypeCounts(membership.typeCountsFull);
    if (!top || top.count < 2) return false;
  }
  if (options.minDistinctTypes !== undefined && membership.typeCountsFull.size < options.minDistinctTypes) return false;
  return true;
}

function computeFacilityPriority(
  input: {
    repeatedComplaintsCount: number;
    facilityTotalComplaints: number;
    repeatedPeopleCount: number;
    highestRepeatByOnePerson: number;
    distinctTypesInvolved: number;
    maxPeriodsSpannedByOnePerson: number;
    totalDistinctPeriodsInScope: number;
  },
  config: PatternAnalysisConfig
): { score: number; band: PriorityBand } {
  const repeatRatePercent =
    input.facilityTotalComplaints > 0
      ? (input.repeatedComplaintsCount / input.facilityTotalComplaints) * 100
      : 0;
  const result = computePriorityScore(
    {
      currentValue: input.repeatedComplaintsCount,
      changeRatePercent: null,
      hasSufficientVolume: input.repeatedComplaintsCount >= config.minComplaintsForSignal,
      streakPeriods: input.maxPeriodsSpannedByOnePerson,
      windowPeriods: input.totalDistinctPeriodsInScope,
      repeatRatePercent,
      distinctComplainants: input.repeatedPeopleCount,
      concentrationDeltaPercent: null,
      affectedClassificationsCount: input.distinctTypesInvolved,
      isRelapse: false,
      crossFacilityAffectedCount: 0,
    },
    config
  );
  return { score: result.score, band: result.band };
}

export type RepeatComplainantDirectoryOptions = {
  /** Raise the "repeated person" bar above the default of 2 (spec's "الحد الأدنى لعدد شكاوى الشخص"). */
  minComplaintsPerPerson?: number;
  /** Keep only people whose repetition is concentrated in a single type (spec's "نفس النوع فقط"). */
  sameTypeOnly?: boolean;
  /** Keep only people with at least this many distinct complaint types. */
  minDistinctTypes?: number;
};

/** Accumulated, per-facility rollup while scanning qualifying facility memberships — the facility-level mirror of `PersonGroup`. */
type FacilityAggregate = {
  region: string;
  facility: string;
  repeatedPeopleCount: number;
  repeatedComplaintsCount: number;
  typeCountsFull: Map<string, TypeCountEntry>;
  highestRepeatByOnePerson: number;
  maxPeriodsSpannedByOnePerson: number;
};

/** First pass over the raw records: groups them into org-wide `PersonGroup`s (keyed by identifier, each holding its own per-facility `FacilityMembership`s) and tallies the distinct calendar months present anywhere in scope. */
function groupRecordsByPerson(
  records: readonly RepeatDirectoryRecord[]
): { personGroups: Map<string, PersonGroup>; totalDistinctPeriodsInScope: Set<string> } {
  const personGroups = new Map<string, PersonGroup>();
  const totalDistinctPeriodsInScope = new Set<string>();

  for (const record of records) {
    totalDistinctPeriodsInScope.add(monthKeyOf(record.effectiveDate));
    if (!isEligible(record)) continue;

    const region = displayRegionName(normalizeRegionName(record.region));
    const facility = record.facility.trim() || "غير محدد";
    const identifier = record.complainantIdentifier!;
    const { key: typeKey, label: typeLabel } = classificationOf(record);

    const person = personGroups.get(identifier) ?? {
      complainantIdentifier: identifier,
      nameCandidates: [],
      facilities: new Map<string, FacilityMembership>(),
    };
    if (record.complainantName?.trim()) {
      person.nameCandidates.push({ name: record.complainantName.trim(), effectiveDate: record.effectiveDate, complaintId: record.complaintId });
    }
    const membership = person.facilities.get(facility) ?? {
      region,
      facility,
      complaintIds: [],
      effectiveDates: [],
      typeCountsFull: new Map<string, TypeCountEntry>(),
    };
    membership.complaintIds.push(record.complaintId);
    membership.effectiveDates.push(record.effectiveDate);
    const typeEntry = membership.typeCountsFull.get(typeKey);
    if (typeEntry) typeEntry.count += 1;
    else membership.typeCountsFull.set(typeKey, { label: typeLabel, count: 1 });
    person.facilities.set(facility, membership);
    personGroups.set(identifier, person);
  }

  return { personGroups, totalDistinctPeriodsInScope };
}

/**
 * ORG-LEVEL repeated people: >= minComplaintsPerPerson eligible complaints
 * ACROSS ALL FACILITIES combined, never gated on same-topic or multi-period
 * presence, and never double-counted for someone who moved between
 * facilities (spec §1/§25). Sorted by `totalComplaints` descending (ties
 * broken deterministically) — `buildRepeatComplainantConclusions` relies on
 * `people[0]` being the max BECAUSE of this sort (see the type's docstring).
 */
function buildOrgRepeatedPeople(
  allGroups: readonly PersonGroup[],
  minComplaintsPerPerson: number,
  options: RepeatComplainantDirectoryOptions
): { people: RepeatPersonRow[]; orgTypeCountsByIdentifier: Map<string, Map<string, TypeCountEntry>> } {
  const orgTypeCountsByIdentifier = new Map<string, Map<string, TypeCountEntry>>();
  const orgRepeatedGroups = allGroups.filter((g) => orgTotalComplaints(g) >= minComplaintsPerPerson);
  let people = orgRepeatedGroups.map((group) => {
    const typeCountsFull = orgTypeCountsFull(group);
    orgTypeCountsByIdentifier.set(group.complainantIdentifier, typeCountsFull);
    return buildPersonRow(group, typeCountsFull);
  });
  people.sort((a, b) => b.totalComplaints - a.totalComplaints || a.complainantIdentifierMasked.localeCompare(b.complainantIdentifierMasked));
  if (options.sameTypeOnly) people = people.filter((p) => p.sameTypeRepeatCount >= 2);
  if (options.minDistinctTypes !== undefined) {
    const minTypes = options.minDistinctTypes;
    people = people.filter((p) => p.distinctComplaintTypesCount >= minTypes);
  }
  return { people, orgTypeCountsByIdentifier };
}

/** Org-wide topComplaintType (KPI + conclusions): summed from each ORG-repeated person's FULL type distribution, never their capped `topComplaintTypes` (spec §3). */
function computeOrgTopComplaintType(
  people: readonly RepeatPersonRow[],
  orgTypeCountsByIdentifier: ReadonlyMap<string, Map<string, TypeCountEntry>>
): { label: string; count: number } | null {
  const orgTypeCounts = new Map<string, TypeCountEntry>();
  for (const person of people) {
    const full = orgTypeCountsByIdentifier.get(person.complainantIdentifierRaw);
    if (full) mergeTypeCounts(orgTypeCounts, full);
  }
  return topFromTypeCounts(orgTypeCounts);
}

/** A technical import duplicate is never a real complaint, so it is excluded from every volume denominator too — not just repeat-group evidence (same convention as `pattern-findings-service.ts`'s own aggregation). */
function computeFacilityTotalsAll(records: readonly RepeatDirectoryRecord[]): Map<string, number> {
  const facilityTotalsAll = new Map<string, number>();
  for (const record of records) {
    if (isTechnicalDuplicate(record)) continue;
    const facility = record.facility.trim() || "غير محدد";
    facilityTotalsAll.set(facility, (facilityTotalsAll.get(facility) ?? 0) + 1);
  }
  return facilityTotalsAll;
}

/**
 * FACILITY-LEVEL rollups: independently re-evaluated per facility
 * membership (spec §2) — a person can be org-repeated without being
 * facility-repeated anywhere (e.g. 1 complaint at each of two facilities),
 * and is counted at MOST ONCE per facility, never derived by filtering the
 * org-level `people` list by their (single) primary facility.
 */
function buildFacilityAggregates(
  allGroups: readonly PersonGroup[],
  minComplaintsPerPerson: number,
  options: RepeatComplainantDirectoryOptions
): Map<string, FacilityAggregate> {
  const facilityAggregates = new Map<string, FacilityAggregate>();
  for (const group of allGroups) {
    for (const membership of group.facilities.values()) {
      if (!facilityMembershipMeetsThreshold(membership, minComplaintsPerPerson, options)) continue;
      const agg = facilityAggregates.get(membership.facility) ?? {
        region: membership.region,
        facility: membership.facility,
        repeatedPeopleCount: 0,
        repeatedComplaintsCount: 0,
        typeCountsFull: new Map<string, TypeCountEntry>(),
        highestRepeatByOnePerson: 0,
        maxPeriodsSpannedByOnePerson: 0,
      };
      agg.repeatedPeopleCount += 1;
      agg.repeatedComplaintsCount += membership.complaintIds.length;
      mergeTypeCounts(agg.typeCountsFull, membership.typeCountsFull);
      agg.highestRepeatByOnePerson = Math.max(agg.highestRepeatByOnePerson, membership.complaintIds.length);
      agg.maxPeriodsSpannedByOnePerson = Math.max(agg.maxPeriodsSpannedByOnePerson, periodsSpannedBy(membership.effectiveDates));
      facilityAggregates.set(membership.facility, agg);
    }
  }
  return facilityAggregates;
}

function buildFacilityRows(
  facilityAggregates: ReadonlyMap<string, FacilityAggregate>,
  facilityTotalsAll: ReadonlyMap<string, number>,
  totalDistinctPeriodsInScope: number,
  config: PatternAnalysisConfig
): RepeatFacilitySummaryRow[] {
  const facilities: RepeatFacilitySummaryRow[] = [...facilityAggregates.values()].map((agg) => {
    const facilityTotalComplaints = facilityTotalsAll.get(agg.facility) ?? 0;
    const priority = computeFacilityPriority(
      {
        repeatedComplaintsCount: agg.repeatedComplaintsCount,
        facilityTotalComplaints,
        repeatedPeopleCount: agg.repeatedPeopleCount,
        highestRepeatByOnePerson: agg.highestRepeatByOnePerson,
        distinctTypesInvolved: agg.typeCountsFull.size,
        maxPeriodsSpannedByOnePerson: agg.maxPeriodsSpannedByOnePerson,
        totalDistinctPeriodsInScope,
      },
      config
    );

    return {
      region: agg.region,
      facility: agg.facility,
      repeatedPeopleCount: agg.repeatedPeopleCount,
      repeatedComplaintsCount: agg.repeatedComplaintsCount,
      facilityTotalComplaints,
      repeatRatePercent:
        facilityTotalComplaints > 0
          ? Math.round((agg.repeatedComplaintsCount / facilityTotalComplaints) * 1000) / 10
          : 0,
      topComplaintType: topFromTypeCounts(agg.typeCountsFull),
      highestRepeatByOnePerson: agg.highestRepeatByOnePerson,
      priorityScore: priority.score,
      priorityBand: priority.band,
      drilldownFilters: { facility: agg.facility, region: agg.region },
      linkedChronicIssue: false,
      linkedMassComplaint: false,
      linkedHighPriorityFacility: false,
    };
  });
  facilities.sort((a, b) => b.repeatedPeopleCount - a.repeatedPeopleCount || a.facility.localeCompare(b.facility));
  return facilities;
}

/**
 * REGION rollups: repeatedPeopleCount/repeatedComplaintsCount are honest
 * sums of the (already facility-scoped) facility rows, but topComplaintType
 * is summed from EACH FACILITY'S FULL type distribution (spec §4) — never
 * composed by summing each facility's own already-capped topComplaintType,
 * which can make a region's true #1 type (split evenly across several
 * facilities' #2 slots) disappear entirely.
 */
function buildRegionRows(
  facilities: readonly RepeatFacilitySummaryRow[],
  facilityAggregates: ReadonlyMap<string, FacilityAggregate>
): RepeatRegionSummaryRow[] {
  const regionTypeCounts = new Map<string, Map<string, TypeCountEntry>>();
  for (const agg of facilityAggregates.values()) {
    const regionMap = regionTypeCounts.get(agg.region) ?? new Map<string, TypeCountEntry>();
    mergeTypeCounts(regionMap, agg.typeCountsFull);
    regionTypeCounts.set(agg.region, regionMap);
  }
  const byRegion = new Map<string, RepeatFacilitySummaryRow[]>();
  for (const facilityRow of facilities) {
    const list = byRegion.get(facilityRow.region) ?? [];
    list.push(facilityRow);
    byRegion.set(facilityRow.region, list);
  }
  const regions: RepeatRegionSummaryRow[] = [...byRegion.entries()].map(([region, regionFacilities]) => ({
    region,
    repeatedPeopleCount: regionFacilities.reduce((sum, f) => sum + f.repeatedPeopleCount, 0),
    repeatedComplaintsCount: regionFacilities.reduce((sum, f) => sum + f.repeatedComplaintsCount, 0),
    facilitiesAffectedCount: regionFacilities.length,
    topComplaintType: topFromTypeCounts(regionTypeCounts.get(region) ?? new Map()),
    drilldownFilters: { region },
  }));
  regions.sort((a, b) => b.repeatedPeopleCount - a.repeatedPeopleCount || a.region.localeCompare(b.region));
  return regions;
}

/**
 * Single-pass aggregation over already-fetched, filter-scoped complaint
 * records (spec: no N+1, no re-fetching). `totalComplaintsInScope` is the
 * count of ALL complaints matching the caller's filters (including
 * non-repeated / no-identifier ones) — the honest denominator for
 * "نسبة الشكاوى المتكررة من إجمالي شكاوى الفترة". Feature-specific filters
 * (`options`) are applied to the org-level person set BEFORE facility/region
 * rollups are derived (each independently re-evaluated against the SAME
 * options at its own scope — see `facilityMembershipMeetsThreshold`), so a
 * table and its own rollups can never disagree about what "repeated" means
 * at their respective level. Each stage of the pipeline (group -> org people
 * -> facility rollups -> region rollups) is its own small helper above, kept
 * that way deliberately so this orchestrator stays a flat sequence.
 */
export function buildRepeatComplainantDirectory(
  records: readonly RepeatDirectoryRecord[],
  totalComplaintsInScope: number,
  config: PatternAnalysisConfig = PATTERN_ANALYSIS_CONFIG,
  options: RepeatComplainantDirectoryOptions = {}
): RepeatComplainantDirectory {
  // Defaults to 2 (a "repeated" person is never < 2 complaints by
  // definition) but — unlike the public `minComplaints` query param, which
  // is floored at 2 in `parseRepeatDirectoryOptions` — this general-purpose
  // engine itself only floors at 1: `repeat-complainant-person-detail-service.ts`
  // deliberately passes `minComplaintsPerPerson: 1` to fetch one ALREADY-
  // IDENTIFIED (by token) person's stats regardless of whether they clear
  // the "repeated" threshold at the facility/scope being viewed — that is
  // not "who counts as repeated" filtering, so the >=2 business rule does
  // not apply to it.
  const minComplaintsPerPerson = Math.max(1, options.minComplaintsPerPerson ?? 2);

  const { personGroups, totalDistinctPeriodsInScope } = groupRecordsByPerson(records);
  const allGroups = [...personGroups.values()];

  const { people, orgTypeCountsByIdentifier } = buildOrgRepeatedPeople(allGroups, minComplaintsPerPerson, options);
  const topComplaintTypeOverall = computeOrgTopComplaintType(people, orgTypeCountsByIdentifier);

  const facilityTotalsAll = computeFacilityTotalsAll(records);
  const facilityAggregates = buildFacilityAggregates(allGroups, minComplaintsPerPerson, options);
  const facilities = buildFacilityRows(facilityAggregates, facilityTotalsAll, totalDistinctPeriodsInScope.size, config);
  const regions = buildRegionRows(facilities, facilityAggregates);

  const repeatedPeopleCount = people.length;
  const repeatedComplaintsCount = people.reduce((sum, p) => sum + p.totalComplaints, 0);
  const topFacilityRow = facilities[0] ?? null;

  return {
    kpis: {
      repeatedPeopleCount,
      repeatedComplaintsCount,
      repeatedShareOfPeriodPercent:
        totalComplaintsInScope > 0
          ? Math.round((repeatedComplaintsCount / totalComplaintsInScope) * 1000) / 10
          : 0,
      topFacility: topFacilityRow
        ? { facility: topFacilityRow.facility, region: topFacilityRow.region, repeatedPeopleCount: topFacilityRow.repeatedPeopleCount }
        : null,
      topComplaintType: topComplaintTypeOverall,
    },
    regions,
    facilities,
    people,
  };
}

/**
 * Tags each facility row with whether it is ALSO flagged by the
 * multi-period pattern-analysis engine (spec §16: integration with existing
 * findings) — reuses `findings` verbatim, never recomputes chronic-issue or
 * priority logic here. `highPriorityFacilities` is the caller's own
 * already-ranked "needs follow-up" set (e.g. from the V2 report builder or
 * a fresh priority pass) so this stays a pure lookup, not a new score.
 */
export function enrichFacilitiesWithPatternSignals(
  facilities: readonly RepeatFacilitySummaryRow[],
  findings: readonly AnalyticalFinding[],
  highPriorityFacilityNames: ReadonlySet<string> = new Set()
): RepeatFacilitySummaryRow[] {
  const chronicFacilities = new Set(
    findings.filter((f) => f.type === "CHRONIC_ISSUE").map((f) => f.drilldownFilters.facility).filter((v): v is string => typeof v === "string")
  );
  const massComplaintFacilities = new Set(
    findings.filter((f) => f.type === "MASS_COMPLAINT").map((f) => f.drilldownFilters.facility).filter((v): v is string => typeof v === "string")
  );
  return facilities.map((row) => ({
    ...row,
    linkedChronicIssue: chronicFacilities.has(row.facility),
    linkedMassComplaint: massComplaintFacilities.has(row.facility),
    linkedHighPriorityFacility: highPriorityFacilityNames.has(row.facility),
  }));
}

/**
 * Short executive-conclusion sentences (spec) — built ONLY from already
 * computed aggregates, never re-deriving anything, and never mentioning a
 * raw complainant identifier. Descriptions of the DATA, never a judgment
 * about a person (spec §19) — no behavioral/accusatory phrasing.
 */
export function buildRepeatComplainantConclusions(directory: RepeatComplainantDirectory): string[] {
  const points: string[] = [];
  const top = directory.facilities[0];
  if (top) {
    points.push(
      `أكثر السجون التي يظهر فيها تكرار الشكاوى هو ${top.facility} بعدد ${top.repeatedPeopleCount} من الأشخاص المكررين وإجمالي ${top.repeatedComplaintsCount} شكوى متكررة.`
    );
  }
  if (directory.kpis.topComplaintType) {
    points.push(`أكثر نوع شكوى متكرر بين الأشخاص المكررين هو ${directory.kpis.topComplaintType.label}.`);
  }
  const topRegion = directory.regions[0];
  if (topRegion && directory.kpis.repeatedComplaintsCount > 0) {
    const sharePercent = Math.round((topRegion.repeatedComplaintsCount / directory.kpis.repeatedComplaintsCount) * 1000) / 10;
    points.push(`تركز التكرار في ${topRegion.region} بنسبة ${sharePercent}% من إجمالي الشكاوى المتكررة.`);
  }
  // Relies on `people` being sorted by totalComplaints descending — an
  // invariant `buildRepeatComplainantDirectory` documents and guarantees
  // (see its docstring), not recomputed here as a separate max.
  const topPerson = directory.people[0];
  if (topPerson) {
    const topType = topPerson.topComplaintTypes[0];
    const typeClause = topType ? `، تركزت معظمها في ${topType.label}` : "";
    const locationClause = topPerson.facilitiesCount > 1 ? `عبر ${topPerson.facilitiesCount} سجون` : `داخل ${topPerson.facility}`;
    points.push(`أعلى تكرار مسجل خلال الفترة بلغ ${topPerson.totalComplaints} شكاوى لمقدم شكوى واحد${typeClause} ${locationClause}.`);
  }
  return points.slice(0, 5);
}
