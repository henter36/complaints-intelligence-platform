#!/usr/bin/env tsx
// Database and storage integrity check.
// Read-only — never modifies data.

import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");

const db = new PrismaClient();
const ROOT = path.resolve(__dirname, "..");
const REPORT_STORAGE = process.env.REPORT_STORAGE_PATH ?? "./storage/reports";

interface CheckResult {
  name: string;
  status: "ok" | "warn" | "error";
  detail?: string;
  count?: number;
}

function makeOk(name: string, detail?: string, count?: number): CheckResult {
  return { name, status: "ok", detail, count };
}

function makeWarn(name: string, detail: string, count?: number): CheckResult {
  return { name, status: "warn", detail, count };
}

function makeError(name: string, detail: string, count?: number): CheckResult {
  return { name, status: "error", detail, count };
}

function resolveResultSymbol(result: CheckResult): string {
  if (result.status === "ok") return "✓";
  if (result.status === "warn") return "⚠";
  return "✗";
}

// Keep old name as alias so callers don't break
const statusSymbol = resolveResultSymbol;

async function checkDatabaseConnection(): Promise<CheckResult> {
  try {
    await db.$queryRaw`SELECT 1`;
    return makeOk("database_connection");
  } catch (err) {
    return makeError("database_connection", String(err));
  }
}

async function checkAdminCredential(): Promise<CheckResult> {
  const adminCount = await db.adminCredential.count();
  if (adminCount === 0) return makeWarn("admin_credential", "No admin credential found");
  if (adminCount > 1) return makeError("admin_credential", `Multiple admin credentials: ${adminCount}`);
  return makeOk("admin_credential");
}

async function checkComplaintBatchStatus(): Promise<CheckResult> {
  const badComplaints = await db.complaint.count({
    where: {
      isDeleted: false,
      importBatchId: { not: null },
      importBatch: { status: { notIn: ["CONFIRMED"] } },
    },
  });
  if (badComplaints > 0) {
    return makeWarn("complaints_batch_status", `${badComplaints} complaints linked to non-confirmed batches`, badComplaints);
  }
  return makeOk("complaints_batch_status");
}

async function checkImportBatchCounters(): Promise<CheckResult> {
  const batches = await db.importBatch.findMany({
    where: { status: "CONFIRMED" },
    select: { id: true, totalRows: true, rows: { select: { id: true } } },
  });
  let batchMismatches = 0;
  for (const b of batches) {
    if (b.rows.length !== b.totalRows && b.totalRows > 0) batchMismatches++;
  }
  if (batchMismatches > 0) {
    return makeWarn("import_batch_counters", `${batchMismatches} batches with row count mismatch`, batchMismatches);
  }
  return makeOk("import_batch_counters", undefined, batches.length);
}

async function checkSoftDeleteConsistency(): Promise<CheckResult> {
  const deletedActive = await db.complaint.count({
    where: { isDeleted: true, status: { notIn: ["CLOSED", "CANCELLED"] } },
  });
  if (deletedActive > 0) {
    return makeWarn("soft_delete_consistency", `${deletedActive} soft-deleted complaints with active status`, deletedActive);
  }
  return makeOk("soft_delete_consistency");
}

const ARTIFACT_BATCH_SIZE = 200;

async function* iterateActiveArtifacts() {
  let cursor: string | undefined;
  while (true) {
    const batch = await db.reportArtifact.findMany({
      where: { deletedAt: null },
      orderBy: { id: "asc" },
      select: { id: true, storageKey: true, sha256: true },
      take: ARTIFACT_BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (batch.length === 0) return;
    yield batch;
    cursor = batch.at(-1)?.id;
    if (batch.length < ARTIFACT_BATCH_SIZE) return;
  }
}

async function checkReportArtifactFiles(): Promise<CheckResult> {
  let missingArtifacts = 0;
  let total = 0;

  for await (const batch of iterateActiveArtifacts()) {
    for (const a of batch) {
      total++;
      const filePath = path.join(ROOT, REPORT_STORAGE, a.storageKey);
      if (!fs.existsSync(filePath)) missingArtifacts++;
    }
  }

  if (missingArtifacts > 0) {
    return makeWarn("report_artifact_files", `${missingArtifacts} artifact files missing`, missingArtifacts);
  }
  return makeOk("report_artifact_files", undefined, total);
}

async function checkReportArtifactHashes(): Promise<CheckResult> {
  let hashMismatches = 0;

  for await (const batch of iterateActiveArtifacts()) {
    for (const a of batch) {
      const filePath = path.join(ROOT, REPORT_STORAGE, a.storageKey);
      if (!fs.existsSync(filePath)) continue;
      if (!a.sha256) continue;
      const hash = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
      if (hash !== a.sha256) hashMismatches++;
    }
  }

  if (hashMismatches > 0) {
    return makeError("report_artifact_hashes", `${hashMismatches} artifact hash mismatches`, hashMismatches);
  }
  return makeOk("report_artifact_hashes");
}

async function checkReportRunConsistency(): Promise<CheckResult> {
  const failedRunsWithArtifacts = await db.reportRun.count({
    where: { status: "FAILED", artifacts: { some: { deletedAt: null } } },
  });
  if (failedRunsWithArtifacts > 0) {
    return makeWarn("report_run_artifact_consistency", `${failedRunsWithArtifacts} failed runs with active artifacts`, failedRunsWithArtifacts);
  }
  return makeOk("report_run_artifact_consistency");
}

async function checkExpiredSessions(): Promise<CheckResult> {
  const expiredActive = await db.adminSession.count({
    where: { expiresAt: { lt: new Date() }, revokedAt: null },
  });
  if (expiredActive > 0) {
    return makeWarn("expired_sessions", `${expiredActive} expired but not revoked sessions`, expiredActive);
  }
  return makeOk("expired_sessions");
}

async function checkOrphanSnapshots(): Promise<CheckResult> {
  const orphanSnapshots = await db.importChangeSnapshot.count({
    where: { importBatchRow: { importBatch: { status: { notIn: ["CONFIRMED", "ROLLED_BACK"] } } } },
  });
  if (orphanSnapshots > 0) {
    return makeWarn("orphan_snapshots", `${orphanSnapshots} snapshots in non-final batches`, orphanSnapshots);
  }
  return makeOk("orphan_snapshots");
}

async function checkAiRetention(): Promise<CheckResult> {
  const expiredAiRuns = await db.aiAnalysisRun.count({
    where: { expiresAt: { lt: new Date() }, result: { deletedAt: null } },
  });
  if (expiredAiRuns > 0) {
    return makeWarn("ai_retention", `${expiredAiRuns} AI results past expiry (run ai:cleanup)`, expiredAiRuns);
  }
  return makeOk("ai_retention");
}

// Run a check and catch unexpected errors — returns an explicit failure result
// so subsequent checks continue even if one throws.
async function safeRun(check: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await check();
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 200) : "Unexpected check error";
    return makeError(check.name, msg);
  }
}

async function runAllChecks(): Promise<CheckResult[]> {
  const dbResult = await safeRun(checkDatabaseConnection);

  // When DB is unreachable, pass the failure through to the common reporter
  // rather than returning early and bypassing it. exitCode is set by the caller.
  if (dbResult.status === "error") {
    return [dbResult];
  }

  const checks = [
    checkAdminCredential,
    checkComplaintBatchStatus,
    checkImportBatchCounters,
    checkSoftDeleteConsistency,
    checkReportArtifactFiles,
    checkReportArtifactHashes,
    checkReportRunConsistency,
    checkExpiredSessions,
    checkOrphanSnapshots,
    checkAiRetention,
  ];

  const results: CheckResult[] = [dbResult];
  for (const check of checks) {
    results.push(await safeRun(check));
  }
  return results;
}

function exitCodeForResults(results: CheckResult[]): number {
  return results.some(r => r.status === "error") ? 1 : 0;
}

async function run() {
  let results: CheckResult[] = [];
  try {
    results = await runAllChecks();
  } finally {
    await db.$disconnect();
  }

  const errorCount = results.filter(r => r.status === "error").length;
  const warnCount = results.filter(r => r.status === "warn").length;
  const okCount = results.filter(r => r.status === "ok").length;

  if (jsonOutput) {
    console.log(JSON.stringify({ results, errors: errorCount, warns: warnCount, ok: okCount }, null, 2));
  } else {
    console.log("\nIntegrity Check Results:");
    console.log("═".repeat(60));
    for (const r of results) {
      const icon = resolveResultSymbol(r);
      const suffix = r.detail ? ` — ${r.detail}` : r.count !== undefined ? ` (${r.count})` : "";
      console.log(`${icon} ${r.name}${suffix}`);
    }
    console.log("═".repeat(60));
    console.log(`${okCount} OK  |  ${warnCount} warnings  |  ${errorCount} errors`);
  }

  // Use exitCode (not process.exit) so the finally block above always runs
  process.exitCode = exitCodeForResults(results);
}

run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : "Unknown error";
  console.error("Integrity check failed:", msg);
  process.exitCode = 1;
});
