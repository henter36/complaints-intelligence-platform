import { describe, expect, it } from "vitest";
import {
  isRepeatComplainantSummaryData,
  isRepeatComplainantPeopleData,
  isRepeatComplainantSearchData,
  isRepeatComplainantPersonDetail,
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

const validPerson = {
  complainantIdentifierMasked: "*******4821",
  complainantToken: "opaque-token-value",
  complainantName: "محمد أحمد",
  region: "الرياض",
  facility: "سجن أ",
  facilitiesCount: 1,
  facilities: [{ region: "الرياض", facility: "سجن أ", complaintsCount: 3 }],
  totalComplaints: 3,
  sameTypeRepeatCount: 3,
  distinctComplaintTypesCount: 1,
  topComplaintTypes: [{ classificationId: "cls-1", label: "التغذية", count: 3 }],
  firstComplaintDate: "2026-01-05",
  lastComplaintDate: "2026-02-10",
  periodsPresent: 2,
  spansMultiplePeriods: true,
  recentActivity: false,
  pattern: "CONCENTRATED",
  complaintIds: ["c1", "c2", "c3"],
  drilldownFilters: { facility: "سجن أ", region: "الرياض" },
};

const validPeople = {
  people: [validPerson],
  total: 1,
  page: 1,
  pageSize: 25,
};

const validComplaint = {
  complaintId: "c1",
  complaintNumber: "v1",
  date: "2026-02-10",
  region: "الرياض",
  facility: "سجن أ",
  classificationId: "cls-1",
  classificationLabel: "التغذية",
  subject: "شكوى غذائية",
  descriptionSnippet: null,
  status: "OPEN",
  monthKey: "2026-02",
};

const validPersonDetail = {
  person: validPerson,
  complaints: [validComplaint],
  complaintsByType: [{ classificationId: "cls-1", label: "التغذية", complaints: [validComplaint] }],
  timeline: [{ monthKey: "2026-02", monthLabel: "فبراير 2026", count: 3 }],
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

  it("rejects a person row still shaped with the old raw-identifier field instead of a token", () => {
    const { complainantToken, ...withoutToken } = validPeople.people[0]!;
    void complainantToken;
    const broken = { ...validPeople, people: [{ ...withoutToken, complainantIdentifierRaw: "12345674821" }] };
    expect(isRepeatComplainantPeopleData(broken)).toBe(false);
  });

  it("accepts a person row whose name is null (never fabricated when the source lacks one)", () => {
    const withNullName = { ...validPeople, people: [{ ...validPeople.people[0], complainantName: null }] };
    expect(isRepeatComplainantPeopleData(withNullName)).toBe(true);
  });

  it("rejects a payload with a non-finite total", () => {
    expect(isRepeatComplainantPeopleData({ ...validPeople, total: NaN })).toBe(false);
  });

  it("accepts a person who appears at multiple facilities, with a full facilities[] breakdown", () => {
    const multiFacility = {
      ...validPeople,
      people: [
        {
          ...validPeople.people[0],
          facilitiesCount: 2,
          facilities: [
            { region: "الرياض", facility: "سجن أ", complaintsCount: 2 },
            { region: "مكة المكرمة", facility: "سجن ب", complaintsCount: 1 },
          ],
        },
      ],
    };
    expect(isRepeatComplainantPeopleData(multiFacility)).toBe(true);
  });

  it("rejects a person row missing the facilities breakdown", () => {
    const { facilities, ...withoutFacilities } = validPeople.people[0]!;
    void facilities;
    expect(isRepeatComplainantPeopleData({ ...validPeople, people: [withoutFacilities] })).toBe(false);
  });
});

describe("isRepeatComplainantSearchData", () => {
  it("accepts a well-formed { people } search payload", () => {
    expect(isRepeatComplainantSearchData({ people: [validPerson] })).toBe(true);
  });

  it("rejects a bare array (the route always wraps results in { people })", () => {
    expect(isRepeatComplainantSearchData([validPerson])).toBe(false);
  });

  it("rejects a payload with a malformed person row", () => {
    expect(isRepeatComplainantSearchData({ people: [{ ...validPerson, totalComplaints: "3" }] })).toBe(false);
  });
});

describe("isRepeatComplainantPersonDetail", () => {
  it("accepts a well-formed person detail payload", () => {
    expect(isRepeatComplainantPersonDetail(validPersonDetail)).toBe(true);
  });

  it("rejects a payload missing the timeline", () => {
    const { timeline, ...rest } = validPersonDetail;
    void timeline;
    expect(isRepeatComplainantPersonDetail(rest)).toBe(false);
  });

  it("rejects a payload whose person row is malformed", () => {
    expect(isRepeatComplainantPersonDetail({ ...validPersonDetail, person: { region: "الرياض" } })).toBe(false);
  });
});

describe("buildRepeatComplainantDrilldownQuery", () => {
  it("builds a query from non-empty filters, skipping null/undefined/empty values", () => {
    const query = buildRepeatComplainantDrilldownQuery(
      { facility: "سجن أ", region: "الرياض", complainantToken: null, classificationId: "" },
      { from: "2026-01-01", to: "2026-02-01" }
    );
    expect(query).toEqual({
      facility: "سجن أ",
      region: "الرياض",
      from: "2026-01-01",
      to: "2026-02-01",
    });
  });

  it("carries the opaque complainant token when present, never a raw identifier, for the drillthrough URL", () => {
    const query = buildRepeatComplainantDrilldownQuery({ complainantToken: "opaque-token-value" });
    expect(query.complainantToken).toBe("opaque-token-value");
  });
});
