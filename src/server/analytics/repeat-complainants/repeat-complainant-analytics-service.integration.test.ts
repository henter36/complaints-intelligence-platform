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

const { getRepeatComplainantSummary } = await import("./repeat-complainant-analytics-service");
const { getRepeatComplainantPeoplePage } = await import("./repeat-complainant-people-service");

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
    ],
  });
}

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe("getRepeatComplainantSummary — real db (temp sqlite)", () => {
  it("flags repeated people, excludes duplicates/empty identifiers, and rolls up by facility and region", async () => {
    const summary = await getRepeatComplainantSummary(params("from=2026-01-01&to=2026-03-01"));
    // A, B, D(1 real complaint each after dup exclusion -> D not repeated), F => repeated: A, B, F = 3 people
    expect(summary.kpis.repeatedPeopleCount).toBe(3);

    const riyadh = summary.facilities.find((f) => f.facility === RIYADH_FACILITY)!;
    expect(riyadh.repeatedPeopleCount).toBe(2); // A and B
    expect(riyadh.repeatedComplaintsCount).toBe(5); // 3 + 2
    // facilityTotalComplaints counts ALL eligible-scope complaints at the facility,
    // including non-repeated C and D's surviving real complaint (dup excluded upstream of totals too? see below).
    expect(riyadh.facilityTotalComplaints).toBeGreaterThanOrEqual(6);

    const makkah = summary.facilities.find((f) => f.facility === MAKKAH_FACILITY)!;
    expect(makkah.repeatedPeopleCount).toBe(1);
    expect(makkah.repeatedComplaintsCount).toBe(2);

    const riyadhRegion = summary.regions.find((r) => r.region.includes("الرياض"))!;
    expect(riyadhRegion.repeatedPeopleCount).toBe(2);
    expect(riyadhRegion.facilitiesAffectedCount).toBe(1);

    expect(summary.conclusions.length).toBeGreaterThan(0);
    for (const line of summary.conclusions) {
      expect(line).not.toMatch(/1000000001|2000000002|5000000005/);
    }
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

describe("getRepeatComplainantPeoplePage — real db (temp sqlite)", () => {
  it("requires a facility scope and paginates the sorted person list", async () => {
    const page1 = await getRepeatComplainantPeoplePage(
      params(`from=2026-01-01&to=2026-03-01&facility=${encodeURIComponent(RIYADH_FACILITY)}&pageSize=1&page=1&peopleSortBy=totalComplaints`)
    );
    expect(page1.total).toBe(2); // A and B at Riyadh
    expect(page1.people).toHaveLength(1);
    expect(page1.people[0]!.totalComplaints).toBe(3); // Person A ranks first by total complaints

    const page2 = await getRepeatComplainantPeoplePage(
      params(`from=2026-01-01&to=2026-03-01&facility=${encodeURIComponent(RIYADH_FACILITY)}&pageSize=1&page=2&peopleSortBy=totalComplaints`)
    );
    expect(page2.people).toHaveLength(1);
    expect(page2.people[0]!.totalComplaints).toBe(2); // Person B
  });

  it("never exposes the raw identifier as a table-visible field name other than the explicit raw field", async () => {
    const page = await getRepeatComplainantPeoplePage(
      params(`from=2026-01-01&to=2026-03-01&facility=${encodeURIComponent(RIYADH_FACILITY)}`)
    );
    for (const person of page.people) {
      expect(person.complainantIdentifierMasked).not.toBe(person.complainantIdentifierRaw);
      expect(person.complainantIdentifierMasked.startsWith("*")).toBe(true);
    }
  });
});
