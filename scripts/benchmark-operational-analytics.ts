#!/usr/bin/env tsx
/**
 * Benchmark operational analytics (Issue #59 phase 1).
 *
 * Modes:
 *   --mode=read-only-current  Measure against an explicit DATABASE_URL (copy of production/dev data).
 *   --mode=synthetic          Create a temporary DB and seed --size rows (default 20000).
 *
 * Safety:
 *   - Requires DATABASE_URL for read-only-current.
 *   - Synthetic mode refuses to seed when DATABASE_URL points at prisma/dev.db.
 *   - Read-only-current never writes to the source file (uses a temp copy when source is a file: URL).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ComplaintPriority, ComplaintStatus, PrismaClient } from "@prisma/client";
import { withPreparedBenchmark } from "./lib/benchmark-lifecycle";
import {
  copyConsistentSqliteSnapshot,
} from "./lib/benchmark-sqlite-snapshot";
import { isDevDbUrl } from "./lib/benchmark-paths";
import { runPrismaMigrateDeploy } from "./lib/prisma-cli-runner";

type Mode = "read-only-current" | "synthetic";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function resolveMode(): Mode {
  const mode = (argValue("mode") ?? "read-only-current") as Mode;
  if (mode !== "read-only-current" && mode !== "synthetic") {
    throw new Error(`Unsupported mode: ${mode}`);
  }
  return mode;
}

function filePathFromUrl(url: string): string | null {
  if (!url.startsWith("file:")) return null;
  return url.replace(/^file:/, "");
}

function installQueryCounter(client: {
  complaint: Record<string, (...args: unknown[]) => Promise<unknown>>;
  classification?: Record<string, (...args: unknown[]) => Promise<unknown>>;
}) {
  let count = 0;
  for (const method of ["findMany", "groupBy", "count"] as const) {
    const original = client.complaint[method]!.bind(client.complaint);
    client.complaint[method] = async (...args: unknown[]) => {
      count += 1;
      return original(...args);
    };
  }
  if (client.classification?.findMany) {
    const original = client.classification.findMany.bind(client.classification);
    client.classification.findMany = async (...args: unknown[]) => {
      count += 1;
      return original(...args);
    };
  }
  return () => count;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Fixed "now" for both seeding math and the benchmarked getOperationalAnalytics call, so
 *  freshness bucket distribution is deterministic regardless of when the script runs. */
export const BENCHMARK_NOW = new Date("2026-08-05T12:00:00.000Z");

type Cardinality = "normal" | "high";

/**
 * Deterministically places row `i` in one of the 5 freshness buckets
 * (i % 5) and returns a sourceUpdatedAt landing in that bucket.
 *   - normal cardinality: timestamps repeat in chunks of 200 within a bucket
 *     (simulates realistic import batches sharing an update run).
 *   - high cardinality: every row gets its own millisecond-unique timestamp,
 *     stressing the groupBy(sourceUpdatedAt) cardinality (Issue #63 phase 3
 *     stop-condition check — see docs/performance/operational-analytics-phase3-freshness.md).
 */
function sourceUpdatedAtForRow(i: number, cardinality: Cardinality): Date | null {
  const bucket = i % 5;
  if (bucket === 4) return null; // missing

  // Bounded well under the tightest bucket margin (fresh_1d's 12h base sits
  // 12h from its 24h boundary) so the offset can never push a row into the
  // next, older bucket — regardless of dataset size.
  const offsetMs =
    cardinality === "high"
      ? (i * 400) % 40_000_000 // ~unique per row up to ~100k rows/bucket (500k rows / 5 buckets)
      : (Math.floor(i / 200) % 100) * 300_000; // ~100 repeated groups, 5 minutes apart

  if (bucket === 0) return new Date(BENCHMARK_NOW.getTime() - 12 * HOUR_MS - offsetMs); // fresh_1d
  if (bucket === 1) return new Date(BENCHMARK_NOW.getTime() - 2 * DAY_MS - offsetMs); // stale_1_3d
  if (bucket === 2) return new Date(BENCHMARK_NOW.getTime() - 5 * DAY_MS - offsetMs); // stale_3_7d
  return new Date(BENCHMARK_NOW.getTime() - 10 * DAY_MS - offsetMs); // stale_7d_plus
}

/**
 * sourceModifiedAt variety: ~30% missing, ~10% modified after updated
 * (exercises modifiedBeforeUpdated), ~60% modified before/at updated.
 */
function sourceModifiedAtForRow(i: number, sourceUpdatedAt: Date | null): Date | null {
  if (sourceUpdatedAt === null) return null;
  const bucket = i % 10;
  if (bucket < 3) return null; // ~30% missing
  if (bucket < 4) return new Date(sourceUpdatedAt.getTime() + 2 * HOUR_MS); // ~10% modified after updated
  return new Date(sourceUpdatedAt.getTime() - ((i % 5) + 1) * HOUR_MS); // ~60% modified before updated
}

async function seedSynthetic(
  prisma: PrismaClient,
  size: number,
  cardinality: Cardinality
): Promise<void> {
  const category = await prisma.category.create({
    data: { nameAr: `benchmark-cat-${Date.now()}`, isActive: true },
  });
  const classification = await prisma.classification.create({
    data: {
      categoryId: category.id,
      nameAr: "مواعيد",
      isActive: true,
    },
  });

  const origins = ["الجهاز الرئيسي", "منصة إلكترونية", "main", null, ""];
  const statuses = ["مغلقة", "مبدئي", null, ""];
  const actionStatuses = ["منتهية", "جديد", null, ""];
  const channels = ["الهاتف", "المنصة", "البريد", null];
  const batchSize = 1000;
  const now = BENCHMARK_NOW.getTime();

  for (let offset = 0; offset < size; offset += batchSize) {
    const chunk = Math.min(batchSize, size - offset);
    const rows = Array.from({ length: chunk }, (_, index) => {
      const i = offset + index;
      const closed = i % 5 !== 0;
      const receivedAt = new Date(now - (i % 400) * DAY_MS);
      const sourceUpdatedAt = sourceUpdatedAtForRow(i, cardinality);
      return {
        externalId: `bench-${size}-${cardinality}-${i}`,
        subject: `Benchmark ${i}`,
        status: closed ? ComplaintStatus.CLOSED : ComplaintStatus.OPEN,
        priority: ComplaintPriority.MEDIUM,
        severity: ComplaintPriority.MEDIUM,
        sourceOrigin: origins[i % origins.length] ?? null,
        sourceStatus: statuses[i % statuses.length] ?? null,
        sourceActionStatus: actionStatuses[i % actionStatuses.length] ?? null,
        channel: channels[i % channels.length] ?? null,
        region: i % 2 === 0 ? "الرياض" : "مكة",
        facility: i % 3 === 0 ? "مستشفى أ" : "مستشفى ب",
        department: i % 2 === 0 ? "الطوارئ" : "العيادات",
        wingCode: i % 7 === 0 ? null : `W${(i % 5) + 1}`,
        classificationId: classification.id,
        complaintDate: receivedAt,
        receivedAt,
        dueDate: closed ? null : new Date(receivedAt.getTime() + 7 * DAY_MS),
        closedAt: closed ? new Date(receivedAt.getTime() + ((i % 10) + 1) * DAY_MS) : null,
        sourceUpdatedAt,
        sourceModifiedAt: sourceModifiedAtForRow(i, sourceUpdatedAt),
        isDeleted: false,
      };
    });
    await prisma.complaint.createMany({ data: rows });
  }
}

async function prepareDatabase(mode: Mode): Promise<{
  databaseUrl: string;
  sourceSha?: string;
  sourcePath?: string;
  tempDir?: string;
  size?: number;
}> {
  if (mode === "read-only-current") {
    const databaseUrl = process.env.DATABASE_URL ?? argValue("database-url");
    if (!databaseUrl) {
      throw new Error("read-only-current requires DATABASE_URL or --database-url=");
    }
    const sourcePath = filePathFromUrl(databaseUrl);
    if (!sourcePath) {
      return { databaseUrl };
    }
    const absolute = resolve(sourcePath);
    if (!existsSync(absolute)) {
      throw new Error(`SQLite source file not found: ${absolute}`);
    }
    const snapshot = copyConsistentSqliteSnapshot({
      sourcePath: absolute,
      tempPrefix: "op-analytics-bench-",
      hashFile: sha256File,
    });
    return {
      databaseUrl: `file:${snapshot.copyPath}`,
      sourceSha: snapshot.sourceSha,
      sourcePath: absolute,
      tempDir: snapshot.tempDir,
    };
  }

  const size = Number(argValue("size") ?? "20000");
  if (![20_000, 100_000, 500_000].includes(size) && !hasFlag("allow-custom-size")) {
    throw new Error("synthetic --size must be 20000, 100000, or 500000 (or pass --allow-custom-size)");
  }
  const cardinality = (argValue("cardinality") ?? "normal") as Cardinality;
  if (cardinality !== "normal" && cardinality !== "high") {
    throw new Error("--cardinality must be normal or high");
  }
  if (process.env.DATABASE_URL && isDevDbUrl(process.env.DATABASE_URL)) {
    throw new Error("Refusing synthetic seed against prisma/dev.db");
  }

  const tempDir = mkdtempSync(join(tmpdir(), "op-analytics-synth-"));
  const dbPath = join(tempDir, "synthetic.db");
  const databaseUrl = `file:${dbPath}`;

  try {
    runPrismaMigrateDeploy(databaseUrl);
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      await seedSynthetic(prisma, size, cardinality);
    } finally {
      await prisma.$disconnect();
    }
    return { databaseUrl, tempDir, size };
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  const mode = resolveMode();
  const prepared = await prepareDatabase(mode);
  const originalDatabaseUrl = process.env.DATABASE_URL;

  let benchmarkDb: typeof import("../src/lib/db").db | null = null;

  await withPreparedBenchmark({
    tempDir: prepared.tempDir,
    originalDatabaseUrl,
    disconnect: async () => {
      await benchmarkDb?.$disconnect();
    },
    run: async () => {
      process.env.DATABASE_URL = prepared.databaseUrl;

      const {
        getOperationalAnalytics,
        RESIDUAL_OPERATIONAL_SELECT,
      } = await import("../src/server/analytics/operational/operational-analytics-service");
      const { loadAggregatedFreshnessMetrics } = await import(
        "../src/server/analytics/operational/operational-freshness-aggregate-service"
      );
      const { buildComplaintWhere, parseComplaintQuery } = await import(
        "../src/server/complaints/complaint-query-service"
      );
      const dbModule = await import("../src/lib/db");
      benchmarkDb = dbModule.db;

      const rowCount = await benchmarkDb.complaint.count({ where: { isDeleted: false } });
      const preflightQueries = 1;
      const getQueryCount = installQueryCounter(benchmarkDb as never);
      // Counts queries issued by getOperationalAnalytics only.
      const params = new URLSearchParams(argValue("params") ?? "");
      const heapBefore = process.memoryUsage();
      const t0 = performance.now();
      const result = await getOperationalAnalytics(params, {
        now: BENCHMARK_NOW,
      });
      const totalMs = Math.round(performance.now() - t0);
      const heapAfter = process.memoryUsage();
      const prismaQueries = getQueryCount();

      // Isolated freshness-only measurement (diagnostics — never surfaced
      // through OperationalAnalyticsSummary). Reuses the same where/now/total
      // getOperationalAnalytics used internally, with its own query counter
      // so it doesn't double-count against `prismaQueries` above.
      const freshnessQueryCounter = installQueryCounter(benchmarkDb as never);
      const where = buildComplaintWhere(parseComplaintQuery(params), BENCHMARK_NOW);
      const freshnessHeapBefore = process.memoryUsage();
      const freshnessResult = await loadAggregatedFreshnessMetrics({
        where,
        now: BENCHMARK_NOW,
        total: result.totalInScope,
      });
      const freshnessHeapAfter = process.memoryUsage();
      const freshnessDiagnostics = {
        ms: freshnessResult.performanceMs,
        queries: freshnessResult.prismaQueries,
        queriesMeasured: freshnessQueryCounter(),
        updatedTimestampGroupCount: freshnessResult.updatedTimestampGroupCount,
        updatedModifiedPairGroupCount: freshnessResult.updatedModifiedPairGroupCount,
        totalRows: result.totalInScope,
        updatedGroupToRowRatio:
          result.totalInScope > 0
            ? Math.round((freshnessResult.updatedTimestampGroupCount / result.totalInScope) * 1000) / 1000
            : 0,
        pairGroupToRowRatio:
          result.totalInScope > 0
            ? Math.round((freshnessResult.updatedModifiedPairGroupCount / result.totalInScope) * 1000) / 1000
            : 0,
        heapDeltaMB: Math.round((freshnessHeapAfter.heapUsed - freshnessHeapBefore.heapUsed) / 1024 / 1024),
      };

      let sourceShaAfter: string | undefined;
      if (prepared.sourcePath && prepared.sourceSha) {
        sourceShaAfter = sha256File(prepared.sourcePath);
      }

      const report = {
        mode,
        params: params.toString(),
        cardinality: argValue("cardinality") ?? "normal",
        size: prepared.size ?? rowCount,
        rowCount,
        totalInScope: result.totalInScope,
        totalMs,
        performanceMs: result.performanceMs,
        heapBeforeMB: Math.round(heapBefore.heapUsed / 1024 / 1024),
        heapAfterMB: Math.round(heapAfter.heapUsed / 1024 / 1024),
        rssBeforeMB: Math.round(heapBefore.rss / 1024 / 1024),
        rssAfterMB: Math.round(heapAfter.rss / 1024 / 1024),
        preflightQueries,
        prismaQueries,
        residualSelectFieldCount: Object.keys(RESIDUAL_OPERATIONAL_SELECT).length,
        freshnessDiagnostics,
        channelIndependentCheck: result.channelIndependentCheck,
        sourceOriginTop3: result.sourceOrigin.items.slice(0, 3).map((item) => ({
          key: item.key,
          count: item.count,
          open: item.open,
          closed: item.closed,
          currentlyLate: item.currentlyLate,
          averageResolutionDays: item.averageResolutionDays,
        })),
        sourceShaBefore: prepared.sourceSha,
        sourceShaAfter,
        sourceUnchanged:
          prepared.sourceSha && sourceShaAfter ? prepared.sourceSha === sourceShaAfter : undefined,
      };

      const outPath = argValue("out");
      const json = JSON.stringify(report, null, 2);
      console.log(json);
      if (outPath) {
        writeFileSync(outPath, `${json}\n`);
      }
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
