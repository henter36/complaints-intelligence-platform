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
}) {
  let count = 0;
  for (const method of ["findMany", "groupBy", "count"] as const) {
    const original = client.complaint[method]!.bind(client.complaint);
    client.complaint[method] = async (...args: unknown[]) => {
      count += 1;
      return original(...args);
    };
  }
  return () => count;
}

async function seedSynthetic(prisma: PrismaClient, size: number): Promise<void> {
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
  const now = Date.now();

  for (let offset = 0; offset < size; offset += batchSize) {
    const chunk = Math.min(batchSize, size - offset);
    const rows = Array.from({ length: chunk }, (_, index) => {
      const i = offset + index;
      const closed = i % 5 !== 0;
      const receivedAt = new Date(now - (i % 400) * 24 * 60 * 60 * 1000);
      return {
        externalId: `bench-${size}-${i}`,
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
        dueDate: closed ? null : new Date(receivedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
        closedAt: closed ? new Date(receivedAt.getTime() + ((i % 10) + 1) * 24 * 60 * 60 * 1000) : null,
        sourceUpdatedAt: new Date(receivedAt.getTime() + 60 * 60 * 1000),
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
  if (process.env.DATABASE_URL && isDevDbUrl(process.env.DATABASE_URL)) {
    throw new Error("Refusing synthetic seed against prisma/dev.db");
  }

  const tempDir = mkdtempSync(join(tmpdir(), "op-analytics-synth-"));
  const dbPath = join(tempDir, "synthetic.db");
  const databaseUrl = `file:${dbPath}`;
  runPrismaMigrateDeploy(databaseUrl);
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    await seedSynthetic(prisma, size);
  } finally {
    await prisma.$disconnect();
  }
  return { databaseUrl, tempDir, size };
}

async function main() {
  const mode = resolveMode();
  const prepared = await prepareDatabase(mode);
  process.env.DATABASE_URL = prepared.databaseUrl;

  const { getOperationalAnalytics } = await import(
    "../src/server/analytics/operational/operational-analytics-service"
  );
  const { db } = await import("../src/lib/db");
  const rowCount = await db.complaint.count({ where: { isDeleted: false } });
  const preflightQueries = 1;
  const getQueryCount = installQueryCounter(db as never);
  // Counts queries issued by getOperationalAnalytics only.
  const params = new URLSearchParams(argValue("params") ?? "");
  const heapBefore = process.memoryUsage();
  const t0 = performance.now();
  const result = await getOperationalAnalytics(params, {
    now: new Date("2026-08-05T12:00:00.000Z"),
  });
  const totalMs = Math.round(performance.now() - t0);
  const heapAfter = process.memoryUsage();
  const prismaQueries = getQueryCount();

  let sourceShaAfter: string | undefined;
  if (prepared.sourcePath && prepared.sourceSha) {
    sourceShaAfter = sha256File(prepared.sourcePath);
  }

  const report = {
    mode,
    params: params.toString(),
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

  if (prepared.tempDir) {
    rmSync(prepared.tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
