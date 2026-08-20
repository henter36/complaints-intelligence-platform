// Real-DB regression coverage for the COMPLAINT_DETAIL report's "تفاصيل
// الشكاوى" table: rows must be grouped region -> facility -> complaint
// date desc (deterministically tie-broken), never the general date-only
// default — and, critically, that grouping must be applied by the
// database itself BEFORE the preview/run row cap, not as a JS re-sort of
// an already-limited, date-ordered page (section 7/12 of the fix spec).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComplaintPriority, ComplaintStatus, PrismaClient, ReportType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runPrismaMigrateDeploy } from "../../../scripts/lib/prisma-cli-runner";

const dbHolder = vi.hoisted(() => ({ client: null as PrismaClient | null }));

vi.mock("@/lib/db", () => ({
  db: {
    get complaint() {
      if (!dbHolder.client) throw new Error("test prisma not ready");
      return dbHolder.client.complaint;
    },
    get facility() {
      if (!dbHolder.client) throw new Error("test prisma not ready");
      return dbHolder.client.facility;
    },
    get classification() {
      if (!dbHolder.client) throw new Error("test prisma not ready");
      return dbHolder.client.classification;
    },
    get category() {
      if (!dbHolder.client) throw new Error("test prisma not ready");
      return dbHolder.client.category;
    },
  },
}));

const { buildReportData } = await import("./report-data-service");
const { parseReportRequest } = await import("./report-definition-service");

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
let tempDir: string | null = null;

function prisma(): PrismaClient {
  if (!dbHolder.client) throw new Error("test database is not initialized");
  return dbHolder.client;
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cip-report-complaint-order-"));
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
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  }
});

const BASE = {
  subject: "شكوى اختبار",
  priority: ComplaintPriority.MEDIUM,
  severity: ComplaintPriority.MEDIUM,
  isDeleted: false,
  status: ComplaintStatus.OPEN,
} as const;

const RIYADH_FACILITY_A = "سجن أ";
const RIYADH_FACILITY_B = "سجن ب";
const MAKKAH_FACILITY_C = "سجن ج";

/**
 * All scenarios share one seed, isolated from each other by disjoint date
 * windows — each `it()` filters to its own window via `from`/`to`, mirroring
 * the established pattern in the repeat-complainants integration tests.
 */
async function seedDataset(client: PrismaClient) {
  // Scenario 1 — the ticket's exact dataset (2026-08-16..2026-08-20):
  // multiple regions, multiple facilities per region, multiple complaints
  // per facility, interleaved INSERT order (deliberately not pre-sorted).
  await client.complaint.createMany({
    data: [
      { ...BASE, externalId: "ord-1", region: "الرياض", facility: RIYADH_FACILITY_B, facilityNormalizedName: "سجن ب", complaintDate: new Date("2026-08-20T00:00:00.000Z") },
      { ...BASE, externalId: "ord-2", region: "مكة", facility: MAKKAH_FACILITY_C, facilityNormalizedName: "سجن ج", complaintDate: new Date("2026-08-19T00:00:00.000Z") },
      { ...BASE, externalId: "ord-3", region: "الرياض", facility: RIYADH_FACILITY_A, facilityNormalizedName: "سجن ا", complaintDate: new Date("2026-08-18T00:00:00.000Z") },
      { ...BASE, externalId: "ord-4", region: "الرياض", facility: RIYADH_FACILITY_B, facilityNormalizedName: "سجن ب", complaintDate: new Date("2026-08-17T00:00:00.000Z") },
      { ...BASE, externalId: "ord-5", region: "الرياض", facility: RIYADH_FACILITY_A, facilityNormalizedName: "سجن ا", complaintDate: new Date("2026-08-16T00:00:00.000Z") },
    ],
  });

  // Scenario 2 — deterministic tie-break: two complaints, same facility,
  // same complaintDate, must still resolve to one fixed order (externalId asc).
  await client.complaint.createMany({
    data: [
      { ...BASE, externalId: "tie-2", region: "الرياض", facility: RIYADH_FACILITY_A, facilityNormalizedName: "سجن ا", complaintDate: new Date("2026-09-01T00:00:00.000Z") },
      { ...BASE, externalId: "tie-1", region: "الرياض", facility: RIYADH_FACILITY_A, facilityNormalizedName: "سجن ا", complaintDate: new Date("2026-09-01T00:00:00.000Z") },
    ],
  });

  // Scenario 3 — empty/unspecified facility must group independently at
  // the end, never interleaved with named facilities.
  await client.complaint.createMany({
    data: [
      { ...BASE, externalId: "fac-known-1", region: "الرياض", facility: RIYADH_FACILITY_A, facilityNormalizedName: "سجن ا", complaintDate: new Date("2026-09-05T00:00:00.000Z") },
      { ...BASE, externalId: "fac-empty-1", region: "الرياض", facility: null, facilityNormalizedName: null, complaintDate: new Date("2026-09-07T00:00:00.000Z") },
      { ...BASE, externalId: "fac-known-2", region: "الرياض", facility: RIYADH_FACILITY_A, facilityNormalizedName: "سجن ا", complaintDate: new Date("2026-09-06T00:00:00.000Z") },
    ],
  });

  // Scenario 4 — empty/unspecified region must also group independently at
  // the end, not interleaved with named regions.
  await client.complaint.createMany({
    data: [
      { ...BASE, externalId: "reg-known-1", region: "الرياض", facility: RIYADH_FACILITY_A, facilityNormalizedName: "سجن ا", complaintDate: new Date("2026-09-10T00:00:00.000Z") },
      { ...BASE, externalId: "reg-empty-1", region: null, facility: RIYADH_FACILITY_A, facilityNormalizedName: "سجن ا", complaintDate: new Date("2026-09-11T00:00:00.000Z") },
    ],
  });

  // Scenario 5 (regression-critical, section 12) — 130 complaints, dates
  // STRICTLY alternating region by region so the OLD date-only ordering
  // would interleave region A/B row-by-row (the exact "سجن أ, سجن ب, سجن
  // أ, سجن ج" bug from the ticket), while the fix must return facility A's
  // rows as one contiguous block. Region "منطقة-أ" (sorts first) gets the
  // OLDER half of the alternating dates, "منطقة-ب" (sorts second) gets the
  // newer half — so a plain "newest 100" cut would pull in EVERY region-ب
  // row plus only the newest of region-أ's, a different (and wrong) subset
  // than the correct "all of region-أ, oldest 100 not counted" result.
  const bulkData: {
    externalId: string; region: string; facility: string; facilityNormalizedName: string;
    complaintDate: Date;
  }[] = [];
  const bulkStart = new Date("2026-01-01T00:00:00.000Z").getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  for (let i = 0; i < 130; i++) {
    const region = i % 2 === 0 ? "منطقة-أ" : "منطقة-ب";
    bulkData.push({
      externalId: `bulk-${String(i).padStart(3, "0")}`,
      region,
      facility: "السجن الوحيد",
      facilityNormalizedName: "السجن الوحيد",
      complaintDate: new Date(bulkStart + i * dayMs),
    });
  }
  await client.complaint.createMany({ data: bulkData.map((row) => ({ ...BASE, ...row })) });
}

async function fetchDetailRows(filters: { from: string; to: string }) {
  const request = parseReportRequest({ type: ReportType.COMPLAINT_DETAIL, filters });
  const report = await buildReportData(request, "preview", new Date("2030-01-01T00:00:00.000Z"));
  const section = report.sections.find((s) => s.id === "detail_table");
  if (!section || section.kind !== "table") throw new Error("detail_table section missing");
  return section.table;
}

describe("COMPLAINT_DETAIL report — region -> facility -> date ordering (real sqlite)", () => {
  it("groups multiple regions and multiple facilities within a region contiguously, newest-first within each facility, deterministically", async () => {
    const table = await fetchDetailRows({ from: "2026-08-15", to: "2026-08-21" });
    expect(table.rows.map((r) => r.complaintNumber)).toEqual([
      "ord-3", // الرياض / سجن أ / 08-18 (newest in facility أ)
      "ord-5", // الرياض / سجن أ / 08-16
      "ord-1", // الرياض / سجن ب / 08-20 (newest in facility ب)
      "ord-4", // الرياض / سجن ب / 08-17
      "ord-2", // مكة / سجن ج / 08-19 (region مكة sorts after الرياض)
    ]);
  });

  it("never shows the interleaved 'facility-A, facility-B, facility-A' pattern the ticket reported", async () => {
    const table = await fetchDetailRows({ from: "2026-08-15", to: "2026-08-21" });
    const facilities = table.rows.map((r) => String(r.facility));
    const firstIndexByFacility = new Map<string, number>();
    const lastIndexByFacility = new Map<string, number>();
    facilities.forEach((facility, index) => {
      if (!firstIndexByFacility.has(facility)) firstIndexByFacility.set(facility, index);
      lastIndexByFacility.set(facility, index);
    });
    // Contiguous means every facility's rows form one unbroken run: its
    // span (last - first + 1) equals its actual row count.
    for (const facility of firstIndexByFacility.keys()) {
      const span = lastIndexByFacility.get(facility)! - firstIndexByFacility.get(facility)! + 1;
      const count = facilities.filter((f) => f === facility).length;
      expect(span).toBe(count);
    }
  });

  it("resolves a same-facility, same-complaintDate tie deterministically by externalId ascending", async () => {
    const table = await fetchDetailRows({ from: "2026-09-01", to: "2026-09-01" });
    expect(table.rows.map((r) => r.complaintNumber)).toEqual(["tie-1", "tie-2"]);
  });

  it("groups unspecified facility into its own block at the end, never interleaved with a known facility", async () => {
    const table = await fetchDetailRows({ from: "2026-09-05", to: "2026-09-07" });
    // Known-facility rows (newest first) precede the unspecified-facility row.
    expect(table.rows.map((r) => r.complaintNumber)).toEqual([
      "fac-known-2",
      "fac-known-1",
      "fac-empty-1",
    ]);
    expect(table.rows.at(-1)?.facility).toBe("");
  });

  it("groups unspecified region into its own block at the end, never interleaved with a known region", async () => {
    const table = await fetchDetailRows({ from: "2026-09-10", to: "2026-09-11" });
    expect(table.rows.map((r) => r.complaintNumber)).toEqual(["reg-known-1", "reg-empty-1"]);
    expect(table.rows.at(-1)?.region).toBe("");
  });

  it("produces the exact same row order on a repeated call (deterministic, not incidentally stable)", async () => {
    const first = await fetchDetailRows({ from: "2026-08-15", to: "2026-08-21" });
    const second = await fetchDetailRows({ from: "2026-08-15", to: "2026-08-21" });
    expect(second.rows.map((r) => r.complaintNumber)).toEqual(first.rows.map((r) => r.complaintNumber));
  });

  it("still honors ordinary filters (date range) alongside the new ordering", async () => {
    const table = await fetchDetailRows({ from: "2026-08-17", to: "2026-08-18" });
    // Only ord-3 (08-18) and ord-4 (08-17) fall inside this narrower window.
    expect(table.rows.map((r) => r.complaintNumber).sort()).toEqual(["ord-3", "ord-4"]);
  });

  it("REGRESSION (section 12): the preview cap selects the first N rows of the facility-grouped DB order, not the first N by date re-sorted in JS", async () => {
    const table = await fetchDetailRows({ from: "2026-01-01", to: "2026-06-30" });
    // 130 seeded rows, all matched by this window; preview caps at 100.
    expect(table.totalMatched).toBe(130);
    expect(table.rows.length).toBe(100);
    expect(table.truncated).toBe(true);

    const regions = table.rows.map((r) => String(r.region));
    // Region "منطقة-أ" (65 rows, all older dates) sorts before "منطقة-ب"
    // (65 rows, all newer dates) — the CORRECT region-grouped top-100 must
    // therefore contain every region-أ row (65) plus the 35 newest
    // region-ب rows, and region-أ's block must come FIRST despite being
    // entirely older. A buggy "newest 100 by date, then group" approach
    // would instead return 0 region-أ rows (all 65 are older than every
    // region-ب row) — a completely different, wrong subset.
    const countA = regions.filter((r) => r === "منطقة-أ").length;
    const countB = regions.filter((r) => r === "منطقة-ب").length;
    expect(countA).toBe(65);
    expect(countB).toBe(35);
    // And region-أ's block must be contiguous and first.
    expect(regions.slice(0, 65).every((r) => r === "منطقة-أ")).toBe(true);
    expect(regions.slice(65).every((r) => r === "منطقة-ب")).toBe(true);
  });
});
