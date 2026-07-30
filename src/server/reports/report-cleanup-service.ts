import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/audit/audit-log-service";
import { deleteReportArtifact } from "./report-storage";

export type CleanupResult = {
  dryRun: boolean;
  candidates: { id: string; format: string; expiresAt: string }[];
  removedCount: number;
};

/**
 * Deletes the on-disk file for every ReportArtifact whose expiresAt has
 * passed and stamps deletedAt — never touches ReportRun or AuditLog rows,
 * and never removes an artifact before its expiresAt.
 */
export async function runReportsCleanup(options: { dryRun: boolean }, now: Date = new Date()): Promise<CleanupResult> {
  const expired = await db.reportArtifact.findMany({
    where: { deletedAt: null, expiresAt: { lt: now } },
    select: { id: true, storageKey: true, format: true, fileSize: true, reportRunId: true, expiresAt: true },
  });

  const candidates = expired.map((artifact) => ({
    id: artifact.id,
    format: artifact.format,
    expiresAt: artifact.expiresAt.toISOString(),
  }));

  if (options.dryRun || expired.length === 0) {
    return { dryRun: options.dryRun, candidates, removedCount: 0 };
  }

  let removedCount = 0;
  for (const artifact of expired) {
    const deletion = await deleteReportArtifact(artifact.storageKey);
    if (!deletion.deleted) {
      // Leave deletedAt unset so this artifact stays in the same
      // deletedAt:null / expiresAt<now query and is retried on the next run.
      console.error("Report artifact cleanup: failed to delete file, will retry on next run:", artifact.id, deletion.error);
      continue;
    }

    await db.reportArtifact.update({ where: { id: artifact.id }, data: { deletedAt: now } });
    await writeAuditLog(db, {
      action: "REPORT_ARTIFACT_DELETED",
      entityType: "ReportArtifact",
      entityId: artifact.id,
      actor: "system",
      metadata: { reportRunId: artifact.reportRunId, format: artifact.format, fileSize: artifact.fileSize },
    });
    removedCount += 1;
  }

  return { dryRun: false, candidates, removedCount };
}
