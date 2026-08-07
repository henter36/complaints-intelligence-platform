import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComplaintPriority, ComplaintStatus, PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runPrismaMigrateDeploy } from "../../../../scripts/lib/prisma-cli-runner";
import {
  DAY_MS,
  resolveFreshnessBucket,
} from "@/server/analytics/operational/operational-freshness";
import {
  DATA_FRESHNESS_BUCKETS,
  type DataFreshnessBucket,
} from "@/server/analytics/operational/operational-analytics-types";

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date("2026-08-07T12:00:00.000Z");

const dbHolder = vi.hoisted(() => ({
  client: null as PrismaClient | null,
}));

vi.mock("@/lib/db", () => ({
  db: {
    get complaint() {
      if (!dbHolder.client) throw new Error("test prisma not ready");
      return dbHolder.client.complaint;
    },
  },
}));

import { loadAggregatedFreshnessMetrics } from "./operational-freshness-aggregate-service";
import {
  buildComplaintWhere,
  listComplaints,
  parseComplaintQuery,
} from "@/server/complaints/complaint-query-service";

let prisma: PrismaClient | null = null;
let tempDir: string | null = null;
let testDatabaseUrl = "";
let classificationId = "";

/** All rows below are tagged by `department` so each scenario can scope its own `where`. */
const DEPT_BOUNDARY = "freshness-boundary";
const DEPT_AVG_AGE = "freshness-avg-age";
const DEPT_DIAGNOSTICS = "freshness-diagnostics";
const DEPT_QUERY_COUNT_SMALL = "freshness-qcount-small";
const DEPT_QUERY_COUNT_LARGE = "freshness-qcount-large";
const DEPT_NEGATIVE_DIFF = "freshness-negative-diff";

type SeedRow = {
  externalId: string;
  department: string;
  sourceUpdatedAt: Date | null;
  sourceModifiedAt: Date | null;
};

const boundaryRows: SeedRow[] = [
  { externalId: "b-future-1h", department: DEPT_BOUNDARY, sourceUpdatedAt: new Date(NOW.getTime() + HOUR_MS), sourceModifiedAt: null },
  { externalId: "b-now", department: DEPT_BOUNDARY, sourceUpdatedAt: new Date(NOW.getTime()), sourceModifiedAt: null },
  { externalId: "b-almost-1d", department: DEPT_BOUNDARY, sourceUpdatedAt: new Date(NOW.getTime() - (DAY_MS - 1)), sourceModifiedAt: null },
  { externalId: "b-exactly-1d", department: DEPT_BOUNDARY, sourceUpdatedAt: new Date(NOW.getTime() - DAY_MS), sourceModifiedAt: null },
  { externalId: "b-1d-1ms", department: DEPT_BOUNDARY, sourceUpdatedAt: new Date(NOW.getTime() - DAY_MS - 1), sourceModifiedAt: null },
  { externalId: "b-exactly-3d", department: DEPT_BOUNDARY, sourceUpdatedAt: new Date(NOW.getTime() - 3 * DAY_MS), sourceModifiedAt: null },
  { externalId: "b-3d-1ms", department: DEPT_BOUNDARY, sourceUpdatedAt: new Date(NOW.getTime() - 3 * DAY_MS - 1), sourceModifiedAt: null },
  { externalId: "b-exactly-7d", department: DEPT_BOUNDARY, sourceUpdatedAt: new Date(NOW.getTime() - 7 * DAY_MS), sourceModifiedAt: null },
  { externalId: "b-7d-1ms", department: DEPT_BOUNDARY, sourceUpdatedAt: new Date(NOW.getTime() - 7 * DAY_MS - 1), sourceModifiedAt: null },
  { externalId: "b-missing", department: DEPT_BOUNDARY, sourceUpdatedAt: null, sourceModifiedAt: null },
];

// A: 1 day old, B & C: 3 days old (same instant — a single DB group with
// count 2), D: missing. Weighted average must be (1+3+3)/3 = 2.333.. -> 2.3,
// NOT an unweighted average of distinct group values ((1+3)/2 = 2.0).
const avgAgeRows: SeedRow[] = [
  { externalId: "avg-a", department: DEPT_AVG_AGE, sourceUpdatedAt: new Date(NOW.getTime() - DAY_MS), sourceModifiedAt: null },
  { externalId: "avg-b", department: DEPT_AVG_AGE, sourceUpdatedAt: new Date(NOW.getTime() - 3 * DAY_MS), sourceModifiedAt: null },
  { externalId: "avg-c", department: DEPT_AVG_AGE, sourceUpdatedAt: new Date(NOW.getTime() - 3 * DAY_MS), sourceModifiedAt: null },
  { externalId: "avg-d", department: DEPT_AVG_AGE, sourceUpdatedAt: null, sourceModifiedAt: null },
];

const DIAG_UPDATED = new Date("2026-08-01T10:00:00.000Z");
const diagnosticsRows: SeedRow[] = [
  // 1: modified before updated by 1h -> +1h diff, not modifiedBeforeUpdated.
  { externalId: "diag-1", department: DEPT_DIAGNOSTICS, sourceUpdatedAt: DIAG_UPDATED, sourceModifiedAt: new Date(DIAG_UPDATED.getTime() - HOUR_MS) },
  // 2: modified after updated by 1h -> -1h diff, counts as modifiedBeforeUpdated.
  { externalId: "diag-2", department: DEPT_DIAGNOSTICS, sourceUpdatedAt: DIAG_UPDATED, sourceModifiedAt: new Date(DIAG_UPDATED.getTime() + HOUR_MS) },
  // 3: updated present, modified null -> excluded from diff average entirely.
  { externalId: "diag-3", department: DEPT_DIAGNOSTICS, sourceUpdatedAt: DIAG_UPDATED, sourceModifiedAt: null },
  // 4: updated null, modified present -> excluded.
  { externalId: "diag-4", department: DEPT_DIAGNOSTICS, sourceUpdatedAt: null, sourceModifiedAt: DIAG_UPDATED },
  // 5: both null -> excluded.
  { externalId: "diag-5", department: DEPT_DIAGNOSTICS, sourceUpdatedAt: null, sourceModifiedAt: null },
];

// 100 rows sharing one (updated, modified) pair + 1 row with a distinct pair —
// proves the groupBy weighting uses `_count._all`, not "1 row per group".
const WEIGHTED_PAIR_UPDATED = new Date("2026-08-02T10:00:00.000Z");
const WEIGHTED_PAIR_MODIFIED_COMMON = new Date("2026-08-02T09:00:00.000Z"); // +1h diff, shared by 100 rows
const WEIGHTED_PAIR_MODIFIED_OUTLIER = new Date("2026-08-02T11:00:00.000Z"); // -1h diff, 1 row, modifiedBeforeUpdated
const weightedPairRows: SeedRow[] = [
  ...Array.from({ length: 100 }, (_, i) => ({
    externalId: `diag-weighted-common-${i}`,
    department: DEPT_DIAGNOSTICS,
    sourceUpdatedAt: WEIGHTED_PAIR_UPDATED,
    sourceModifiedAt: WEIGHTED_PAIR_MODIFIED_COMMON,
  })),
  {
    externalId: "diag-weighted-outlier",
    department: DEPT_DIAGNOSTICS,
    sourceUpdatedAt: WEIGHTED_PAIR_UPDATED,
    sourceModifiedAt: WEIGHTED_PAIR_MODIFIED_OUTLIER,
  },
];

// A scope whose weighted diff-hours average is net NEGATIVE — a scenario
// dominated by a positive-leaning average (like DEPT_DIAGNOSTICS above)
// cannot distinguish a correct signed average from an accidental Math.abs():
// abs() of a positive number is unchanged. This scope would fail loudly
// under an abs() regression (it would flip from -1.0 to +1.0).
const NEGATIVE_DIFF_UPDATED = new Date("2026-08-03T10:00:00.000Z");
const negativeDiffRows: SeedRow[] = [
  // A: modified 12:00, updated 10:00 -> diff = updated - modified = -2h; modifiedBeforeUpdated.
  { externalId: "neg-a", department: DEPT_NEGATIVE_DIFF, sourceUpdatedAt: NEGATIVE_DIFF_UPDATED, sourceModifiedAt: new Date(NEGATIVE_DIFF_UPDATED.getTime() + 2 * HOUR_MS) },
  // B: same pair as A (-2h) -> weighted, not a duplicate no-op.
  { externalId: "neg-b", department: DEPT_NEGATIVE_DIFF, sourceUpdatedAt: NEGATIVE_DIFF_UPDATED, sourceModifiedAt: new Date(NEGATIVE_DIFF_UPDATED.getTime() + 2 * HOUR_MS) },
  // C: modified 09:00, updated 10:00 -> diff = +1h; not modifiedBeforeUpdated.
  { externalId: "neg-c", department: DEPT_NEGATIVE_DIFF, sourceUpdatedAt: NEGATIVE_DIFF_UPDATED, sourceModifiedAt: new Date(NEGATIVE_DIFF_UPDATED.getTime() - HOUR_MS) },
];

function buildLargeQueryCountRows(count: number): SeedRow[] {
  return Array.from({ length: count }, (_, i) => ({
    externalId: `qcount-large-${i}`,
    department: DEPT_QUERY_COUNT_LARGE,
    // High-cardinality: every row gets its own second-resolution timestamp.
    sourceUpdatedAt: new Date(NOW.getTime() - i * 1000),
    sourceModifiedAt: i % 3 === 0 ? new Date(NOW.getTime() - i * 1000 - HOUR_MS) : null,
  }));
}

const smallQueryCountRows: SeedRow[] = Array.from({ length: 10 }, (_, i) => ({
  externalId: `qcount-small-${i}`,
  department: DEPT_QUERY_COUNT_SMALL,
  sourceUpdatedAt: new Date(NOW.getTime() - i * DAY_MS),
  sourceModifiedAt: null,
}));

const largeQueryCountRows = buildLargeQueryCountRows(1000);

async function seed(client: PrismaClient) {
  const category = await client.category.create({
    data: { nameAr: "تصنيف اختبار الحداثة", isActive: true },
  });
  const classification = await client.classification.create({
    data: { categoryId: category.id, nameAr: "مواعيد", isActive: true },
  });
  classificationId = classification.id;

  const allRows = [
    ...boundaryRows,
    ...avgAgeRows,
    ...diagnosticsRows,
    ...weightedPairRows,
    ...negativeDiffRows,
    ...smallQueryCountRows,
    ...largeQueryCountRows,
  ];

  const base = {
    subject: "شكوى اختبار الحداثة",
    priority: ComplaintPriority.MEDIUM,
    severity: ComplaintPriority.MEDIUM,
    isDeleted: false,
    status: ComplaintStatus.OPEN,
    classificationId,
    receivedAt: new Date("2026-07-01T08:00:00.000Z"),
  };

  const batchSize = 500;
  for (let offset = 0; offset < allRows.length; offset += batchSize) {
    const chunk = allRows.slice(offset, offset + batchSize);
    await client.complaint.createMany({
      data: chunk.map((row) => ({
        ...base,
        externalId: row.externalId,
        department: row.department,
        sourceUpdatedAt: row.sourceUpdatedAt,
        sourceModifiedAt: row.sourceModifiedAt,
      })),
    });
  }
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cip-freshness-agg-"));
  const dbPath = join(tempDir, "test.db");
  testDatabaseUrl = `file:${dbPath}`;
  runPrismaMigrateDeploy(testDatabaseUrl);
  prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  dbHolder.client = prisma;
  await seed(prisma);
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function departmentWhere(department: string): Prisma.ComplaintWhereInput {
  return { department };
}

async function countInDepartment(department: string): Promise<number> {
  return prisma!.complaint.count({ where: { department } });
}

/** Independently computed (not copied from the service under test) per the documented formula. */
function referenceWeightedAverageAgeDays(values: Array<Date | null>, now: Date): number | null {
  let sum = 0;
  let count = 0;
  for (const value of values) {
    if (value === null) continue;
    sum += (now.getTime() - value.getTime()) / DAY_MS;
    count += 1;
  }
  return count === 0 ? null : Math.round((sum / count) * 10) / 10;
}

/** Independently computed (not copied from the service under test) per the documented formula. */
function referenceUpdatedModifiedDiagnostics(
  pairs: Array<{ updated: Date | null; modified: Date | null }>
): { modifiedBeforeUpdated: number; diffHoursAvg: number | null } {
  let modifiedBeforeUpdated = 0;
  let sum = 0;
  let count = 0;
  for (const { updated, modified } of pairs) {
    if (updated === null || modified === null) continue;
    sum += (updated.getTime() - modified.getTime()) / HOUR_MS;
    count += 1;
    if (modified > updated) modifiedBeforeUpdated += 1;
  }
  return { modifiedBeforeUpdated, diffHoursAvg: count === 0 ? null : Math.round((sum / count) * 10) / 10 };
}

describe("loadAggregatedFreshnessMetrics — boundary semantics", () => {
  it("classifies every boundary row into the bucket resolveFreshnessBucket predicts", async () => {
    const total = await countInDepartment(DEPT_BOUNDARY);
    const result = await loadAggregatedFreshnessMetrics({
      where: departmentWhere(DEPT_BOUNDARY),
      now: NOW,
      total,
    });

    const expectedCounts = new Map<DataFreshnessBucket, number>(
      DATA_FRESHNESS_BUCKETS.map((bucket) => [bucket, 0])
    );
    for (const row of boundaryRows) {
      const bucket = resolveFreshnessBucket(row.sourceUpdatedAt, NOW);
      expectedCounts.set(bucket, (expectedCounts.get(bucket) ?? 0) + 1);
    }

    for (const bucket of DATA_FRESHNESS_BUCKETS) {
      const actual = result.metrics.buckets.find((b) => b.bucket === bucket)?.count;
      expect(actual, bucket).toBe(expectedCounts.get(bucket));
    }

    // now+1h, now, now-(1d-1ms) -> fresh_1d
    expect(expectedCounts.get("fresh_1d")).toBe(3);
    // now-1d exactly, now-1d-1ms -> stale_1_3d
    expect(expectedCounts.get("stale_1_3d")).toBe(2);
    // now-3d exactly, now-3d-1ms -> stale_3_7d
    expect(expectedCounts.get("stale_3_7d")).toBe(2);
    // now-7d exactly, now-7d-1ms -> stale_7d_plus
    expect(expectedCounts.get("stale_7d_plus")).toBe(2);
    expect(expectedCounts.get("missing")).toBe(1);

    const sumOfBuckets = result.metrics.buckets.reduce((sum, b) => sum + b.count, 0);
    expect(sumOfBuckets).toBe(total);
    expect(result.metrics.missingUpdatedAt).toBe(1);
  });

  it("matches drill-down (listComplaints) totals for every bucket", async () => {
    const base = new URLSearchParams({ department: DEPT_BOUNDARY });
    for (const bucket of DATA_FRESHNESS_BUCKETS) {
      const params = new URLSearchParams(base);
      params.set("dataFreshnessBucket", bucket);
      const list = await listComplaints(params, { now: NOW });
      const total = await countInDepartment(DEPT_BOUNDARY);
      const result = await loadAggregatedFreshnessMetrics({
        where: departmentWhere(DEPT_BOUNDARY),
        now: NOW,
        total,
      });
      const metricCount = result.metrics.buckets.find((b) => b.bucket === bucket)?.count;
      expect(list.pagination.total, bucket).toBe(metricCount);
    }
  });

  it("represents an already-scoped dataFreshnessBucket base query as a single non-zero bucket", async () => {
    const params = new URLSearchParams({ department: DEPT_BOUNDARY, dataFreshnessBucket: "stale_7d_plus" });
    const where = buildComplaintWhere(parseComplaintQuery(params), NOW);
    const total = await prisma!.complaint.count({ where });
    expect(total).toBe(2);

    const result = await loadAggregatedFreshnessMetrics({ where, now: NOW, total });

    for (const bucket of result.metrics.buckets) {
      if (bucket.bucket === "stale_7d_plus") {
        expect(bucket.count).toBe(total);
      } else {
        expect(bucket.count, bucket.bucket).toBe(0);
      }
    }
  });
});

describe("loadAggregatedFreshnessMetrics — weighted average age", () => {
  it("weights by actual complaint count per timestamp, excludes null from the denominator", async () => {
    const total = await countInDepartment(DEPT_AVG_AGE);
    const result = await loadAggregatedFreshnessMetrics({
      where: departmentWhere(DEPT_AVG_AGE),
      now: NOW,
      total,
    });

    const expected = referenceWeightedAverageAgeDays(
      avgAgeRows.map((r) => r.sourceUpdatedAt),
      NOW
    );
    expect(expected).toBe(2.3); // (1 + 3 + 3) / 3, NOT (1 + 3) / 2 = 2.0
    expect(result.metrics.averageAgeDays).toBe(expected);
    expect(result.metrics.lastSourceUpdatedAt).toBe(new Date(NOW.getTime() - DAY_MS).toISOString());
    expect(result.metrics.oldestSourceUpdatedAt).toBe(new Date(NOW.getTime() - 3 * DAY_MS).toISOString());
    expect(result.metrics.missingUpdatedAt).toBe(1);
  });
});

describe("loadAggregatedFreshnessMetrics — updated/modified diagnostics", () => {
  it("computes signed diff-hours average and modifiedBeforeUpdated per legacy semantics", async () => {
    const total = await countInDepartment(DEPT_DIAGNOSTICS);
    const result = await loadAggregatedFreshnessMetrics({
      where: departmentWhere(DEPT_DIAGNOSTICS),
      now: NOW,
      total,
    });

    const allPairs = [
      ...diagnosticsRows.map((r) => ({ updated: r.sourceUpdatedAt, modified: r.sourceModifiedAt })),
      ...weightedPairRows.map((r) => ({ updated: r.sourceUpdatedAt, modified: r.sourceModifiedAt })),
    ];
    const expected = referenceUpdatedModifiedDiagnostics(allPairs);

    // diag-1 (+1h), diag-2 (-1h), 100x weighted-common (+1h), 1x weighted-outlier (-1h)
    // -> modifiedBeforeUpdated = diag-2 + weighted-outlier = 2 (not 1: proves the
    // 100-row group isn't collapsed into a single counted row).
    expect(expected.modifiedBeforeUpdated).toBe(2);
    expect(result.metrics.modifiedBeforeUpdated).toBe(expected.modifiedBeforeUpdated);
    expect(result.metrics.updatedVsModifiedDiffHoursAvg).toBe(expected.diffHoursAvg);

    // missingModifiedAt counts diag-3 and diag-5 (modified === null); diag-4 has
    // sourceUpdatedAt === null but sourceModifiedAt present, so it is NOT missing-modified.
    expect(result.metrics.missingModifiedAt).toBe(2);
  });

  it("never uses Math.abs on the diff-hours average — a net-negative scope stays negative", async () => {
    const total = await countInDepartment(DEPT_NEGATIVE_DIFF);
    const result = await loadAggregatedFreshnessMetrics({
      where: departmentWhere(DEPT_NEGATIVE_DIFF),
      now: NOW,
      total,
    });
    // (-2 + -2 + 1) / 3 = -1.0. An accidental Math.abs() would flip this to
    // +1.0 — unlike a positive-leaning scope, abs() cannot leave this value
    // unchanged, so this genuinely detects the regression the earlier
    // (now-removed) positive-only assertion could not.
    expect(result.metrics.updatedVsModifiedDiffHoursAvg).toBe(-1);
    expect(result.metrics.modifiedBeforeUpdated).toBe(2);
  });
});

describe("loadAggregatedFreshnessMetrics — fixed query count", () => {
  it("issues exactly 8 Prisma queries at 10 rows and at 1000 rows alike", async () => {
    const smallTotal = await countInDepartment(DEPT_QUERY_COUNT_SMALL);
    expect(smallTotal).toBe(10);
    const smallResult = await loadAggregatedFreshnessMetrics({
      where: departmentWhere(DEPT_QUERY_COUNT_SMALL),
      now: NOW,
      total: smallTotal,
    });
    expect(smallResult.prismaQueries).toBe(8);

    const largeTotal = await countInDepartment(DEPT_QUERY_COUNT_LARGE);
    expect(largeTotal).toBe(1000);
    const largeResult = await loadAggregatedFreshnessMetrics({
      where: departmentWhere(DEPT_QUERY_COUNT_LARGE),
      now: NOW,
      total: largeTotal,
    });
    expect(largeResult.prismaQueries).toBe(8);
    expect(largeResult.prismaQueries).toBe(smallResult.prismaQueries);
  });
});

describe("loadAggregatedFreshnessMetrics — actual SQL query events (not derived arithmetic)", () => {
  /**
   * `result.prismaQueries` (tested above) is metadata the service computes
   * about itself — it would report 8 even if the implementation issued a
   * different number of real queries. This measures actual Prisma "query"
   * events fired against a real PrismaClient, via loadAggregatedFreshnessMetrics'
   * injectable client parameter (production code is unaffected — it still
   * calls the function with no second argument and gets the default `db`).
   */
  async function countRealQueries(where: Prisma.ComplaintWhereInput, total: number): Promise<number> {
    const measuredClient = new PrismaClient({
      datasources: { db: { url: testDatabaseUrl } },
      log: [{ emit: "event", level: "query" }],
    });
    let queryCount = 0;
    (measuredClient as unknown as { $on: (event: "query", cb: () => void) => void }).$on(
      "query",
      () => {
        queryCount += 1;
      }
    );

    try {
      // All setup (seeding, count-for-total) already happened in beforeAll /
      // the caller — queryCount starts at 0 for this fresh client and only
      // counts what loadAggregatedFreshnessMetrics itself issues.
      await loadAggregatedFreshnessMetrics({ where, now: NOW, total }, measuredClient);
      return queryCount;
    } finally {
      await measuredClient.$disconnect();
    }
  }

  it("fires exactly 8 real SQL queries at 10 rows and at 1000 rows, measured independently per scope", async () => {
    const smallTotal = await countInDepartment(DEPT_QUERY_COUNT_SMALL);
    const smallQueryCount = await countRealQueries(departmentWhere(DEPT_QUERY_COUNT_SMALL), smallTotal);
    expect(smallQueryCount).toBe(8);

    const largeTotal = await countInDepartment(DEPT_QUERY_COUNT_LARGE);
    const largeQueryCount = await countRealQueries(departmentWhere(DEPT_QUERY_COUNT_LARGE), largeTotal);
    expect(largeQueryCount).toBe(8);

    expect(largeQueryCount).toBe(smallQueryCount);
  });
});
