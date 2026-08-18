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
  if (!record.complainantIdentifier || !record.complainantIdentifier.trim()) return false;
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

function monthKeyOf(effectiveDate: string): string {
  return effectiveDate.slice(0, 7); // yyyy-mm
}

export type ComplaintTypeCount = { classificationId: string; label: string; count: number };

/** Behavioral pattern label — a description of the DATA, never a judgment about the person (spec). */
export type RepeatPersonPattern = "CONCENTRATED" | "DIVERSE";

/** Share of a person's complaints in their single most-common type at/above which the pattern is "concentrated". */
const CONCENTRATION_SHARE_THRESHOLD = 0.6;
/** Share of a person's complaints falling in their own most-recent month at/above which "نشاط حديث" applies. */
const RECENT_ACTIVITY_SHARE_THRESHOLD = 0.5;

export type RepeatPersonRow = {
  complainantIdentifierMasked: string;
  /** Internal-use only — never rendered as visible text, never put in a URL; used only for the explicit reveal toggle (client-state, never URL state) and to derive the drillthrough token server-side. */
  complainantIdentifierRaw: string;
  /** From the import source; null (never inferred/fabricated) when the source never recorded a name. */
  complainantName: string | null;
  region: string;
  facility: string;
  totalComplaints: number;
  /** Complaints in this person's single most-repeated type, when that type recurs (>=2); 0 otherwise. */
  sameTypeRepeatCount: number;
  distinctComplaintTypesCount: number;
  topComplaintTypes: ComplaintTypeCount[];
  firstComplaintDate: string;
  lastComplaintDate: string;
  /** Distinct calendar months this person's complaints fall in, within the queried range. */
  periodsPresent: number;
  spansMultiplePeriods: boolean;
  /** Most of this person's complaints landed in their own most-recent month within the range ("نشاط حديث") — independent of `pattern`, not mutually exclusive with it. */
  recentActivity: boolean;
  pattern: RepeatPersonPattern;
  /** Capped list of complaint ids for evidence; drillthrough itself uses the filters below, not this list. */
  complaintIds: string[];
  /** Never includes the identifier — the server layer attaches an opaque `complainantToken` on top of this for drillthrough (see `attachPersonDrillthroughTokens`). */
  drilldownFilters: { facility: string; region: string };
};

export type RepeatFacilitySummaryRow = {
  region: string;
  facility: string;
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
  /** Every eligible repeated person org-wide, unpaginated/unsorted — callers slice per facility on demand. */
  people: RepeatPersonRow[];
};

type PersonGroup = {
  complainantIdentifier: string;
  /** The most-recently-seen non-empty name for this person in the scanned records; names are never merged/guessed across conflicting values. */
  complainantName: string | null;
  region: string;
  facility: string;
  complaintIds: string[];
  effectiveDates: string[];
  typeCounts: Map<string, { label: string; count: number }>;
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

function buildPersonRow(group: PersonGroup): RepeatPersonRow {
  const totalComplaints = group.complaintIds.length;
  const topComplaintTypes = [...group.typeCounts.entries()]
    .map(([classificationId, entry]) => ({ classificationId, label: entry.label, count: entry.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_TOP_TYPES);
  const topType = topComplaintTypes[0] ?? null;
  const sameTypeRepeatCount = topType && topType.count >= 2 ? topType.count : 0;
  const distinctComplaintTypesCount = group.typeCounts.size;
  const sortedDates = [...group.effectiveDates].sort();
  const periodsPresent = new Set(group.effectiveDates.map(monthKeyOf)).size;
  const firstComplaintDate = sortedDates[0] ?? "";
  const lastComplaintDate = sortedDates.at(-1) ?? "";
  const concentrationShare = totalComplaints > 0 ? (topType?.count ?? 0) / totalComplaints : 0;
  const mostRecentMonth = monthKeyOf(lastComplaintDate);
  const complaintsInMostRecentMonth = group.effectiveDates.filter((d) => monthKeyOf(d) === mostRecentMonth).length;
  const recentActivityShare = totalComplaints > 0 ? complaintsInMostRecentMonth / totalComplaints : 0;

  return {
    complainantIdentifierMasked: maskComplainantIdentifier(group.complainantIdentifier),
    complainantIdentifierRaw: group.complainantIdentifier,
    complainantName: group.complainantName,
    region: group.region,
    facility: group.facility,
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
    complaintIds: group.complaintIds.slice(0, MAX_EVIDENCE_IDS),
    drilldownFilters: {
      facility: group.facility,
      region: group.region,
    },
  };
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

/**
 * Single-pass aggregation over already-fetched, filter-scoped complaint
 * records (spec: no N+1, no re-fetching). `totalComplaintsInScope` is the
 * count of ALL complaints matching the caller's filters (including
 * non-repeated / no-identifier ones) — the honest denominator for
 * "نسبة الشكاوى المتكررة من إجمالي شكاوى الفترة". Feature-specific filters
 * (`options`) are applied to the person set BEFORE facility/region rollups
 * are derived, so a table and its own rollups can never disagree.
 */
export function buildRepeatComplainantDirectory(
  records: readonly RepeatDirectoryRecord[],
  totalComplaintsInScope: number,
  config: PatternAnalysisConfig = PATTERN_ANALYSIS_CONFIG,
  options: RepeatComplainantDirectoryOptions = {}
): RepeatComplainantDirectory {
  const minComplaintsPerPerson = Math.max(2, options.minComplaintsPerPerson ?? 2);
  const groups = new Map<string, PersonGroup>();
  const totalDistinctPeriodsInScope = new Set<string>();

  for (const record of records) {
    totalDistinctPeriodsInScope.add(monthKeyOf(record.effectiveDate));
    if (!isEligible(record)) continue;

    const region = displayRegionName(normalizeRegionName(record.region));
    const facility = record.facility.trim() || "غير محدد";
    const groupKey = `${facility} ${record.complainantIdentifier}`;
    const { key: typeKey, label: typeLabel } = classificationOf(record);

    const group = groups.get(groupKey) ?? {
      complainantIdentifier: record.complainantIdentifier!,
      complainantName: null,
      region,
      facility,
      complaintIds: [],
      effectiveDates: [],
      typeCounts: new Map<string, { label: string; count: number }>(),
    };
    group.complaintIds.push(record.complaintId);
    group.effectiveDates.push(record.effectiveDate);
    if (record.complainantName?.trim()) group.complainantName = record.complainantName.trim();
    const typeEntry = group.typeCounts.get(typeKey) ?? { label: typeLabel, count: 0 };
    typeEntry.count += 1;
    group.typeCounts.set(typeKey, typeEntry);
    groups.set(groupKey, group);
  }

  // A "repeated person" has >= minComplaintsPerPerson (default 2) eligible
  // complaints at this facility, in any type — never gated on same-topic or
  // multi-period presence (spec: distinct from the multi-period pattern
  // engine's narrower definition).
  const repeatedGroups = [...groups.values()].filter((g) => g.complaintIds.length >= minComplaintsPerPerson);
  let people = repeatedGroups.map(buildPersonRow).sort((a, b) => b.totalComplaints - a.totalComplaints);
  if (options.sameTypeOnly) people = people.filter((p) => p.sameTypeRepeatCount >= 2);
  if (options.minDistinctTypes !== undefined) {
    const minTypes = options.minDistinctTypes;
    people = people.filter((p) => p.distinctComplaintTypesCount >= minTypes);
  }

  const orgTypeCounts = new Map<string, number>();
  for (const person of people) {
    for (const type of person.topComplaintTypes) {
      orgTypeCounts.set(type.label, (orgTypeCounts.get(type.label) ?? 0) + type.count);
    }
  }
  const topComplaintTypeOverall = [...orgTypeCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)[0] ?? null;

  // A technical import duplicate is never a real complaint, so it is excluded
  // from every volume denominator too — not just from repeat-group evidence
  // (same convention as `pattern-findings-service.ts`'s own aggregation).
  const facilityTotalsAll = new Map<string, number>();
  for (const record of records) {
    if (isTechnicalDuplicate(record)) continue;
    const facility = record.facility.trim() || "غير محدد";
    facilityTotalsAll.set(facility, (facilityTotalsAll.get(facility) ?? 0) + 1);
  }

  const byFacility = new Map<string, RepeatPersonRow[]>();
  for (const person of people) {
    const list = byFacility.get(person.facility) ?? [];
    list.push(person);
    byFacility.set(person.facility, list);
  }

  const facilities: RepeatFacilitySummaryRow[] = [...byFacility.entries()].map(([facility, facilityPeople]) => {
    const region = facilityPeople[0]?.region ?? "غير محدد";
    const repeatedComplaintsCount = facilityPeople.reduce((sum, p) => sum + p.totalComplaints, 0);
    const typeCounts = new Map<string, number>();
    for (const person of facilityPeople) {
      for (const type of person.topComplaintTypes) {
        typeCounts.set(type.label, (typeCounts.get(type.label) ?? 0) + type.count);
      }
    }
    const topComplaintType = [...typeCounts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)[0] ?? null;
    const distinctTypesInvolved = typeCounts.size;
    const facilityTotalComplaints = facilityTotalsAll.get(facility) ?? 0;
    const highestRepeatByOnePerson = Math.max(...facilityPeople.map((p) => p.totalComplaints));
    const maxPeriodsSpannedByOnePerson = Math.max(...facilityPeople.map((p) => p.periodsPresent));

    const priority = computeFacilityPriority(
      {
        repeatedComplaintsCount,
        facilityTotalComplaints,
        repeatedPeopleCount: facilityPeople.length,
        highestRepeatByOnePerson,
        distinctTypesInvolved,
        maxPeriodsSpannedByOnePerson,
        totalDistinctPeriodsInScope: totalDistinctPeriodsInScope.size,
      },
      config
    );

    return {
      region,
      facility,
      repeatedPeopleCount: facilityPeople.length,
      repeatedComplaintsCount,
      facilityTotalComplaints,
      repeatRatePercent:
        facilityTotalComplaints > 0
          ? Math.round((repeatedComplaintsCount / facilityTotalComplaints) * 1000) / 10
          : 0,
      topComplaintType,
      highestRepeatByOnePerson,
      priorityScore: priority.score,
      priorityBand: priority.band,
      drilldownFilters: { facility, region },
      linkedChronicIssue: false,
      linkedMassComplaint: false,
      linkedHighPriorityFacility: false,
    };
  });
  facilities.sort((a, b) => b.repeatedPeopleCount - a.repeatedPeopleCount);

  const byRegion = new Map<string, RepeatFacilitySummaryRow[]>();
  for (const facilityRow of facilities) {
    const list = byRegion.get(facilityRow.region) ?? [];
    list.push(facilityRow);
    byRegion.set(facilityRow.region, list);
  }
  const regions: RepeatRegionSummaryRow[] = [...byRegion.entries()].map(([region, regionFacilities]) => {
    const typeCounts = new Map<string, number>();
    for (const facilityRow of regionFacilities) {
      if (facilityRow.topComplaintType) {
        typeCounts.set(
          facilityRow.topComplaintType.label,
          (typeCounts.get(facilityRow.topComplaintType.label) ?? 0) + facilityRow.topComplaintType.count
        );
      }
    }
    return {
      region,
      repeatedPeopleCount: regionFacilities.reduce((sum, f) => sum + f.repeatedPeopleCount, 0),
      repeatedComplaintsCount: regionFacilities.reduce((sum, f) => sum + f.repeatedComplaintsCount, 0),
      facilitiesAffectedCount: regionFacilities.length,
      topComplaintType:
        [...typeCounts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count)[0]
        ?? null,
      drilldownFilters: { region },
    };
  });
  regions.sort((a, b) => b.repeatedPeopleCount - a.repeatedPeopleCount);

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
 * raw complainant identifier.
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
  const topPerson = directory.people[0];
  if (topPerson) {
    const topType = topPerson.topComplaintTypes[0];
    points.push(
      `الشخص الأعلى تكراراً في الفترة تقدم بـ${topPerson.totalComplaints} شكاوى${topType ? `، تركزت في ${topType.label}` : ""} داخل ${topPerson.facility}.`
    );
  }
  return points.slice(0, 5);
}
