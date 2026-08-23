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
    complainantName: overrides.complainantName ?? null,
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
  it("uses the established codebase masking convention: fixed '****' prefix + last 4 characters", () => {
    expect(maskComplainantIdentifier("1234567894821")).toBe("****4821");
    expect(maskComplainantIdentifier("10004821")).toBe("****4821");
  });

  it("never leaks the identifier's true length — always exactly 4 stars regardless of input length", () => {
    expect(maskComplainantIdentifier("123")).toBe("****");
    expect(maskComplainantIdentifier("12345")).toBe("****2345");
    expect(maskComplainantIdentifier("1")).toBe("****");
    expect(maskComplainantIdentifier("")).toBe("****");
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
    // 3 distinct people at this facility (PD, solo, solo2), only 1 (PD) repeated -> 33.3%.
    // Deliberately different from repeatRatePercent (a complaint-volume share) —
    // this is a headcount share.
    expect(row.repeatedPeopleSharePercent).toBeCloseTo(33.3, 1);
  });

  it("repeatedPeopleSharePercent is a headcount ratio, independent of repeatRatePercent (a complaint-volume ratio) — the two can diverge", () => {
    const records = [
      // 4 distinct people at the facility; only 2 repeat (>=2 complaints each).
      record({ complaintId: "h1", complainantIdentifier: "R1", facility: "سجن هـ" }),
      record({ complaintId: "h2", complainantIdentifier: "R1", facility: "سجن هـ" }),
      record({ complaintId: "h3", complainantIdentifier: "R2", facility: "سجن هـ" }),
      record({ complaintId: "h4", complainantIdentifier: "R2", facility: "سجن هـ" }),
      record({ complaintId: "h5", complainantIdentifier: "solo1", facility: "سجن هـ" }),
      record({ complaintId: "h6", complainantIdentifier: "solo2", facility: "سجن هـ" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 20);
    const row = directory.facilities.find((f) => f.facility === "سجن هـ")!;
    // Headcount share: 2 repeaters / 4 distinct people = 50%.
    expect(row.repeatedPeopleSharePercent).toBe(50);
    // Complaint-volume share: 4 repeated complaints / 6 total complaints = 66.7%.
    expect(row.repeatRatePercent).toBeCloseTo(66.7, 1);
  });

  it("produces no NaN/Infinity for repeatedPeopleSharePercent when a facility has zero eligible people", () => {
    const directory = buildRepeatComplainantDirectory([], 0);
    expect(directory.facilities).toEqual([]);
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

describe("buildRepeatComplainantDirectory — name, dates, drilldownFilters, recent activity", () => {
  it("surfaces the complainant name when the import source recorded one", () => {
    const records = [
      record({ complaintId: "n1", complainantIdentifier: "P10", complainantName: "محمد أحمد" }),
      record({ complaintId: "n2", complainantIdentifier: "P10", complainantName: "محمد أحمد" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 10);
    expect(directory.people[0]!.complainantName).toBe("محمد أحمد");
  });

  it("never fabricates a name — stays null when the source never recorded one", () => {
    const records = [
      record({ complaintId: "n3", complainantIdentifier: "P11", complainantName: null }),
      record({ complaintId: "n4", complainantIdentifier: "P11", complainantName: null }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 10);
    expect(directory.people[0]!.complainantName).toBeNull();
  });

  it("tracks firstComplaintDate and lastComplaintDate independently", () => {
    const records = [
      record({ complaintId: "d1", complainantIdentifier: "P12", effectiveDate: "2026-01-05" }),
      record({ complaintId: "d2", complainantIdentifier: "P12", effectiveDate: "2026-03-20" }),
      record({ complaintId: "d3", complainantIdentifier: "P12", effectiveDate: "2026-02-10" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 10);
    const person = directory.people[0]!;
    expect(person.firstComplaintDate).toBe("2026-01-05");
    expect(person.lastComplaintDate).toBe("2026-03-20");
  });

  it("never includes the identifier in drilldownFilters — only facility/region", () => {
    const records = [
      record({ complaintId: "e1", complainantIdentifier: "P13" }),
      record({ complaintId: "e2", complainantIdentifier: "P13" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 10);
    expect(directory.people[0]!.drilldownFilters).toEqual({ facility: "سجن أ", region: "منطقة الرياض" });
    expect(Object.keys(directory.people[0]!.drilldownFilters)).not.toContain("complainantIdentifier");
  });

  it("flags recentActivity when most of a person's complaints land in their own most-recent month", () => {
    const records = [
      record({ complaintId: "r1", complainantIdentifier: "P14", effectiveDate: "2026-01-05" }),
      record({ complaintId: "r2", complainantIdentifier: "P14", effectiveDate: "2026-03-01" }),
      record({ complaintId: "r3", complainantIdentifier: "P14", effectiveDate: "2026-03-10" }),
      record({ complaintId: "r4", complainantIdentifier: "P14", effectiveDate: "2026-03-15" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 10);
    expect(directory.people[0]!.recentActivity).toBe(true);
  });

  it("does not flag recentActivity when complaints are evenly spread across periods", () => {
    const records = [
      record({ complaintId: "s1", complainantIdentifier: "P15", effectiveDate: "2026-01-05" }),
      record({ complaintId: "s2", complainantIdentifier: "P15", effectiveDate: "2026-02-05" }),
      record({ complaintId: "s3", complainantIdentifier: "P15", effectiveDate: "2026-03-05" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 10);
    expect(directory.people[0]!.recentActivity).toBe(false);
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

describe("buildRepeatComplainantDirectory — minComplaintsPerPerson floor", () => {
  it("defaults the 'repeated person' bar to 2 when the caller doesn't specify one", () => {
    const records = [record({ complaintId: "one", complainantIdentifier: "SOLO" })];
    expect(buildRepeatComplainantDirectory(records, 5).people).toHaveLength(0);
  });

  it("honors an explicit minComplaintsPerPerson of 1 (used internally by the person-detail service to fetch one already-identified person's stats regardless of the repeat threshold)", () => {
    const records = [record({ complaintId: "one", complainantIdentifier: "SOLO" })];
    const directory = buildRepeatComplainantDirectory(records, 5, undefined, { minComplaintsPerPerson: 1 });
    expect(directory.people).toHaveLength(1);
    expect(directory.people[0]!.totalComplaints).toBe(1);
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

describe("buildRepeatComplainantDirectory — person identity across facilities (spec §1/§2/§10)", () => {
  it("treats the same identifier at two facilities as ONE org-level person, not two", () => {
    const records = [
      record({ complaintId: "t1", complainantIdentifier: "MOVER", facility: "سجن أ", region: "منطقة الرياض" }),
      record({ complaintId: "t2", complainantIdentifier: "MOVER", facility: "سجن ب", region: "منطقة مكة المكرمة" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 10);
    expect(directory.people).toHaveLength(1);
    expect(directory.kpis.repeatedPeopleCount).toBe(1);
    const person = directory.people[0]!;
    expect(person.totalComplaints).toBe(2);
    expect(person.facilitiesCount).toBe(2);
    expect(person.facilities.map((f) => f.facility).sort()).toEqual(["سجن أ", "سجن ب"]);
  });

  it("counts a cross-facility repeater independently at EACH facility that itself meets the repeat threshold, without inflating the org-level count", () => {
    const records = [
      record({ complaintId: "u1", complainantIdentifier: "SPLIT", facility: "سجن أ" }),
      record({ complaintId: "u2", complainantIdentifier: "SPLIT", facility: "سجن أ" }),
      record({ complaintId: "u3", complainantIdentifier: "SPLIT", facility: "سجن ب" }),
      record({ complaintId: "u4", complainantIdentifier: "SPLIT", facility: "سجن ب" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 10);
    // Org level: still ONE person, not two.
    expect(directory.people).toHaveLength(1);
    expect(directory.kpis.repeatedPeopleCount).toBe(1);
    expect(directory.people[0]!.totalComplaints).toBe(4);
    // Facility level: repeated (>=2) independently at BOTH facilities.
    const a = directory.facilities.find((f) => f.facility === "سجن أ")!;
    const b = directory.facilities.find((f) => f.facility === "سجن ب")!;
    expect(a.repeatedPeopleCount).toBe(1);
    expect(a.repeatedComplaintsCount).toBe(2);
    expect(b.repeatedPeopleCount).toBe(1);
    expect(b.repeatedComplaintsCount).toBe(2);
  });

  it("org-level repeated person via 1+1 across two facilities is NOT facility-repeated at either (threshold=2)", () => {
    const records = [
      record({ complaintId: "v1", complainantIdentifier: "THIN", facility: "سجن أ" }),
      record({ complaintId: "v2", complainantIdentifier: "THIN", facility: "سجن ب" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 10);
    // Org-level: repeated (2 total complaints).
    expect(directory.kpis.repeatedPeopleCount).toBe(1);
    expect(directory.people[0]!.totalComplaints).toBe(2);
    // Facility-level: repeated at NEITHER facility — no facility row is emitted for either.
    expect(directory.facilities.find((f) => f.facility === "سجن أ")).toBeUndefined();
    expect(directory.facilities.find((f) => f.facility === "سجن ب")).toBeUndefined();
  });

  it("never counts a cross-facility person twice toward the org-level repeatedComplaintsCount total", () => {
    const records = [
      record({ complaintId: "w1", complainantIdentifier: "MOVER2", facility: "سجن أ" }),
      record({ complaintId: "w2", complainantIdentifier: "MOVER2", facility: "سجن ب" }),
      record({ complaintId: "w3", complainantIdentifier: "MOVER2", facility: "سجن ج" }),
    ];
    const directory = buildRepeatComplainantDirectory(records, 10);
    expect(directory.kpis.repeatedComplaintsCount).toBe(3); // not 3x-double-counted across facility rollups
  });
});

describe("buildRepeatComplainantDirectory — full classification distribution (spec §3/§4)", () => {
  it("a 6th+ classification type never disappears from distinctComplaintTypesCount even though topComplaintTypes caps at 5", () => {
    const records = Array.from({ length: 6 }, (_, i) =>
      record({
        complaintId: `type${i}`,
        complainantIdentifier: "MANY_TYPES",
        classificationId: `cls-${i}`,
        classificationLabel: `نوع ${i}`,
      })
    );
    const directory = buildRepeatComplainantDirectory(records, 10);
    const person = directory.people[0]!;
    expect(person.topComplaintTypes).toHaveLength(5); // display cap
    expect(person.distinctComplaintTypesCount).toBe(6); // full distribution, never truncated
  });

  it("org-wide topComplaintType is computed from the full distribution, not from any person's capped top-5", () => {
    // MANY_TYPES has 6 distinct types (1 complaint each); ONE_TYPE has one type repeated 5x.
    // If org topComplaintType were derived from capped top-5 lists only, this would still work
    // by coincidence — the real regression is covered by the region-level test below, which
    // this mirrors for the org aggregate.
    const records = [
      ...Array.from({ length: 6 }, (_, i) =>
        record({ complaintId: `x${i}`, complainantIdentifier: "MANY_TYPES", classificationId: `cls-${i}`, classificationLabel: `نوع ${i}` })
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        record({ complaintId: `y${i}`, complainantIdentifier: "ONE_TYPE", classificationId: "cls-food", classificationLabel: "التغذية" })
      ),
    ];
    const directory = buildRepeatComplainantDirectory(records, 20);
    expect(directory.kpis.topComplaintType?.label).toBe("التغذية");
    expect(directory.kpis.topComplaintType?.count).toBe(5);
  });

  it("regional topComplaintType sums the FULL per-facility distribution, so a type split across facilities' #2 slots can still win region-wide (spec §4 example)", () => {
    const records = [
      // سجن أ: الغذاء 10، الصحة 9 (two people to keep each facility's own top-1 as "الغذاء")
      ...Array.from({ length: 6 }, (_, i) => record({ complaintId: `fa${i}`, complainantIdentifier: "FA1", facility: "سجن أ", classificationId: "cls-food", classificationLabel: "الغذاء" })),
      ...Array.from({ length: 4 }, (_, i) => record({ complaintId: `fb${i}`, complainantIdentifier: "FA2", facility: "سجن أ", classificationId: "cls-food", classificationLabel: "الغذاء" })),
      ...Array.from({ length: 9 }, (_, i) => record({ complaintId: `fc${i}`, complainantIdentifier: "FA3", facility: "سجن أ", classificationId: "cls-health", classificationLabel: "الصحة" })),
      // سجن ب: الزيارة 10، الصحة 9
      ...Array.from({ length: 6 }, (_, i) => record({ complaintId: `fd${i}`, complainantIdentifier: "FB1", facility: "سجن ب", classificationId: "cls-visit", classificationLabel: "الزيارة" })),
      ...Array.from({ length: 4 }, (_, i) => record({ complaintId: `fe${i}`, complainantIdentifier: "FB2", facility: "سجن ب", classificationId: "cls-visit", classificationLabel: "الزيارة" })),
      ...Array.from({ length: 9 }, (_, i) => record({ complaintId: `ff${i}`, complainantIdentifier: "FB3", facility: "سجن ب", classificationId: "cls-health", classificationLabel: "الصحة" })),
    ];
    const directory = buildRepeatComplainantDirectory(records, 100);
    const facilityA = directory.facilities.find((f) => f.facility === "سجن أ")!;
    const facilityB = directory.facilities.find((f) => f.facility === "سجن ب")!;
    expect(facilityA.topComplaintType?.label).toBe("الغذاء");
    expect(facilityB.topComplaintType?.label).toBe("الزيارة");
    // الصحة = 9 + 9 = 18, higher than الغذاء (10) or الزيارة (10) individually — must win at region level.
    const region = directory.regions[0]!;
    expect(region.topComplaintType?.label).toBe("الصحة");
    expect(region.topComplaintType?.count).toBe(18);
  });
});

describe("buildRepeatComplainantDirectory — deterministic latest complainant name (spec §8)", () => {
  it("picks the name from the LATEST effectiveDate, not the last row scanned, regardless of input order", () => {
    const inOrder = [
      record({ complaintId: "name-early", complainantIdentifier: "NAMED", complainantName: "محمد أ", effectiveDate: "2026-01-01" }),
      record({ complaintId: "name-late", complainantIdentifier: "NAMED", complainantName: "محمد أحمد", effectiveDate: "2026-03-01" }),
    ];
    const reversed = [...inOrder].reverse();
    expect(buildRepeatComplainantDirectory(inOrder, 10).people[0]!.complainantName).toBe("محمد أحمد");
    expect(buildRepeatComplainantDirectory(reversed, 10).people[0]!.complainantName).toBe("محمد أحمد");
  });

  it("breaks a same-date name tie deterministically by complaintId, independent of scan order", () => {
    const a = record({ complaintId: "aaa", complainantIdentifier: "TIE", complainantName: "اسم أول", effectiveDate: "2026-01-01" });
    const b = record({ complaintId: "zzz", complainantIdentifier: "TIE", complainantName: "اسم ثاني", effectiveDate: "2026-01-01" });
    const forward = buildRepeatComplainantDirectory([a, b], 10).people[0]!.complainantName;
    const backward = buildRepeatComplainantDirectory([b, a], 10).people[0]!.complainantName;
    expect(forward).toBe(backward); // deterministic regardless of scan order
    expect(forward).toBe("اسم ثاني"); // higher complaintId ("zzz" > "aaa") wins the tie
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
