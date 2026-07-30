import { ReportFormat, ReportRunStatus, type Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/audit/audit-log-service";
import { env } from "@/lib/env";
import { getReportDefinition, type ReportRequest } from "./report-definition-service";
import { buildReportData, isReportRowLimitExceededError, type ReportData } from "./report-data-service";
import { renderReportPdf } from "./report-pdf-service";
import { renderReportXlsx } from "./report-xlsx-service";
import { deleteReportArtifact, storeReportArtifact } from "./report-storage";

export class ReportRunError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReportRunError";
    this.code = code;
    this.status = status;
  }
}

type CreatedArtifactReference = { id: string; storageKey: string };

type CleanupFailure = {
  artifactId: string;
  storageKey: string;
  step: "artifact_file" | "artifact_row";
  message: string;
};

type CleanupResult = {
  deletedArtifactIds: string[];
  retainedArtifactIds: string[];
  failures: CleanupFailure[];
};

export function isReportRunError(error: unknown): error is ReportRunError {
  return error instanceof ReportRunError;
}

export type RunReportInput = {
  request: ReportRequest;
  formats: ReportFormat[];
  requestedBy: string;
  reportTemplateId?: string | null;
  scheduledFor?: Date | null;
  idempotencyKey?: string | null;
};

export type RunReportResult = {
  runId: string;
  status: ReportRunStatus;
  artifacts: {
    id: string;
    format: ReportFormat;
    fileName: string;
    fileSize: number;
    sha256: string;
  }[];
  warnings: string[];
  rowCount: number;
};

const FILE_EXTENSION: Record<ReportFormat, string> = {
  PDF: "pdf",
  XLSX: "xlsx",
};

const MIME_TYPE: Record<ReportFormat, string> = {
  PDF: "application/pdf",
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function validateFormats(request: ReportRequest, formats: ReportFormat[]): void {
  if (formats.length === 0) {
    throw new ReportRunError("REPORT_NO_FORMAT_SELECTED", "يجب تحديد صيغة تصدير واحدة على الأقل", 400);
  }
  const definition = getReportDefinition(request.type);
  for (const format of formats) {
    if (format === ReportFormat.PDF && !definition.supportsPdf) {
      throw new ReportRunError("REPORT_FORMAT_UNSUPPORTED", "هذا التقرير لا يدعم التصدير كـ PDF", 422);
    }
    if (format === ReportFormat.XLSX && !definition.supportsXlsx) {
      throw new ReportRunError("REPORT_FORMAT_UNSUPPORTED", "هذا التقرير لا يدعم التصدير كـ XLSX", 422);
    }
  }
}

function safeFileBaseName(request: ReportRequest, now: Date): string {
  const datePart = now.toISOString().slice(0, 10);
  return `${request.type.toLowerCase()}-${datePart}`;
}

async function renderFormat(format: ReportFormat, data: ReportData): Promise<{ buffer: Buffer; warnings: string[] }> {
  if (format === ReportFormat.PDF) return renderReportPdf(data);
  return renderReportXlsx(data);
}

export async function runReport(input: RunReportInput, now: Date = new Date()): Promise<RunReportResult> {
  const { request, formats, requestedBy, reportTemplateId = null, scheduledFor = null, idempotencyKey = null } = input;
  validateFormats(request, formats);

  let run: { id: string };
  try {
    run = await db.reportRun.create({
      data: {
        reportTemplateId,
        reportType: request.type,
        status: ReportRunStatus.RUNNING,
        requestedBy,
        startedAt: now,
        scheduledFor,
        idempotencyKey,
        filtersSnapshot: request.filters as Prisma.InputJsonValue,
        optionsSnapshot: request.options as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  } catch (error) {
    if (isUniqueConstraintError(error, "idempotencyKey")) {
      throw new ReportRunError("REPORT_RUN_ALREADY_SCHEDULED", "تم تنفيذ هذا التشغيل مسبقاً", 409);
    }
    throw error;
  }

  await writeAuditLog(db, {
    action: "REPORT_RUN_STARTED",
    entityType: "ReportRun",
    entityId: run.id,
    actor: requestedBy,
    metadata: { reportType: request.type, templateId: reportTemplateId },
  });

  const storedKeys: string[] = [];
  const createdArtifacts: CreatedArtifactReference[] = [];

  try {
    const data = await buildReportData(request, "run", now);
    const warnings = [...data.warnings];
    const artifacts: RunReportResult["artifacts"] = [];
    const expiresAt = new Date(now.getTime() + env.reportRetentionDays * 24 * 60 * 60 * 1000);
    const baseName = safeFileBaseName(request, now);

    for (const format of formats) {
      const rendered = await renderFormat(format, data);
      warnings.push(...rendered.warnings.filter((w) => !warnings.includes(w)));

      const stored = await storeReportArtifact(rendered.buffer, format);
      storedKeys.push(stored.storageKey);

      const artifact = await db.reportArtifact.create({
        data: {
          reportRunId: run.id,
          format,
          storageKey: stored.storageKey,
          fileName: `${baseName}.${FILE_EXTENSION[format]}`,
          mimeType: MIME_TYPE[format],
          fileSize: stored.fileSize,
          sha256: stored.sha256,
          expiresAt,
        },
        select: { id: true, format: true, fileName: true, fileSize: true, sha256: true },
      });
      createdArtifacts.push({ id: artifact.id, storageKey: stored.storageKey });
      artifacts.push(artifact);
    }

    await db.reportRun.update({
      where: { id: run.id },
      data: {
        status: ReportRunStatus.COMPLETED,
        completedAt: new Date(),
        resultSummary: {
          rowCount: data.rowCount,
          warnings,
          formats,
        } as Prisma.InputJsonValue,
      },
    });

    // The run is now durably COMPLETED with valid artifacts. The two steps
    // below are best-effort housekeeping — their failure must not roll back
    // the run or delete artifacts that were already successfully created,
    // so they get their own try/catch instead of falling into the outer one.
    try {
      if (reportTemplateId) {
        await db.reportTemplate.update({
          where: { id: reportTemplateId },
          data: { lastRunAt: new Date() },
        });
      }

      await writeAuditLog(db, {
        action: "REPORT_RUN_COMPLETED",
        entityType: "ReportRun",
        entityId: run.id,
        actor: requestedBy,
        metadata: {
          reportType: request.type,
          templateId: reportTemplateId,
          formats,
          rowCount: data.rowCount,
        },
      });
    } catch (postCompletionError) {
      console.error("Report run completed but post-completion housekeeping failed:", postCompletionError);
    }

    return {
      runId: run.id,
      status: ReportRunStatus.COMPLETED,
      artifacts,
      warnings,
      rowCount: data.rowCount,
    };
  } catch (error) {
    // Classify the ORIGINAL failure before touching anything else. Whatever
    // happens during cleanup below must never overwrite this classification —
    // the run's terminal state has to reflect why the export actually failed.
    const { errorCode, errorMessage, status } = describeRunFailure(error);

    // A storage key can exist without a linked artifact row only when
    // storeReportArtifact succeeded but the immediately-following
    // db.reportArtifact.create() itself threw — there is no row to protect
    // for that key, so it is cleaned up separately from the row-linked ones.
    const linkedKeys = new Set(createdArtifacts.map((artifact) => artifact.storageKey));
    const orphanStorageKeys = storedKeys.filter((key) => !linkedKeys.has(key));
    const cleanupResult = await cleanupFailedRunArtifacts(createdArtifacts, orphanStorageKeys);

    try {
      await db.reportRun.update({
        where: { id: run.id },
        data: {
          status: ReportRunStatus.FAILED,
          failedAt: new Date(),
          errorCode,
          errorMessage,
        },
      });
    } catch (persistError) {
      // Persisting the FAILED state itself failed — this is more critical than
      // the original export error, since the run can now be stuck in RUNNING.
      // There's no centralized logger in this project, so console.error is the
      // established convention (see the post-completion housekeeping catch above).
      console.error("Critical: failed to persist FAILED state for report run", run.id, persistError);
      throw new ReportRunError(errorCode, errorMessage, status, {
        cause: { originalError: error, persistError },
      });
    }

    try {
      await writeAuditLog(db, {
        action: "REPORT_RUN_FAILED",
        entityType: "ReportRun",
        entityId: run.id,
        actor: requestedBy,
        metadata: {
          reportType: request.type,
          templateId: reportTemplateId,
          errorCode,
          deletedArtifactIds: cleanupResult.deletedArtifactIds,
          retainedArtifactIds: cleanupResult.retainedArtifactIds,
          cleanupFailures: cleanupResult.failures.map(({ artifactId, step, message }) => ({ artifactId, step, message })),
        },
      });
    } catch (auditError) {
      console.error("Report run marked FAILED but failure audit log could not be written:", run.id, auditError);
    }

    throw new ReportRunError(errorCode, errorMessage, status);
  }
}

// Best-effort cleanup of partially-created artifacts. Every step is
// independently try/caught so a cleanup failure can never prevent the caller
// from classifying the original error and persisting the run's FAILED state.
// A ReportArtifact row is only ever deleted once its file has been confirmed
// deleted (or was already gone) — deleting the row first and letting the file
// deletion fail silently would leave an orphaned file with no database row,
// undiscoverable and unretryable by the retention job.
async function cleanupFailedRunArtifacts(
  createdArtifacts: CreatedArtifactReference[],
  orphanStorageKeys: string[]
): Promise<CleanupResult> {
  for (const key of orphanStorageKeys) {
    const deletion = await deleteReportArtifact(key);
    if (!deletion.deleted) {
      console.error("Failed to delete an orphaned report artifact file with no database row:", key, deletion.error);
    }
  }

  const deletedArtifactIds: string[] = [];
  const retainedArtifactIds: string[] = [];
  const failures: CleanupFailure[] = [];

  for (const artifact of createdArtifacts) {
    const deletion = await deleteReportArtifact(artifact.storageKey);

    if (!deletion.deleted) {
      retainedArtifactIds.push(artifact.id);
      failures.push({
        artifactId: artifact.id,
        storageKey: artifact.storageKey,
        step: "artifact_file",
        message: deletion.error.message,
      });
      continue;
    }

    try {
      const result = await db.reportArtifact.deleteMany({ where: { id: artifact.id } });
      if (result.count !== 1) {
        retainedArtifactIds.push(artifact.id);
        failures.push({
          artifactId: artifact.id,
          storageKey: artifact.storageKey,
          step: "artifact_row",
          message: "تعذر حذف سجل المرفق بعد حذف الملف",
        });
        continue;
      }
      deletedArtifactIds.push(artifact.id);
    } catch (cleanupError) {
      retainedArtifactIds.push(artifact.id);
      failures.push({
        artifactId: artifact.id,
        storageKey: artifact.storageKey,
        step: "artifact_row",
        message: cleanupError instanceof Error ? cleanupError.message : "تعذر حذف سجل المرفق",
      });
    }
  }

  return { deletedArtifactIds, retainedArtifactIds, failures };
}

function describeRunFailure(error: unknown): { errorCode: string; errorMessage: string; status: number } {
  if (isReportRowLimitExceededError(error)) {
    return {
      errorCode: error.code,
      errorMessage: "عدد الشكاوى المطابقة يتجاوز الحد المسموح لهذا التقرير",
      status: 422,
    };
  }
  if (isReportRunError(error)) {
    return { errorCode: error.code, errorMessage: error.message, status: error.status };
  }
  return { errorCode: "REPORT_GENERATION_FAILED", errorMessage: "تعذر توليد التقرير", status: 500 };
}

function isUniqueConstraintError(error: unknown, field: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002" &&
    "meta" in error &&
    JSON.stringify((error as { meta?: unknown }).meta ?? "").includes(field)
  );
}
