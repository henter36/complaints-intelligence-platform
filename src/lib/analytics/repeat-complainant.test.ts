import { describe, expect, it } from "vitest";
import {
  detectMassComplaints,
  detectRepeatComplainants,
  type ComplainantRecord,
} from "./repeat-complainant";

function record(overrides: Partial<ComplainantRecord>): ComplainantRecord {
  return {
    complaintId: "c1",
    complainantIdentifier: "id-1",
    facility: "سجن أ",
    classificationId: "class-1",
    classificationName: "التغذية",
    subject: "شكوى تغذية",
    periodIndex: 0,
    isPotentialDuplicate: false,
    duplicateOfId: null,
    ...overrides,
  };
}

describe("detectRepeatComplainants", () => {
  it("flags the same person repeating the same classification across periods", () => {
    const records: ComplainantRecord[] = [
      record({ complaintId: "c1", periodIndex: 0 }),
      record({ complaintId: "c2", periodIndex: 1 }),
      record({ complaintId: "c3", periodIndex: 2 }),
    ];
    const summaries = detectRepeatComplainants(records, new Map([["سجن أ", 10]]));
    expect(summaries).toHaveLength(1);
    expect(summaries[0].repeatComplainantCount).toBe(1);
    expect(summaries[0].totalRepeatedComplaints).toBe(3);
    expect(summaries[0].maxPeriodsSpanned).toBe(3);
  });

  it("does not count the same person complaining about different classifications as one repeat group", () => {
    const records: ComplainantRecord[] = [
      record({ complaintId: "c1", periodIndex: 0, classificationId: "class-1" }),
      record({ complaintId: "c2", periodIndex: 1, classificationId: "class-2", classificationName: "الاتصال" }),
    ];
    const summaries = detectRepeatComplainants(records, new Map([["سجن أ", 10]]));
    expect(summaries).toHaveLength(0);
  });

  it("does not treat complaints within the same period as a repeat (must span periods)", () => {
    const records: ComplainantRecord[] = [
      record({ complaintId: "c1", periodIndex: 0 }),
      record({ complaintId: "c2", periodIndex: 0 }),
    ];
    const summaries = detectRepeatComplainants(records, new Map([["سجن أ", 10]]));
    expect(summaries).toHaveLength(0);
  });

  it("excludes technical import duplicates from repeat detection", () => {
    const records: ComplainantRecord[] = [
      record({ complaintId: "c1", periodIndex: 0 }),
      record({ complaintId: "c2", periodIndex: 1, isPotentialDuplicate: true }),
      record({ complaintId: "c3", periodIndex: 2, duplicateOfId: "c1" }),
    ];
    const summaries = detectRepeatComplainants(records, new Map([["سجن أ", 10]]));
    expect(summaries).toHaveLength(0);
  });

  it("excludes records missing a complainant identifier (data quality gate)", () => {
    const records: ComplainantRecord[] = [
      record({ complaintId: "c1", periodIndex: 0, complainantIdentifier: null }),
      record({ complaintId: "c2", periodIndex: 1, complainantIdentifier: "" }),
    ];
    const summaries = detectRepeatComplainants(records, new Map([["سجن أ", 10]]));
    expect(summaries).toHaveLength(0);
  });

  it("groups by normalized subject text when classification is missing", () => {
    const records: ComplainantRecord[] = [
      record({ complaintId: "c1", periodIndex: 0, classificationId: null, subject: "تأخر الإفراج" }),
      record({ complaintId: "c2", periodIndex: 1, classificationId: null, subject: "  تأخر الإفراج  " }),
    ];
    const summaries = detectRepeatComplainants(records, new Map([["سجن أ", 10]]));
    expect(summaries).toHaveLength(1);
    expect(summaries[0].totalRepeatedComplaints).toBe(2);
  });

  it("applies Arabic normalization (alef/ya/ta-marbuta variants) when matching subjects", () => {
    const records: ComplainantRecord[] = [
      record({ complaintId: "c1", periodIndex: 0, classificationId: null, subject: "إجراءات الزياره" }),
      record({ complaintId: "c2", periodIndex: 1, classificationId: null, subject: "اجراءات الزيارة" }),
    ];
    const summaries = detectRepeatComplainants(records, new Map([["سجن أ", 10]]));
    expect(summaries).toHaveLength(1);
    expect(summaries[0].totalRepeatedComplaints).toBe(2);
  });
});

describe("detectMassComplaints", () => {
  it("distinguishes many distinct complainants (mass complaint) from one repeating person", () => {
    const records: ComplainantRecord[] = Array.from({ length: 6 }, (_, i) =>
      record({ complaintId: `c${i}`, complainantIdentifier: `id-${i}`, periodIndex: 0 })
    );
    const results = detectMassComplaints(records);
    expect(results).toHaveLength(1);
    expect(results[0].distinctComplainants).toBe(6);
  });

  it("does not flag a single repeating complainant as a mass complaint", () => {
    const records: ComplainantRecord[] = [
      record({ complaintId: "c1", periodIndex: 0 }),
      record({ complaintId: "c2", periodIndex: 1 }),
      record({ complaintId: "c3", periodIndex: 2 }),
    ];
    const results = detectMassComplaints(records);
    expect(results).toHaveLength(0);
  });
});
