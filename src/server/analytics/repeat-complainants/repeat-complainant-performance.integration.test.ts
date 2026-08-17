import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComplaintPriority, ComplaintStatus, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runPrismaMigrateDeploy } from "../../../../scripts/lib/prisma-cli-runner";
import { normalizeFacilityName } from "@/server/facilities/facility-name";

/**
 * Realistic-scale dataset (spec: "Dataset كبير واقعي", "لا تنفذ N+1 queries",
 * "سلامة الأداء على بيانات كبيرة") — ~4,000 complaints across 15 facilities
 * and ~1,300 distinct complainants, exercised against a real (temp) sqlite
 * database, not a mocked in-memory array, so the actual query + in-memory
 * aggregation cost is what gets measured.
 */

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

const FACILITY_COUNT = 15;
const COMPLAINT_COUNT = 4000;
const REGIONS = ["الرياض", "مكة المكرمة", "المدينة المنورة", "الشرقية", "عسير"];

function facilityName(i: number): string {
  return `سجن رقم ${i}`;
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cip-repeat-complainants-perf-"));
  const dbPath = join(tempDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  runPrismaMigrateDeploy(`file:${dbPath}`);
  dbHolder.client = new PrismaClient();
  await seedLargeDataset(dbHolder.client);
}, 90_000);

afterAll(async () => {
  try {
    await dbHolder.client?.$disconnect();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  } finally {
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  }
});

async function seedLargeDataset(prisma: PrismaClient) {
  const category = await prisma.category.create({
    data: { nameAr: "فئة أداء", nameEn: "Perf", isActive: true },
  });
  const classifications = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      prisma.classification.create({
        data: { categoryId: category.id, nameAr: `تصنيف ${i}`, nameEn: `Type ${i}`, isActive: true },
      })
    )
  );

  const base = {
    subject: "شكوى اختبار أداء",
    priority: ComplaintPriority.MEDIUM,
    severity: ComplaintPriority.MEDIUM,
    isDeleted: false,
    status: ComplaintStatus.OPEN,
  };

  const rows = Array.from({ length: COMPLAINT_COUNT }, (_, i) => {
    // ~3 complaints per person on average -> a large share of genuinely
    // repeated people. Facility is derived from the PERSON, not the row
    // index, so a person's repeat complaints always land at the same
    // facility (otherwise no single facility would ever see >= 2 of them).
    const personIndex = Math.floor(i / 3);
    const facilityIndex = personIndex % FACILITY_COUNT;
    const facility = facilityName(facilityIndex);
    return {
      ...base,
      externalId: `perf-${i}`,
      region: REGIONS[facilityIndex % REGIONS.length],
      facility,
      facilityNormalizedName: normalizeFacilityName(facility),
      classificationId: classifications[i % classifications.length]!.id,
      complainantIdentifier: `PERF-${personIndex}`,
      complaintDate: new Date(Date.UTC(2026, i % 3, 1 + (i % 27))),
    };
  });

  // Batch inserts to stay comfortably under sqlite's bound-variable limits.
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    await prisma.complaint.createMany({ data: rows.slice(i, i + BATCH) });
  }
}

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe("repeat-complainant analytics — realistic-scale performance (spec)", () => {
  it("aggregates ~4,000 complaints within a reasonable time budget, with a fixed (non-N+1) query count", async () => {
    findManySpy.calls = 0;
    const start = performance.now();
    const summary = await getRepeatComplainantSummary(params("from=2026-01-01&to=2026-03-31"));
    const elapsedMs = performance.now() - start;

    expect(summary.kpis.repeatedPeopleCount).toBeGreaterThan(0);
    expect(summary.facilities.length).toBeLessThanOrEqual(FACILITY_COUNT);
    // Fixed number of complaint queries regardless of row count — never a
    // per-facility or per-person loop.
    expect(findManySpy.calls).toBe(2);
    expect(elapsedMs).toBeLessThan(8000);

    for (const row of summary.facilities) {
      expect(Number.isFinite(row.repeatRatePercent)).toBe(true);
      expect(Number.isFinite(row.priorityScore)).toBe(true);
      expect(Number.isNaN(row.repeatRatePercent)).toBe(false);
    }
    expect(Number.isFinite(summary.kpis.repeatedShareOfPeriodPercent)).toBe(true);
  }, 20_000);

  it("paginates a large per-facility person list without loading everything into one page", async () => {
    const facility = facilityName(0);
    const page = await getRepeatComplainantPeoplePage(
      params(`from=2026-01-01&to=2026-03-31&facility=${encodeURIComponent(facility)}&pageSize=10&page=1`)
    );
    expect(page.people.length).toBeLessThanOrEqual(10);
    expect(page.total).toBeGreaterThan(page.people.length);
  }, 20_000);
});
