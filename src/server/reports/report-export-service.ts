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

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ReportRunError";
    this.code = code;
    this.status = status;
  }
}

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
  const createdArtifactIds: string[] = [];

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
      createdArtifactIds.push(artifact.id);
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
    for (const key of storedKeys) {
      await deleteReportArtifact(key);
    }
    if (createdArtifactIds.length > 0) {
      await db.reportArtifact.deleteMany({ where: { id: { in: createdArtifactIds } } });
    }

    const { errorCode, errorMessage, status } = describeRunFailure(error);

    await db.reportRun.update({
      where: { id: run.id },
      data: {
        status: ReportRunStatus.FAILED,
        failedAt: new Date(),
        errorCode,
        errorMessage,
      },
    });

    await writeAuditLog(db, {
      action: "REPORT_RUN_FAILED",
      entityType: "ReportRun",
      entityId: run.id,
      actor: requestedBy,
      metadata: { reportType: request.type, templateId: reportTemplateId, errorCode },
    });

    throw new ReportRunError(errorCode, errorMessage, status);
  }
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
