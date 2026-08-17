import { describe, expect, it } from "vitest";
import {
  isRepeatComplainantSummaryData,
  isRepeatComplainantPeopleData,
  buildRepeatComplainantDrilldownQuery,
} from "./repeat-complainant-api-contract";

const validSummary = {
  kpis: {
    repeatedPeopleCount: 3,
    repeatedComplaintsCount: 8,
    repeatedShareOfPeriodPercent: 20,
    topFacility: { facility: "سجن أ", region: "الرياض", repeatedPeopleCount: 2 },
    topComplaintType: { label: "التغذية", count: 5 },
  },
  regions: [
    {
      region: "الرياض",
      repeatedPeopleCount: 3,
      repeatedComplaintsCount: 8,
      facilitiesAffectedCount: 1,
      topComplaintType: { label: "التغذية", count: 5 },
      drilldownFilters: { region: "الرياض" },
    },
  ],
  facilities: [
    {
      region: "الرياض",
      facility: "سجن أ",
      repeatedPeopleCount: 3,
      repeatedComplaintsCount: 8,
      facilityTotalComplaints: 20,
      repeatRatePercent: 40,
      topComplaintType: { label: "التغذية", count: 5 },
      highestRepeatByOnePerson: 4,
      priorityScore: 55,
      priorityBand: "MEDIUM",
      drilldownFilters: { facility: "سجن أ", region: "الرياض" },
      linkedChronicIssue: true,
      linkedMassComplaint: false,
      linkedHighPriorityFacility: false,
    },
  ],
  conclusions: ["أكثر السجون التي يظهر فيها تكرار الشكاوى هو سجن أ."],
};

const validPeople = {
  people: [
    {
      complainantIdentifierMasked: "*******4821",
      complainantIdentifierRaw: "12345674821",
      region: "الرياض",
      facility: "سجن أ",
      totalComplaints: 3,
      sameTypeRepeatCount: 3,
      distinctComplaintTypesCount: 1,
      topComplaintTypes: [{ classificationId: "cls-1", label: "التغذية", count: 3 }],
      lastComplaintDate: "2026-02-10",
      periodsPresent: 2,
      spansMultiplePeriods: true,
      pattern: "CONCENTRATED",
      complaintIds: ["c1", "c2", "c3"],
      drilldownFilters: { complainantIdentifier: "12345674821", facility: "سجن أ", region: "الرياض" },
    },
  ],
  total: 1,
  page: 1,
  pageSize: 25,
};

describe("isRepeatComplainantSummaryData", () => {
  it("accepts a well-formed summary payload", () => {
    expect(isRepeatComplainantSummaryData(validSummary)).toBe(true);
  });

  it("rejects a payload missing required KPI fields", () => {
    const { kpis, ...rest } = validSummary;
    void kpis;
    expect(isRepeatComplainantSummaryData({ ...rest, kpis: { repeatedPeopleCount: 1 } })).toBe(false);
  });

  it("rejects a payload where a facility row is missing the pattern-signal booleans", () => {
    const broken = {
      ...validSummary,
      facilities: [{ ...validSummary.facilities[0], linkedChronicIssue: undefined }],
    };
    expect(isRepeatComplainantSummaryData(broken)).toBe(false);
  });

  it("rejects an error-shaped payload", () => {
    expect(isRepeatComplainantSummaryData({ error: { code: "X", message: "y" } })).toBe(false);
  });

  it("rejects null/undefined/non-object payloads", () => {
    expect(isRepeatComplainantSummaryData(null)).toBe(false);
    expect(isRepeatComplainantSummaryData(undefined)).toBe(false);
    expect(isRepeatComplainantSummaryData("x")).toBe(false);
  });
});

describe("isRepeatComplainantPeopleData", () => {
  it("accepts a well-formed people page", () => {
    expect(isRepeatComplainantPeopleData(validPeople)).toBe(true);
  });

  it("rejects a person row with an invalid pattern value", () => {
    const broken = {
      ...validPeople,
      people: [{ ...validPeople.people[0], pattern: "SOMETHING_ELSE" }],
    };
    expect(isRepeatComplainantPeopleData(broken)).toBe(false);
  });

  it("rejects a payload with a non-finite total", () => {
    expect(isRepeatComplainantPeopleData({ ...validPeople, total: NaN })).toBe(false);
  });
});

describe("buildRepeatComplainantDrilldownQuery", () => {
  it("builds a query from non-empty filters, skipping null/undefined/empty values", () => {
    const query = buildRepeatComplainantDrilldownQuery(
      { facility: "سجن أ", region: "الرياض", complainantIdentifier: null, classificationId: "" },
      { from: "2026-01-01", to: "2026-02-01" }
    );
    expect(query).toEqual({
      facility: "سجن أ",
      region: "الرياض",
      from: "2026-01-01",
      to: "2026-02-01",
    });
  });

  it("carries the raw complainant identifier when present, for the drillthrough URL only", () => {
    const query = buildRepeatComplainantDrilldownQuery({ complainantIdentifier: "12345674821" });
    expect(query.complainantIdentifier).toBe("12345674821");
  });
});
