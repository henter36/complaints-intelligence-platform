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
});
