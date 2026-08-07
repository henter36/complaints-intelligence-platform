import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComplaintPriority, ComplaintStatus, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OPERATIONAL_UNSPECIFIED } from "./operational-analytics-types";
import { runPrismaMigrateDeploy } from "../../../../scripts/lib/prisma-cli-runner";

const dbHolder = vi.hoisted(() => ({
  client: null as PrismaClient | null,
}));

vi.mock("@/lib/db", () => ({
  db: {
    get complaint() {
      if (!dbHolder.client) throw new Error("test prisma not ready");
      return dbHolder.client.complaint;
    },
    get classification() {
      if (!dbHolder.client) throw new Error("test prisma not ready");
      return dbHolder.client.classification;
    },
  },
}));

import { getOperationalAnalytics } from "./operational-analytics-service";
import { listComplaints } from "@/server/complaints/complaint-query-service";

const NOW = new Date("2026-08-05T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

let tempDir: string | null = null;

function restoreDatabaseUrl(originalValue: string | undefined): void {
  if (originalValue === undefined) {
    delete process.env.DATABASE_URL;
    return;
  }
  process.env.DATABASE_URL = originalValue;
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cip-op-agg-"));
  const dbPath = join(tempDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  runPrismaMigrateDeploy(`file:${dbPath}`);
  dbHolder.client = new PrismaClient();
  await seedParityDataset(dbHolder.client);
}, 60_000);

afterAll(async () => {
  try {
    await dbHolder.client?.$disconnect();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  } finally {
    restoreDatabaseUrl(ORIGINAL_DATABASE_URL);
  }
});

async function seedParityDataset(prisma: PrismaClient) {
  const category = await prisma.category.create({
    data: {
      nameAr: "تصنيف اختبار",
      nameEn: "Test category",
      isActive: true,
    },
  });
  const classification = await prisma.classification.create({
    data: {
      categoryId: category.id,
      nameAr: "مواعيد",
      nameEn: "Appointments",
      isActive: true,
    },
  });
  // nameAr is only unique per category (@@unique([categoryId, nameAr])), so a
  // second category can hold a classificationId with the same Arabic name as
  // `classification`. This proves wing top-classification aggregation groups
  // by nameAr rather than by classificationId.
  const categorySameName = await prisma.category.create({
    data: {
      nameAr: "تصنيف اختبار ٢",
      nameEn: "Test category 2",
      isActive: true,
    },
  });
  const classificationSameName = await prisma.classification.create({
    data: {
      categoryId: categorySameName.id,
      nameAr: "مواعيد",
      nameEn: "Appointments (duplicate name)",
      isActive: true,
    },
  });
  const classificationOther = await prisma.classification.create({
    data: {
      categoryId: category.id,
      nameAr: "سلوك",
      nameEn: "Conduct",
      isActive: true,
    },
  });

  const base = {
    subject: "شكوى اختبار",
    priority: ComplaintPriority.MEDIUM,
    severity: ComplaintPriority.MEDIUM,
    isDeleted: false,
    classificationId: classification.id,
  };

  await prisma.complaint.createMany({
    data: [
      {
        ...base,
        externalId: "parity-1",
        status: ComplaintStatus.OPEN,
        sourceOrigin: "الجهاز الرئيسي",
        sourceStatus: "مبدئي",
        sourceActionStatus: "جديد",
        channel: "الهاتف",
        region: "الرياض",
        facility: "مستشفى أ",
        department: "الطوارئ",
        wingCode: "W1",
        complaintDate: new Date("2026-07-15T00:00:00.000Z"),
        receivedAt: new Date("2026-07-15T08:00:00.000Z"),
        dueDate: new Date("2026-07-20T00:00:00.000Z"),
        sourceUpdatedAt: new Date(NOW.getTime() - 2 * DAY_MS),
      },
      {
        ...base,
        externalId: "parity-2",
        status: ComplaintStatus.CLOSED,
        sourceOrigin: "الجهاز الرئيسي",
        sourceStatus: "مغلقة",
        sourceActionStatus: "منتهية",
        channel: "المنصة",
        region: "الرياض",
        facility: "مستشفى أ",
        department: "الطوارئ",
        wingCode: "W1",
        complaintDate: new Date("2026-07-01T00:00:00.000Z"),
        receivedAt: new Date("2026-07-01T08:00:00.000Z"),
        closedAt: new Date("2026-07-05T00:00:00.000Z"),
        sourceUpdatedAt: new Date(NOW.getTime() - DAY_MS / 2),
      },
      {
        ...base,
        externalId: "parity-3",
        status: ComplaintStatus.IN_PROGRESS,
        sourceOrigin: "منصة إلكترونية",
        sourceStatus: "قيد المعالجة",
        sourceActionStatus: "قيد التنفيذ",
        channel: "البريد",
        region: "مكة",
        facility: "مستشفى ب",
        department: "العيادات",
        wingCode: "W2",
        complaintDate: new Date("2026-07-10T00:00:00.000Z"),
        receivedAt: new Date("2026-07-10T08:00:00.000Z"),
        dueDate: new Date("2026-08-20T00:00:00.000Z"),
        sourceUpdatedAt: new Date(NOW.getTime() - 4 * DAY_MS),
      },
      {
        ...base,
        externalId: "parity-4",
        status: ComplaintStatus.NEW,
        sourceOrigin: null,
        sourceStatus: null,
        sourceActionStatus: null,
        channel: null,
        region: "الرياض",
        facility: "مستشفى أ",
        department: "الطوارئ",
        wingCode: null,
        complaintDate: new Date("2026-07-12T00:00:00.000Z"),
        receivedAt: new Date("2026-07-12T08:00:00.000Z"),
        dueDate: new Date("2026-08-01T00:00:00.000Z"),
        sourceUpdatedAt: null,
      },
      {
        ...base,
        externalId: "parity-5",
        status: ComplaintStatus.RESOLVED,
        sourceOrigin: "",
        sourceStatus: "",
        sourceActionStatus: "",
        channel: "",
        region: "مكة",
        facility: "مستشفى ب",
        department: "العيادات",
        wingCode: "W2",
        complaintDate: null,
        receivedAt: new Date("2026-06-01T08:00:00.000Z"),
        closedAt: new Date("2026-06-10T08:00:00.000Z"),
        sourceUpdatedAt: new Date(NOW.getTime() - 10 * DAY_MS),
      },
      {
        ...base,
        // Assigned to the classificationId that shares nameAr "مواعيد" with
        // `classification`, so W1's "مواعيد" total must be split across two
        // classificationIds and only recombine when grouped by name.
        classificationId: classificationSameName.id,
        externalId: "parity-6",
        status: ComplaintStatus.CLOSED,
        sourceOrigin: "منصة إلكترونية",
        sourceStatus: "مغلقة",
        sourceActionStatus: "منتهية",
        channel: "الهاتف",
        region: "الرياض",
        facility: "مستشفى أ",
        department: "الطوارئ",
        wingCode: "W1",
        complaintDate: new Date("2026-05-01T00:00:00.000Z"),
        receivedAt: new Date("2026-05-01T08:00:00.000Z"),
        closedAt: new Date("2026-05-03T00:00:00.000Z"),
        sourceUpdatedAt: new Date(NOW.getTime() - 8 * DAY_MS),
      },
      {
        ...base,
        classificationId: classificationSameName.id,
        externalId: "parity-prev-1",
        status: ComplaintStatus.CLOSED,
        sourceOrigin: "الجهاز الرئيسي",
        sourceStatus: "مغلقة",
        sourceActionStatus: "منتهية",
        channel: "الهاتف",
        region: "الرياض",
        facility: "مستشفى أ",
        department: "الطوارئ",
        wingCode: "W1",
        complaintDate: new Date("2026-06-15T00:00:00.000Z"),
        receivedAt: new Date("2026-06-15T08:00:00.000Z"),
        closedAt: new Date("2026-06-18T00:00:00.000Z"),
        sourceUpdatedAt: new Date(NOW.getTime() - 20 * DAY_MS),
      },
      // Three complaints on a third classificationId with a distinct name
      // ("سلوك"). Individually it outnumbers each of the two "مواعيد" ids
      // (2 vs 2), but the correctly name-merged "مواعيد" total (2 + 2 = 4)
      // must still win over "سلوك" (3).
      {
        ...base,
        classificationId: classificationOther.id,
        externalId: "parity-cls-1",
        status: ComplaintStatus.OPEN,
        sourceOrigin: "قناة اختبار",
        sourceStatus: "مبدئي",
        sourceActionStatus: "جديد",
        channel: "الهاتف",
        region: "الرياض",
        facility: "مستشفى أ",
        department: "الطوارئ",
        wingCode: "W1",
        complaintDate: null,
        receivedAt: new Date("2026-06-20T08:00:00.000Z"),
        dueDate: new Date("2026-08-25T00:00:00.000Z"),
        sourceUpdatedAt: new Date(NOW.getTime() - 6 * DAY_MS),
      },
      {
        ...base,
        classificationId: classificationOther.id,
        externalId: "parity-cls-2",
        status: ComplaintStatus.CLOSED,
        sourceOrigin: "قناة اختبار",
        sourceStatus: "مغلقة",
        sourceActionStatus: "منتهية",
        channel: "الهاتف",
        region: "الرياض",
        facility: "مستشفى أ",
        department: "الطوارئ",
        wingCode: "W1",
        complaintDate: null,
        receivedAt: new Date("2026-06-21T08:00:00.000Z"),
        closedAt: new Date("2026-06-22T00:00:00.000Z"),
        sourceUpdatedAt: new Date(NOW.getTime() - 6 * DAY_MS),
      },
      {
        ...base,
        classificationId: classificationOther.id,
        externalId: "parity-cls-3",
        status: ComplaintStatus.CLOSED,
        sourceOrigin: "قناة اختبار",
        sourceStatus: "مغلقة",
        sourceActionStatus: "منتهية",
        channel: "الهاتف",
        region: "الرياض",
        facility: "مستشفى أ",
        department: "الطوارئ",
        wingCode: "W1",
        complaintDate: null,
        receivedAt: new Date("2026-06-22T08:00:00.000Z"),
        closedAt: new Date("2026-06-23T00:00:00.000Z"),
        sourceUpdatedAt: new Date(NOW.getTime() - 6 * DAY_MS),
      },
      // Data Quality parity requires modifiedBeforeUpdated / diff-hours to be
      // genuinely non-zero somewhere in the fixture — every other row above
      // leaves sourceModifiedAt unset (null), so a hard-coded-zero
      // implementation would pass parity checks undetected without these.
      // Dated in August (outside the July current/previous-period windows
      // used by other tests) and region "مكة" / wingCode null, so they never
      // affect any of the from/to- or W1-scoped assertions above.
      {
        ...base,
        externalId: "parity-modified-after-updated",
        status: ComplaintStatus.OPEN,
        sourceOrigin: "قناة اختبار",
        sourceStatus: "مبدئي",
        sourceActionStatus: "جديد",
        channel: "الهاتف",
        region: "مكة",
        facility: "مستشفى ب",
        department: "العيادات",
        wingCode: null,
        complaintDate: new Date("2026-08-01T00:00:00.000Z"),
        receivedAt: new Date("2026-08-01T08:00:00.000Z"),
        sourceUpdatedAt: new Date(NOW.getTime() - 2 * DAY_MS),
        // +2h after updated -> counts toward modifiedBeforeUpdated (legacy semantics).
        sourceModifiedAt: new Date(NOW.getTime() - 2 * DAY_MS + 2 * 60 * 60 * 1000),
      },
      {
        ...base,
        externalId: "parity-modified-before-updated",
        status: ComplaintStatus.OPEN,
        sourceOrigin: "قناة اختبار",
        sourceStatus: "مبدئي",
        sourceActionStatus: "جديد",
        channel: "الهاتف",
        region: "مكة",
        facility: "مستشفى ب",
        department: "العيادات",
        wingCode: null,
        complaintDate: new Date("2026-08-02T00:00:00.000Z"),
        receivedAt: new Date("2026-08-02T08:00:00.000Z"),
        sourceUpdatedAt: new Date(NOW.getTime() - 2 * DAY_MS),
        // -3h before updated -> does NOT count toward modifiedBeforeUpdated,
        // but does contribute to the diff-hours average with the opposite sign.
        sourceModifiedAt: new Date(NOW.getTime() - 2 * DAY_MS - 3 * 60 * 60 * 1000),
      },
    ],
  });
}

describe("operational analytics DB aggregate integration", () => {
  it("restoreDatabaseUrl removes DATABASE_URL when original is undefined", () => {
    const before = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "file:/tmp/test.db";
    restoreDatabaseUrl(undefined);
    expect(process.env.DATABASE_URL).toBeUndefined();
    restoreDatabaseUrl(before);
  });

  it("restoreDatabaseUrl restores DATABASE_URL when original exists", () => {
    const before = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "file:/tmp/test.db";
    restoreDatabaseUrl("file:/tmp/original.db");
    expect(process.env.DATABASE_URL).toBe("file:/tmp/original.db");
    restoreDatabaseUrl(before);
  });

  it("restores DATABASE_URL ownership to the suite bootstrap", () => {
    expect(process.env.DATABASE_URL).toMatch(/^file:/);
    if (tempDir) {
      expect(process.env.DATABASE_URL).toContain(tempDir);
    }
  });

  it("matches totalInScope to listComplaints pagination.total", async () => {
    const params = new URLSearchParams("from=2026-07-01&to=2026-07-31&regionId=الرياض");
    const summary = await getOperationalAnalytics(params, { now: NOW });
    const list = await listComplaints(params, { now: NOW });
    expect(summary.totalInScope).toBe(list.pagination.total);
    expect(summary.totalInScope).toBeGreaterThan(0);
  });

  it("keeps drill-down pagination.total equal to each bucket count", async () => {
    const base = new URLSearchParams("from=2026-07-01&to=2026-07-31");
    const summary = await getOperationalAnalytics(base, { now: NOW });

    for (const dimension of ["sourceOrigin", "sourceStatus", "sourceActionStatus"] as const) {
      const items =
        dimension === "sourceOrigin"
          ? summary.sourceOrigin.items
          : dimension === "sourceStatus"
            ? summary.sourceStatus.items
            : summary.sourceActionStatus.items;
      for (const bucket of items) {
        const drill = new URLSearchParams(base);
        for (const [key, value] of Object.entries(bucket.drillDownFilters)) {
          drill.set(key, value);
        }
        const list = await listComplaints(drill, { now: NOW });
        expect(list.pagination.total, `${dimension}:${bucket.key}`).toBe(bucket.count);
      }
    }
  });

  it("merges null and empty sourceOrigin into unspecified with drill-down parity", async () => {
    const base = new URLSearchParams();
    const summary = await getOperationalAnalytics(base, { now: NOW });
    const unspecified = summary.sourceOrigin.items.find((item) => item.key === OPERATIONAL_UNSPECIFIED);
    expect(unspecified).toBeTruthy();
    expect(unspecified!.count).toBeGreaterThanOrEqual(2);

    const drill = new URLSearchParams(base);
    drill.set("sourceOrigin", OPERATIONAL_UNSPECIFIED);
    const list = await listComplaints(drill, { now: NOW });
    expect(list.pagination.total).toBe(unspecified!.count);
  });

  it("populates previousCount for sourceOrigin when from/to are set", async () => {
    const summary = await getOperationalAnalytics(
      new URLSearchParams("from=2026-07-01&to=2026-07-31"),
      { now: NOW }
    );
    const origin = summary.sourceOrigin.items.find((item) => item.key === "الجهاز الرئيسي");
    expect(origin).toBeTruthy();
    expect(origin!.previousCount).toBe(1);
    expect(origin!.change).toBe(origin!.count - 1);
  });

  it("keeps channelIndependentCheck note and independent key counts", async () => {
    const summary = await getOperationalAnalytics(new URLSearchParams(), { now: NOW });
    expect(summary.channelIndependentCheck.note).toContain("independent");
    expect(summary.channelIndependentCheck.sourceOriginKeys).toBeGreaterThan(0);
    expect(summary.channelIndependentCheck.channelKeys).toBeGreaterThan(0);
  });

  it("supports facility, department, classification, wingCode, and freshness filters", async () => {
    const params = new URLSearchParams(
      "facility=مستشفى أ&department=الطوارئ&wingCode=W1&dataFreshnessBucket=stale_1_3d"
    );
    const summary = await getOperationalAnalytics(params, { now: NOW });
    const list = await listComplaints(params, { now: NOW });
    expect(summary.totalInScope).toBe(list.pagination.total);
  });

  it("keeps wing drill-down pagination.total equal to each wing bucket count", async () => {
    const base = new URLSearchParams("from=2026-07-01&to=2026-07-31");
    const summary = await getOperationalAnalytics(base, { now: NOW });

    for (const item of summary.wing.items) {
      const drill = new URLSearchParams(base);
      for (const [key, value] of Object.entries(item.drillDownFilters)) {
        drill.set(key, value);
      }
      const list = await listComplaints(drill, { now: NOW });
      expect(list.pagination.total, `wing:${item.key}`).toBe(item.count);
    }
  });

  it("matches wing unspecifiedCount to listComplaints with wingCode unspecified", async () => {
    const base = new URLSearchParams();
    const summary = await getOperationalAnalytics(base, { now: NOW });
    expect(summary.wing.unspecifiedCount).toBeGreaterThan(0);

    const drill = new URLSearchParams(base);
    drill.set("wingCode", OPERATIONAL_UNSPECIFIED);
    const list = await listComplaints(drill, { now: NOW });
    expect(list.pagination.total).toBe(summary.wing.unspecifiedCount);
  });

  it("merges W1's top classification by Arabic name across two classificationIds sharing \"مواعيد\"", async () => {
    const summary = await getOperationalAnalytics(new URLSearchParams(), { now: NOW });
    const w1 = summary.wing.items.find((item) => item.key === "W1");
    expect(w1).toBeDefined();
    // "مواعيد" is split across two classificationIds (2 + 2 = 4) and must
    // outrank the single-id "سلوك" classification (3) once merged by name.
    expect(w1!.topClassification).toBe("مواعيد");
    expect(w1!.topClassificationCount).toBe(4);
  });

  it("keeps freshness drill-down pagination.total equal to each bucket count, and bucket counts sum to totalInScope", async () => {
    const base = new URLSearchParams();
    const summary = await getOperationalAnalytics(base, { now: NOW });

    let sumOfBuckets = 0;
    for (const bucket of summary.freshness.buckets) {
      sumOfBuckets += bucket.count;
      const drill = new URLSearchParams(base);
      for (const [key, value] of Object.entries(bucket.drillDownFilters)) {
        drill.set(key, value);
      }
      const list = await listComplaints(drill, { now: NOW });
      expect(list.pagination.total, `freshness:${bucket.bucket}`).toBe(bucket.count);
    }
    expect(sumOfBuckets).toBe(summary.totalInScope);
  });

  it("matches the three sourceUpdatedAt/sourceModifiedAt data-quality signal counts to the freshness aggregate, with explicit non-zero expected values", async () => {
    const summary = await getOperationalAnalytics(new URLSearchParams(), { now: NOW });
    const byId = new Map(summary.dataQuality.map((signal) => [signal.id, signal]));

    // Explicit expected values from the fixture (not just cross-field
    // equality — a hard-coded-zero implementation would pass a
    // signal-vs-freshness-field comparison undetected if both sides were
    // wrong the same way):
    // - 10 of the 12 seeded rows never set sourceModifiedAt.
    // - Only "parity-modified-after-updated" has sourceModifiedAt > sourceUpdatedAt.
    expect(summary.freshness.missingModifiedAt).toBe(10);
    expect(summary.freshness.modifiedBeforeUpdated).toBe(1);

    // Wiring: the data-quality signal must reflect the same freshness values,
    // not just happen to also be correct independently.
    expect(byId.get("missing_source_updated_at")?.count).toBe(summary.freshness.missingUpdatedAt);
    expect(byId.get("missing_source_modified_at")?.count).toBe(summary.freshness.missingModifiedAt);
    expect(byId.get("modified_after_updated")?.count).toBe(summary.freshness.modifiedBeforeUpdated);
  });

  it("keeps freshness in the same scope as a base query that already filters dataFreshnessBucket, across many combined filters", async () => {
    // Two seeded rows match every one of these filters simultaneously —
    // region/facility/department/channel/status, plus stale_7d_plus:
    // parity-6 (sourceUpdatedAt = NOW - 8 days) and parity-prev-1
    // (sourceUpdatedAt = NOW - 20 days). Both are CLOSED, "الرياض" /
    // "مستشفى أ" / "الطوارئ" / "الهاتف".
    const params = new URLSearchParams(
      "region=الرياض&facility=مستشفى أ&department=الطوارئ&channel=الهاتف&status=CLOSED&dataFreshnessBucket=stale_7d_plus"
    );
    const summary = await getOperationalAnalytics(params, { now: NOW });
    const list = await listComplaints(params, { now: NOW });

    expect(summary.totalInScope).toBe(2);
    expect(list.pagination.total).toBe(2);
    expect(summary.totalInScope).toBe(list.pagination.total);

    for (const bucket of summary.freshness.buckets) {
      if (bucket.bucket === "stale_7d_plus") {
        expect(bucket.count).toBe(summary.totalInScope);
      } else {
        expect(bucket.count, bucket.bucket).toBe(0);
      }
    }
  });
});
