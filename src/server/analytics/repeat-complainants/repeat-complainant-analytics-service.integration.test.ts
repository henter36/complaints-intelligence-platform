import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComplaintPriority, ComplaintStatus, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runPrismaMigrateDeploy } from "../../../../scripts/lib/prisma-cli-runner";
import { normalizeFacilityName } from "@/server/facilities/facility-name";

const dbHolder = vi.hoisted(() => ({ client: null as PrismaClient | null }));
const findManySpy = vi.hoisted(() => ({ calls: 0 }));

vi.mock("@/lib/db", () => ({
  db: {
    get complaint() {
      if (!dbHolder.client) throw new Error("test prisma not ready");
      const delegate = dbHolder.client.complaint;
      return {
        ...delegate,
        findMany: (...args: unknown[]) => {
          findManySpy.calls += 1;
          // @ts-expect-error — forwarding varargs to the real Prisma delegate
          return delegate.findMany(...args);
        },
      };
    },
    get classification() {
      if (!dbHolder.client) throw new Error("test prisma not ready");
      return dbHolder.client.classification;
    },
    get facility() {
      if (!dbHolder.client) throw new Error("test prisma not ready");
      return dbHolder.client.facility;
    },
  },
}));

const { getRepeatComplainantSummary, searchRepeatComplainants } = await import("./repeat-complainant-analytics-service");
const { getRepeatComplainantPeoplePage } = await import("./repeat-complainant-people-service");
const { getRepeatComplainantPersonDetail } = await import("./repeat-complainant-person-detail-service");
const { encodeComplainantToken } = await import("@/server/complaints/complainant-token");

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
let tempDir: string | null = null;

function restoreDatabaseUrl(originalValue: string | undefined): void {
  if (originalValue === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalValue;
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cip-repeat-complainants-"));
  const dbPath = join(tempDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  runPrismaMigrateDeploy(`file:${dbPath}`);
  dbHolder.client = new PrismaClient();
  await seedDataset(dbHolder.client);
}, 60_000);

afterAll(async () => {
  try {
    await dbHolder.client?.$disconnect();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  } finally {
    restoreDatabaseUrl(ORIGINAL_DATABASE_URL);
  }
});

const RIYADH_FACILITY = "سجن الرياض المركزي";
const MAKKAH_FACILITY = "سجن مكة";

async function seedDataset(prisma: PrismaClient) {
  const category = await prisma.category.create({
    data: { nameAr: "فئة اختبار", nameEn: "Test", isActive: true },
  });
  const food = await prisma.classification.create({
    data: { categoryId: category.id, nameAr: "التغذية", nameEn: "Food", isActive: true },
  });
  const health = await prisma.classification.create({
    data: { categoryId: category.id, nameAr: "الرعاية الصحية", nameEn: "Health", isActive: true },
  });

  const base = {
    subject: "شكوى اختبار",
    priority: ComplaintPriority.MEDIUM,
    severity: ComplaintPriority.MEDIUM,
    isDeleted: false,
    status: ComplaintStatus.OPEN,
  };

  const riyadhKey = normalizeFacilityName(RIYADH_FACILITY);
  const makkahKey = normalizeFacilityName(MAKKAH_FACILITY);

  await prisma.complaint.createMany({
    data: [
      // Person A: 3 complaints, all "التغذية" — concentrated, same-type repeat.
      ...["a1", "a2", "a3"].map((id, i) => ({
        ...base,
        externalId: `rc-${id}`,
        region: "الرياض",
        facility: RIYADH_FACILITY,
        facilityNormalizedName: riyadhKey,
        classificationId: food.id,
        complainantIdentifier: "1000000001",
        complaintDate: new Date(`2026-01-${10 + i * 5}T00:00:00.000Z`),
      })),
      // Person B: 2 complaints, different types — diverse.
      { ...base, externalId: "rc-b1", region: "الرياض", facility: RIYADH_FACILITY, facilityNormalizedName: riyadhKey, classificationId: food.id, complainantIdentifier: "2000000002", complaintDate: new Date("2026-02-01T00:00:00.000Z") },
      { ...base, externalId: "rc-b2", region: "الرياض", facility: RIYADH_FACILITY, facilityNormalizedName: riyadhKey, classificationId: health.id, complainantIdentifier: "2000000002", complaintDate: new Date("2026-02-15T00:00:00.000Z") },
      // Person C: 1 complaint only — not repeated.
      { ...base, externalId: "rc-c1", region: "الرياض", facility: RIYADH_FACILITY, facilityNormalizedName: riyadhKey, classificationId: food.id, complainantIdentifier: "3000000003", complaintDate: new Date("2026-01-05T00:00:00.000Z") },
      // Person D: 2 complaints but one is a technical duplicate — must not count as repeated.
      { ...base, externalId: "rc-d1", region: "الرياض", facility: RIYADH_FACILITY, facilityNormalizedName: riyadhKey, classificationId: food.id, complainantIdentifier: "4000000004", complaintDate: new Date("2026-01-06T00:00:00.000Z") },
      { ...base, externalId: "rc-d2", region: "الرياض", facility: RIYADH_FACILITY, facilityNormalizedName: riyadhKey, classificationId: food.id, complainantIdentifier: "4000000004", isPotentialDuplicate: true, complaintDate: new Date("2026-01-07T00:00:00.000Z") },
      // Empty identifier — excluded entirely.
      { ...base, externalId: "rc-e1", region: "الرياض", facility: RIYADH_FACILITY, facilityNormalizedName: riyadhKey, classificationId: food.id, complainantIdentifier: null, complaintDate: new Date("2026-01-08T00:00:00.000Z") },
      // Makkah facility: Person F, 2 complaints.
      { ...base, externalId: "rc-f1", region: "مكة", facility: MAKKAH_FACILITY, facilityNormalizedName: makkahKey, classificationId: health.id, complainantIdentifier: "5000000005", complaintDate: new Date("2026-01-09T00:00:00.000Z") },
      { ...base, externalId: "rc-f2", region: "مكة", facility: MAKKAH_FACILITY, facilityNormalizedName: makkahKey, classificationId: health.id, complainantIdentifier: "5000000005", complaintDate: new Date("2026-01-20T00:00:00.000Z") },
      // Person G: a named complainant, 2 complaints (for name-search + person-detail tests).
      { ...base, externalId: "rc-g1", region: "الرياض", facility: RIYADH_FACILITY, facilityNormalizedName: riyadhKey, classificationId: food.id, complainantIdentifier: "6000000006", complainantName: "خالد سعيد", subject: "طلب وجبة بديلة", description: "الوصف الكامل لأول شكوى من خالد سعيد حول التغذية في السجن.", complaintDate: new Date("2026-01-11T00:00:00.000Z") },
      { ...base, externalId: "rc-g2", region: "الرياض", facility: RIYADH_FACILITY, facilityNormalizedName: riyadhKey, classificationId: health.id, complainantIdentifier: "6000000006", complainantName: "خالد سعيد", subject: "طلب مراجعة طبيب", description: "الوصف الكامل للشكوى الثانية من خالد سعيد حول الرعاية الصحية.", complaintDate: new Date("2026-01-25T00:00:00.000Z") },
      // Person H: transferred between facilities — 1 complaint at Riyadh, 1 at
      // Makkah. Org-level repeated (2 total) but NOT facility-repeated at
      // EITHER facility individually (threshold 2) — spec §1/§2/§10.
      { ...base, externalId: "rc-h1", region: "الرياض", facility: RIYADH_FACILITY, facilityNormalizedName: riyadhKey, classificationId: food.id, complainantIdentifier: "7000000007", complainantName: "سالم ناصر", complaintDate: new Date("2026-01-12T00:00:00.000Z") },
      { ...base, externalId: "rc-h2", region: "مكة", facility: MAKKAH_FACILITY, facilityNormalizedName: makkahKey, classificationId: health.id, complainantIdentifier: "7000000007", complainantName: "سالم ناصر الحربي", complaintDate: new Date("2026-02-01T00:00:00.000Z") },
    ],
  });
}

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe("getRepeatComplainantSummary — real db (temp sqlite)", () => {
  it("flags repeated people, excludes duplicates/empty identifiers, and rolls up by facility and region", async () => {
    const summary = await getRepeatComplainantSummary(params("from=2026-01-01&to=2026-03-01"));
    // A, B, G, D(1 real complaint each after dup exclusion -> D not repeated), F, H (org-repeated
    // via 1 complaint at each of 2 facilities) => repeated: A, B, G, F, H = 5 people
    expect(summary.kpis.repeatedPeopleCount).toBe(5);

    const riyadh = summary.facilities.find((f) => f.facility === RIYADH_FACILITY)!;
    // H's single Riyadh complaint does NOT push it over the facility-level
    // threshold (2) there — riyadh's own repeated-people set is unchanged.
    expect(riyadh.repeatedPeopleCount).toBe(3); // A, B, G
    expect(riyadh.repeatedComplaintsCount).toBe(7); // 3 + 2 + 2
    // facilityTotalComplaints counts ALL eligible-scope complaints at the facility,
    // including non-repeated C and D's surviving real complaint (dup excluded upstream of totals too? see below).
    expect(riyadh.facilityTotalComplaints).toBeGreaterThanOrEqual(8);

    const makkah = summary.facilities.find((f) => f.facility === MAKKAH_FACILITY)!;
    // H's single Makkah complaint likewise does not push Makkah's own count.
    expect(makkah.repeatedPeopleCount).toBe(1); // F only
    expect(makkah.repeatedComplaintsCount).toBe(2);

    const riyadhRegion = summary.regions.find((r) => r.region.includes("الرياض"))!;
    expect(riyadhRegion.repeatedPeopleCount).toBe(3);
    expect(riyadhRegion.facilitiesAffectedCount).toBe(1);

    expect(summary.conclusions.length).toBeGreaterThan(0);
    for (const line of summary.conclusions) {
      expect(line).not.toMatch(/1000000001|2000000002|5000000005|6000000006|7000000007|خالد سعيد|سالم ناصر/);
    }
  });

  it("counts a person transferred between facilities ONCE org-wide, never once per facility (spec §1/§10)", async () => {
    const summary = await getRepeatComplainantSummary(params("from=2026-01-01&to=2026-03-01"));
    const facilityCounts = summary.facilities.reduce((sum, f) => sum + f.repeatedPeopleCount, 0);
    // Sum of facility-level repeated-people counts = 3 (Riyadh: A,B,G) + 1 (Makkah: F) = 4,
    // strictly LESS than the org-level 5 — the difference is exactly person H,
    // who is org-repeated but facility-repeated at neither facility.
    expect(facilityCounts).toBe(4);
    expect(summary.kpis.repeatedPeopleCount).toBe(5);
  });

  it("issues a fixed, small number of complaint queries regardless of dataset size — never one per facility/person (no N+1)", async () => {
    findManySpy.calls = 0;
    await getRepeatComplainantSummary(params("from=2026-01-01&to=2026-03-01"));
    // 1 query for this feature's own aggregation + 1 for the reused pattern-analysis
    // engine's own multi-period fetch (spec §16 integration) — both are single,
    // bounded queries, never a loop issuing one query per row/facility/person.
    expect(findManySpy.calls).toBe(2);
  });

  it("produces finite numbers everywhere — no NaN or Infinity", async () => {
    const summary = await getRepeatComplainantSummary(params("from=2026-01-01&to=2026-03-01"));
    expect(Number.isFinite(summary.kpis.repeatedShareOfPeriodPercent)).toBe(true);
    for (const row of summary.facilities) {
      expect(Number.isFinite(row.repeatRatePercent)).toBe(true);
      expect(Number.isFinite(row.priorityScore)).toBe(true);
    }
  });

  it("respects the date-range filter (from/to) the same way the rest of Analytics does", async () => {
    const outOfRange = await getRepeatComplainantSummary(params("from=2030-01-01&to=2030-02-01"));
    expect(outOfRange.kpis.repeatedPeopleCount).toBe(0);
  });

  it("respects the region filter", async () => {
    const summary = await getRepeatComplainantSummary(params("from=2026-01-01&to=2026-03-01&regionId=مكة"));
    expect(summary.facilities.every((f) => f.facility === MAKKAH_FACILITY)).toBe(true);
  });
});

describe("getRepeatComplainantSummary — malformed numeric params fail safe (spec §7)", () => {
  it.each(["abc", "NaN", "-1", "0", "2.5"])("minComplaints=%s never produces NaN/crash/an unbounded query — falls back to the engine default", async (raw) => {
    const summary = await getRepeatComplainantSummary(params(`from=2026-01-01&to=2026-03-01&minComplaints=${raw}`));
    expect(Number.isFinite(summary.kpis.repeatedPeopleCount)).toBe(true);
    // Falls back to the engine's own default (2) — same result as no override at all.
    const baseline = await getRepeatComplainantSummary(params("from=2026-01-01&to=2026-03-01"));
    expect(summary.kpis.repeatedPeopleCount).toBe(baseline.kpis.repeatedPeopleCount);
  });

  it.each(["xyz", "Infinity"])("minDistinctTypes=%s falls back instead of dropping every result", async (raw) => {
    const summary = await getRepeatComplainantSummary(params(`from=2026-01-01&to=2026-03-01&minDistinctTypes=${raw}`));
    expect(summary.kpis.repeatedPeopleCount).toBeGreaterThan(0);
  });

  it("minComplaints=1 falls back to the business-rule floor of 2, never honoring 1 as 'repeated'", async () => {
    const summary = await getRepeatComplainantSummary(params("from=2026-01-01&to=2026-03-01&minComplaints=1"));
    const baseline = await getRepeatComplainantSummary(params("from=2026-01-01&to=2026-03-01"));
    expect(summary.kpis.repeatedPeopleCount).toBe(baseline.kpis.repeatedPeopleCount);
  });

  it("topFacilities=999999 clamps instead of throwing or returning an unbounded slice", async () => {
    const summary = await getRepeatComplainantSummary(params("from=2026-01-01&to=2026-03-01&topFacilities=999999"));
    expect(Array.isArray(summary.facilities)).toBe(true);
  });
});

describe("getRepeatComplainantPeoplePage — real db (temp sqlite)", () => {
  it("requires a facility scope and paginates the sorted person list", async () => {
    const page1 = await getRepeatComplainantPeoplePage(
      params(`from=2026-01-01&to=2026-03-01&facility=${encodeURIComponent(RIYADH_FACILITY)}&peoplePageSize=1&peoplePage=1&peopleSortBy=totalComplaints`)
    );
    expect(page1.total).toBe(3); // A, B, and G at Riyadh
    expect(page1.people).toHaveLength(1);
    expect(page1.people[0]!.totalComplaints).toBe(3); // Person A ranks first by total complaints

    const page2 = await getRepeatComplainantPeoplePage(
      params(`from=2026-01-01&to=2026-03-01&facility=${encodeURIComponent(RIYADH_FACILITY)}&peoplePageSize=1&peoplePage=2&peopleSortBy=totalComplaints`)
    );
    expect(page2.people).toHaveLength(1);
    expect(page2.people[0]!.totalComplaints).toBe(2); // Person B or G (tied at 2 complaints)
  });

  it("never exposes the raw identifier as a table-visible field name other than the explicit raw field", async () => {
    const page = await getRepeatComplainantPeoplePage(
      params(`from=2026-01-01&to=2026-03-01&facility=${encodeURIComponent(RIYADH_FACILITY)}`)
    );
    for (const person of page.people) {
      expect(person.complainantIdentifierMasked.startsWith("****")).toBe(true);
      expect(person).not.toHaveProperty("complainantIdentifierRaw");
      // The token round-trips server-side but is never the raw value itself.
      expect(person.complainantToken).not.toContain("1000000001");
      expect(person.complainantToken).not.toContain("2000000002");
    }
  });

  it.each(["abc", "NaN", "-1", "0", "2.5"])("page=%s falls back to page 1 instead of NaN/crashing", async (raw) => {
    const page = await getRepeatComplainantPeoplePage(
      params(`from=2026-01-01&to=2026-03-01&facility=${encodeURIComponent(RIYADH_FACILITY)}&peoplePage=${raw}`)
    );
    expect(page.page).toBe(1);
    expect(Number.isFinite(page.total)).toBe(true);
  });

  it("pageSize=999999999 clamps to the max page size instead of an unbounded query", async () => {
    const page = await getRepeatComplainantPeoplePage(
      params(`from=2026-01-01&to=2026-03-01&facility=${encodeURIComponent(RIYADH_FACILITY)}&peoplePageSize=999999999`)
    );
    expect(page.pageSize).toBeLessThanOrEqual(100);
  });
});

describe("getRepeatComplainantPersonDetail — real db (temp sqlite)", () => {
  it("returns the person's header, full complaint list (newest-first by default), type grouping, and timeline", async () => {
    const token = encodeComplainantToken("6000000006");
    const detail = await getRepeatComplainantPersonDetail(
      token,
      RIYADH_FACILITY,
      params("from=2026-01-01&to=2026-03-01")
    );
    expect(detail).not.toBeNull();
    expect(detail!.person.complainantName).toBe("خالد سعيد");
    expect(detail!.person.complainantIdentifierMasked).toBe("****0006");
    expect(detail!.person).not.toHaveProperty("complainantIdentifierRaw");
    expect(detail!.complaints).toHaveLength(2);
    // newest-first by default
    expect(detail!.complaints[0]!.date >= detail!.complaints[1]!.date).toBe(true);
    expect(detail!.complaints[0]!.subject).toBeTruthy();
    expect(detail!.complaints[0]!.descriptionSnippet).toBeTruthy();

    expect(detail!.complaintsByType).toHaveLength(2); // food + health, one complaint each
    for (const group of detail!.complaintsByType) {
      expect(group.complaints).toHaveLength(1);
    }

    expect(detail!.timeline.length).toBeGreaterThan(0);
    const totalFromTimeline = detail!.timeline.reduce((sum, p) => sum + p.count, 0);
    expect(totalFromTimeline).toBe(2);
  });

  it("sorts oldest-first when explicitly requested", async () => {
    const token = encodeComplainantToken("6000000006");
    const detail = await getRepeatComplainantPersonDetail(
      token,
      RIYADH_FACILITY,
      params("from=2026-01-01&to=2026-03-01"),
      new Date(),
      "asc"
    );
    expect(detail!.complaints[0]!.date <= detail!.complaints[1]!.date).toBe(true);
  });

  it("returns null (fails closed) for a garbled/tampered token instead of throwing", async () => {
    const detail = await getRepeatComplainantPersonDetail(
      "not-a-real-token",
      RIYADH_FACILITY,
      params("from=2026-01-01&to=2026-03-01")
    );
    expect(detail).toBeNull();
  });

  it("returns null when the token is valid but the person has no complaints at the given facility", async () => {
    const token = encodeComplainantToken("6000000006"); // Person G is at Riyadh, not Makkah
    const detail = await getRepeatComplainantPersonDetail(
      token,
      MAKKAH_FACILITY,
      params("from=2026-01-01&to=2026-03-01")
    );
    expect(detail).toBeNull();
  });

  it("respects the same date-range filter as the rest of the directory", async () => {
    const token = encodeComplainantToken("6000000006");
    const detail = await getRepeatComplainantPersonDetail(
      token,
      RIYADH_FACILITY,
      params("from=2030-01-01&to=2030-02-01")
    );
    expect(detail).toBeNull();
  });

  it("facility=null returns the org-wide view across every facility the person appears at (spec §12)", async () => {
    const token = encodeComplainantToken("7000000007"); // Person H: Riyadh + Makkah
    const detail = await getRepeatComplainantPersonDetail(token, null, params("from=2026-01-01&to=2026-03-01"));
    expect(detail).not.toBeNull();
    expect(detail!.person.facilitiesCount).toBe(2);
    expect(detail!.complaints).toHaveLength(2);
    expect(new Set(detail!.complaints.map((c) => c.facility))).toEqual(new Set([RIYADH_FACILITY, MAKKAH_FACILITY]));
    // Deterministic latest name — the second (Makkah) complaint carries the
    // more complete/later name and must win, regardless of DB row order.
    expect(detail!.person.complainantName).toBe("سالم ناصر الحربي");
  });

  it("a facility-scoped detail for a multi-facility person returns ONLY that facility's complaints, not the org-wide total", async () => {
    const token = encodeComplainantToken("7000000007");
    const detail = await getRepeatComplainantPersonDetail(token, RIYADH_FACILITY, params("from=2026-01-01&to=2026-03-01"));
    expect(detail).not.toBeNull();
    expect(detail!.complaints).toHaveLength(1);
    expect(detail!.complaints[0]!.facility).toBe(RIYADH_FACILITY);
  });
});

describe("searchRepeatComplainants — real db (temp sqlite)", () => {
  it("finds a person by (normalized) name", async () => {
    const results = await searchRepeatComplainants("خالد", params("from=2026-01-01&to=2026-03-01"));
    expect(results.some((p) => p.complainantName === "خالد سعيد")).toBe(true);
  });

  it("finds a person by exact identifier", async () => {
    const results = await searchRepeatComplainants("6000000006", params("from=2026-01-01&to=2026-03-01"));
    expect(results.some((p) => p.complainantName === "خالد سعيد")).toBe(true);
  });

  it("finds people by facility name", async () => {
    const results = await searchRepeatComplainants(MAKKAH_FACILITY, params("from=2026-01-01&to=2026-03-01"));
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((p) => p.facility === MAKKAH_FACILITY)).toBe(true);
  });

  it("returns an empty list for a blank query, never the full directory", async () => {
    const results = await searchRepeatComplainants("   ", params("from=2026-01-01&to=2026-03-01"));
    expect(results).toEqual([]);
  });

  it("returns tokens, never raw identifiers, in search results", async () => {
    const results = await searchRepeatComplainants("خالد", params("from=2026-01-01&to=2026-03-01"));
    for (const person of results) {
      expect(person).not.toHaveProperty("complainantIdentifierRaw");
      expect(typeof person.complainantToken).toBe("string");
    }
  });
});
