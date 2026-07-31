#!/usr/bin/env tsx
// Cleans up expired AI analysis results.
// Supports --dry-run to preview without deleting.
// Never deletes AuditLog or Run metadata.
// All mutations are transactional: result soft-delete and audit log are atomic.

import { PrismaClient, Prisma } from "@prisma/client";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

const db = new PrismaClient();

async function processExpiredRun(
  run: {
    id: string;
    analysisType: string;
    expiresAt: Date | null;
    result: { id: string } | null;
    feedbacks: { id: string }[];
  },
  now: Date
): Promise<void> {
  if (!run.result) return;

  if (dryRun) {
    console.log(
      `[DRY RUN] Would expire result for run ${run.id}` +
      ` (${run.analysisType}, expired ${run.expiresAt?.toISOString() ?? "unknown"})`
    );
    return;
  }

  // All mutations in a single transaction — result soft-delete and audit log are atomic
  await db.$transaction([
    db.aiAnalysisResult.update({
      where: { id: run.result.id },
      data: { deletedAt: now },
    }),
    // Redact user-controlled content from the run record itself.
    // Keep: id, analysisType, status, timestamps, actor metadata, audit trail.
    // Remove: filters, input summary, error details (may contain complaint data).
    db.aiAnalysisRun.update({
      where: { id: run.id },
      data: {
        filtersSnapshot: Prisma.JsonNull,
        inputSummary: Prisma.JsonNull,
        errorCode: null,
        errorMessage: null,
      },
    }),
    db.auditLog.create({
      data: {
        action: "AI_RESULT_EXPIRED_CLEANED",
        entityType: "AiAnalysisResult",
        entityId: run.result.id,
        actor: "system",
        metadata: {
          analysisRunId: run.id,
          expiredAt: run.expiresAt?.toISOString() ?? null,
        },
      },
    }),
  ]);

  // Redact feedback comments separately (feedback IDs are independent records)
  if (run.feedbacks.length > 0) {
    await db.aiFeedback.updateMany({
      where: { analysisRunId: run.id, comment: { not: null } },
      data: { comment: null },
    });
  }

  console.log(`Expired result and redacted content for run ${run.id}`);
}

async function main() {
  console.log(dryRun ? "AI Cleanup (DRY RUN)" : "AI Cleanup");

  const now = new Date();

  const expiredRuns = await db.aiAnalysisRun.findMany({
    where: {
      expiresAt: { lt: now },
      result: { deletedAt: null },
    },
    select: {
      id: true,
      analysisType: true,
      expiresAt: true,
      result: { select: { id: true } },
      feedbacks: { select: { id: true } },
    },
    take: 200,
  });

  console.log(`Found ${expiredRuns.length} expired AI results`);

  if (expiredRuns.length === 0) {
    console.log("Nothing to clean up.");
    await db.$disconnect();
    return;
  }

  let processed = 0;
  let failed = 0;
  for (const run of expiredRuns) {
    try {
      await processExpiredRun(run, now);
      processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 200) : "Unknown error";
      console.error(`Failed to process run ${run.id}: ${msg}`);
      failed++;
    }
  }

  // Also note old failed runs (metadata retained for audit trail)
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const oldFailedRuns = await db.aiAnalysisRun.count({
    where: { status: "FAILED", createdAt: { lt: thirtyDaysAgo } },
  });
  if (oldFailedRuns > 0) {
    console.log(`Note: ${oldFailedRuns} old failed runs found (metadata kept for audit trail)`);
  }

  if (!dryRun) {
    const failedSuffix = failed > 0 ? ` ${failed} failed.` : "";
    console.log(`\nAI cleanup complete. ${processed} results expired.${failedSuffix}`);
  } else {
    console.log(`\n[DRY RUN] Would expire ${expiredRuns.length} results.`);
  }

  await db.$disconnect();
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : "Unknown error";
  console.error("AI cleanup failed:", msg);
  process.exit(1);
});
