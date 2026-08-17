import { describe, expect, it } from "vitest";
import {
  buildRepeatComplainantDirectory,
  buildRepeatComplainantConclusions,
  enrichFacilitiesWithPatternSignals,
  maskComplainantIdentifier,
  type RepeatDirectoryRecord,
} from "./repeat-complainant-directory";
import type { AnalyticalFinding } from "./analytical-finding";

function finding(overrides: Partial<AnalyticalFinding>): AnalyticalFinding {
  return {
    id: overrides.id ?? "f",
    type: overrides.type ?? "CHRONIC_ISSUE",
    entityType: overrides.entityType ?? "CLASSIFICATION",
    entityId: null,
    entityName: overrides.entityName ?? "سجن — التغذية",
    currentValue: 10,
    previousValue: 5,
    difference: 5,
    changeRate: 100,
    severity: "MEDIUM",
    priorityScore: 50,
    confidence: "MEDIUM",
    detectionSource: "QUANTITATIVE",
    explanation: "x",
    supportingMetrics: {},
    evidenceComplaintIds: [],
    evidenceSpans: [],
    limitations: [],
    drilldownFilters: overrides.drilldownFilters ?? {},
    firstDetectedAt: "2026-01-01T00:00:00.000Z",
    lastDetectedAt: "2026-01-01T00:00:00.000Z",
    detectorVersion: "pattern-v1",
    ...overrides,
  };
}

function record(overrides: Partial<RepeatDirectoryRecord> & { complaintId: string }): RepeatDirectoryRecord {
  return {
    complaintId: overrides.complaintId,
    complainantIdentifier: overrides.complainantIdentifier ?? "1234567890",
    region: overrides.region ?? "منطقة الرياض",
    facility: overrides.facility ?? "سجن أ",
    classificationId: overrides.classificationId ?? "cls-food",
    classificationLabel: overrides.classificationLabel ?? "التغذية",
    effectiveDate: overrides.effectiveDate ?? "2026-06-15",
    isPotentialDuplicate: overrides.isPotentialDuplicate ?? false,
    duplicateOfId: overrides.duplicateOfId ?? null,
  };
}

describe("maskComplainantIdentifier", () => {
  it("keeps the last 4 characters visible and masks the rest, per spec example format", () => {
    expect(maskComplainantIdentifier("1234567894821")).toBe("*********4821");
    expect(maskComplainantIdentifier("10004821")).toBe("****4821");
  });

  it("never exposes more than the last 4 characters even for short identifiers", () => {
    expect(maskComplainantIdentifier("123")).toBe("*23");
    expect(maskComplainantIdentifier("12345")).toBe("*2345");
    expect(maskComplainantIdentifier("1")).toBe("*");
    expect(maskComplainantIdentifier("")).toBe("");
  });
});

describe("buildRepeatComplainantDirectory", () => {
  it("flags a person with several complaints in the SAME type as a repeated person, concentrated pattern", () => {
    const records = [
      record({ complaintId: "a1", complainantIdentifier: "P1" }),
      record({ complaintId: "a2", complainantIdentifier: "P1" }),
      record({ complaintId: "a3", complainantIdentifier: "P1" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 10);
    expect(directory.people).toHaveLength(1);
    const person = directory.people[0]!;
    expect(person.totalComplaints).toBe(3);
    expect(person.sameTypeRepeatCount).toBe(3);
    expect(person.distinctComplaintTypesCount).toBe(1);
    expect(person.pattern).toBe("CONCENTRATED");
  });

  it("flags a person with complaints spread across DIFFERENT types as a repeated person, diverse pattern", () => {
    const records = [
      record({ complaintId: "b1", complainantIdentifier: "P2", classificationId: "cls-food", classificationLabel: "التغذية" }),
      record({ complaintId: "b2", complainantIdentifier: "P2", classificationId: "cls-health", classificationLabel: "الرعاية الصحية" }),
      record({ complaintId: "b3", complainantIdentifier: "P2", classificationId: "cls-visit", classificationLabel: "الزيارات" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 10);
    const person = directory.people.find((p) => p.complainantIdentifierRaw === "P2")!;
    expect(person.distinctComplaintTypesCount).toBe(3);
    expect(person.sameTypeRepeatCount).toBe(0); // no single type recurs
    expect(person.pattern).toBe("DIVERSE");
  });

  it("marks spansMultiplePeriods true only when complaints land in >= 2 distinct calendar months", () => {
    const records = [
      record({ complaintId: "c1", complainantIdentifier: "P3", effectiveDate: "2026-01-10" }),
      record({ complaintId: "c2", complainantIdentifier: "P3", effectiveDate: "2026-03-20" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 10);
    const person = directory.people[0]!;
    expect(person.periodsPresent).toBe(2);
    expect(person.spansMultiplePeriods).toBe(true);
  });

  it("does NOT require multi-period presence to count as repeated — same-month repeats still count", () => {
    const records = [
      record({ complaintId: "d1", complainantIdentifier: "P4", effectiveDate: "2026-01-10" }),
      record({ complaintId: "d2", complainantIdentifier: "P4", effectiveDate: "2026-01-11" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 10);
    expect(directory.people).toHaveLength(1);
    expect(directory.people[0]!.spansMultiplePeriods).toBe(false);
  });

  it("aggregates correctly by facility and by region", () => {
    const records = [
      record({ complaintId: "e1", complainantIdentifier: "P5", facility: "سجن أ", region: "منطقة الرياض" }),
      record({ complaintId: "e2", complainantIdentifier: "P5", facility: "سجن أ", region: "منطقة الرياض" }),
      record({ complaintId: "e3", complainantIdentifier: "P6", facility: "سجن ب", region: "منطقة الرياض" }),
      record({ complaintId: "e4", complainantIdentifier: "P6", facility: "سجن ب", region: "منطقة الرياض" }),
      record({ complaintId: "e5", complainantIdentifier: "P7", facility: "سجن ج", region: "منطقة مكة المكرمة" }),
      record({ complaintId: "e6", complainantIdentifier: "P7", facility: "سجن ج", region: "منطقة مكة المكرمة" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 20);
    expect(directory.facilities).toHaveLength(3);
    expect(directory.facilities.every((f) => f.repeatedPeopleCount === 1)).toBe(true);
    const riyadh = directory.regions.find((r) => r.region === "منطقة الرياض")!;
    expect(riyadh.repeatedPeopleCount).toBe(2);
    expect(riyadh.facilitiesAffectedCount).toBe(2);
    const makkah = directory.regions.find((r) => r.region === "منطقة مكة المكرمة")!;
    expect(makkah.repeatedPeopleCount).toBe(1);
  });

  it("ranks the top-facilities list by repeated-people count, descending", () => {
    const records = [
      // سجن كبير: 2 repeated people
      record({ complaintId: "f1", complainantIdentifier: "PA", facility: "سجن كبير" }),
      record({ complaintId: "f2", complainantIdentifier: "PA", facility: "سجن كبير" }),
      record({ complaintId: "f3", complainantIdentifier: "PB", facility: "سجن كبير" }),
      record({ complaintId: "f4", complainantIdentifier: "PB", facility: "سجن كبير" }),
      // سجن صغير: 1 repeated person
      record({ complaintId: "f5", complainantIdentifier: "PC", facility: "سجن صغير" }),
      record({ complaintId: "f6", complainantIdentifier: "PC", facility: "سجن صغير" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 20);
    expect(directory.facilities[0]!.facility).toBe("سجن كبير");
    expect(directory.facilities[0]!.repeatedPeopleCount).toBe(2);
  });

  it("computes repeat rate as a share of the facility's own total complaints, not the org total", () => {
    const records = [
      record({ complaintId: "g1", complainantIdentifier: "PD", facility: "سجن د" }),
      record({ complaintId: "g2", complainantIdentifier: "PD", facility: "سجن د" }),
      record({ complaintId: "g3", complainantIdentifier: "solo", facility: "سجن د" }), // non-repeated, still counts toward facility total
      record({ complaintId: "g4", complainantIdentifier: "solo2", facility: "سجن د" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 20);
    const row = directory.facilities.find((f) => f.facility === "سجن د")!;
    expect(row.facilityTotalComplaints).toBe(4);
    expect(row.repeatedComplaintsCount).toBe(2);
    expect(row.repeatRatePercent).toBe(50);
  });

  it("excludes technical-duplicate-import records from repeat evidence", () => {
    const records = [
      record({ complaintId: "h1", complainantIdentifier: "PE" }),
      record({ complaintId: "h2", complainantIdentifier: "PE" }),
      record({ complaintId: "h3", complainantIdentifier: "PE", isPotentialDuplicate: true }),
      record({ complaintId: "h4", complainantIdentifier: "PE", duplicateOfId: "h1" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 20);
    expect(directory.people).toHaveLength(1);
    expect(directory.people[0]!.totalComplaints).toBe(2);
  });

  it("excludes empty/blank complainant identifiers", () => {
    const records = [
      record({ complaintId: "i1", complainantIdentifier: "" }),
      record({ complaintId: "i2", complainantIdentifier: "   " }),
      record({ complaintId: "i3", complainantIdentifier: null }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 20);
    expect(directory.people).toEqual([]);
    expect(directory.kpis.repeatedPeopleCount).toBe(0);
  });

  it("never masks the identifier in complainantIdentifierRaw, but always masks complainantIdentifierMasked", () => {
    const records = [
      record({ complaintId: "j1", complainantIdentifier: "9988776655" }),
      record({ complaintId: "j2", complainantIdentifier: "9988776655" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 20);
    const person = directory.people[0]!;
    expect(person.complainantIdentifierRaw).toBe("9988776655");
    expect(person.complainantIdentifierMasked).not.toBe("9988776655");
    expect(person.complainantIdentifierMasked.endsWith("6655")).toBe(true);
    expect(person.complainantIdentifierMasked.startsWith("*")).toBe(true);
  });

  it("computes the period-total repeat share honestly against totalComplaintsInScope, including non-repeated complaints", () => {
    const records = [
      record({ complaintId: "k1", complainantIdentifier: "PF" }),
      record({ complaintId: "k2", complainantIdentifier: "PF" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 8);
    expect(directory.kpis.repeatedComplaintsCount).toBe(2);
    expect(directory.kpis.repeatedShareOfPeriodPercent).toBe(25);
  });

  it("produces no NaN/Infinity anywhere when totalComplaintsInScope is 0", () => {
    const directory = buildRepeatComplainantDirectory([], 0);
    expect(directory.kpis.repeatedShareOfPeriodPercent).toBe(0);
    expect(Number.isFinite(directory.kpis.repeatedShareOfPeriodPercent)).toBe(true);
    expect(directory.facilities).toEqual([]);
    expect(directory.regions).toEqual([]);
  });

  it("computes a facility priority score/band from the reused multi-factor priority-score function, never a single raw number", () => {
    const records = Array.from({ length: 12 }, (_, i) =>
      record({ complaintId: `m${i}`, complainantIdentifier: `person-${i % 3}`, facility: "سجن هـ" })
    );
    const directory = buildRepeatComplainantDirectory(records, 20);
    const row = directory.facilities.find((f) => f.facility === "سجن هـ")!;
    expect(Number.isFinite(row.priorityScore)).toBe(true);
    expect(["HIGH", "MEDIUM", "LOW"]).toContain(row.priorityBand);
  });
});

describe("buildRepeatComplainantDirectory — feature-specific filters", () => {
  it("raises the repeated-person bar via minComplaintsPerPerson, and rollups reflect the SAME filtered set", () => {
    const records = [
      record({ complaintId: "o1", complainantIdentifier: "P1", facility: "سجن و" }),
      record({ complaintId: "o2", complainantIdentifier: "P1", facility: "سجن و" }),
      record({ complaintId: "o3", complainantIdentifier: "P2", facility: "سجن و" }),
      record({ complaintId: "o4", complainantIdentifier: "P2", facility: "سجن و" }),
      record({ complaintId: "o5", complainantIdentifier: "P2", facility: "سجن و" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 20, undefined, { minComplaintsPerPerson: 3 });
    expect(directory.people).toHaveLength(1);
    expect(directory.people[0]!.complainantIdentifierRaw).toBe("P2");
    const row = directory.facilities.find((f) => f.facility === "سجن و")!;
    expect(row.repeatedPeopleCount).toBe(1);
    expect(row.repeatedComplaintsCount).toBe(3);
  });

  it("sameTypeOnly keeps only people whose repetition concentrates in one type", () => {
    const records = [
      record({ complaintId: "p1", complainantIdentifier: "SAME", classificationId: "cls-food" }),
      record({ complaintId: "p2", complainantIdentifier: "SAME", classificationId: "cls-food" }),
      record({ complaintId: "p3", complainantIdentifier: "MIXED", classificationId: "cls-food" }),
      record({ complaintId: "p4", complainantIdentifier: "MIXED", classificationId: "cls-health", classificationLabel: "الرعاية الصحية" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 20, undefined, { sameTypeOnly: true });
    expect(directory.people.map((p) => p.complainantIdentifierRaw)).toEqual(["SAME"]);
  });

  it("minDistinctTypes keeps only people spread across at least N types", () => {
    const records = [
      record({ complaintId: "q1", complainantIdentifier: "SAME", classificationId: "cls-food" }),
      record({ complaintId: "q2", complainantIdentifier: "SAME", classificationId: "cls-food" }),
      record({ complaintId: "q3", complainantIdentifier: "MIXED", classificationId: "cls-food" }),
      record({ complaintId: "q4", complainantIdentifier: "MIXED", classificationId: "cls-health", classificationLabel: "الرعاية الصحية" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 20, undefined, { minDistinctTypes: 2 });
    expect(directory.people.map((p) => p.complainantIdentifierRaw)).toEqual(["MIXED"]);
  });
});

describe("enrichFacilitiesWithPatternSignals", () => {
  it("tags facilities from the reused pattern-engine findings without recomputing anything", () => {
    const records = [
      record({ complaintId: "r1", complainantIdentifier: "P1", facility: "سجن مزمن" }),
      record({ complaintId: "r2", complainantIdentifier: "P1", facility: "سجن مزمن" }),
      record({ complaintId: "r3", complainantIdentifier: "P2", facility: "سجن هادئ" }),
      record({ complaintId: "r4", complainantIdentifier: "P2", facility: "سجن هادئ" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 20);
    const findings = [
      finding({ id: "c1", type: "CHRONIC_ISSUE", drilldownFilters: { facility: "سجن مزمن" } }),
      finding({ id: "m1", type: "MASS_COMPLAINT", entityType: "FACILITY", drilldownFilters: { facility: "سجن هادئ" } }),
    ];
    const enriched = enrichFacilitiesWithPatternSignals(directory.facilities, findings, new Set(["سجن مزمن"]));
    const chronic = enriched.find((f) => f.facility === "سجن مزمن")!;
    const mass = enriched.find((f) => f.facility === "سجن هادئ")!;
    expect(chronic.linkedChronicIssue).toBe(true);
    expect(chronic.linkedHighPriorityFacility).toBe(true);
    expect(chronic.linkedMassComplaint).toBe(false);
    expect(mass.linkedMassComplaint).toBe(true);
    expect(mass.linkedChronicIssue).toBe(false);
    expect(mass.linkedHighPriorityFacility).toBe(false);
  });
});

describe("buildRepeatComplainantConclusions", () => {
  it("never mentions a raw complainant identifier", () => {
    const records = [
      record({ complaintId: "n1", complainantIdentifier: "1122334455" }),
      record({ complaintId: "n2", complainantIdentifier: "1122334455" }),
      record({ complaintId: "n3", complainantIdentifier: "1122334455" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 10);
    const conclusions = buildRepeatComplainantConclusions(directory);
    expect(conclusions.length).toBeGreaterThan(0);
    for (const line of conclusions) {
      expect(line).not.toContain("1122334455");
    }
  });

  it("returns an empty list when there are no repeated people", () => {
    expect(buildRepeatComplainantConclusions(buildRepeatComplainantDirectory([], 0))).toEqual([]);
  });
});
