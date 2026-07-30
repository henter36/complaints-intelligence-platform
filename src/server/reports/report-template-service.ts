import { ReportFormat, type Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/audit/audit-log-service";
import {
  getReportDefinition,
  parseReportRequest,
  reportFiltersSchema,
  reportOptionsSchema,
  type ReportFilters,
  type ReportOptions,
} from "./report-definition-service";
import { runReport, type RunReportResult } from "./report-export-service";
import { getZonedDateParts, RIYADH_TIME_ZONE } from "./report-time";
import { ReportType } from "@prisma/client";
import { z } from "zod";

export class ReportTemplateError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ReportTemplateError";
    this.code = code;
    this.status = status;
  }
}

export function isReportTemplateError(error: unknown): error is ReportTemplateError {
  return error instanceof ReportTemplateError;
}

export const createTemplateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500).optional(),
  reportType: z.enum(ReportType),
  filters: reportFiltersSchema,
  options: reportOptionsSchema.optional(),
});

export const updateTemplateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  reportType: z.enum(ReportType).optional(),
  filters: reportFiltersSchema.optional(),
  options: reportOptionsSchema.optional(),
  isActive: z.boolean().optional(),
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;

function assertNoHtml(text: string, field: string): void {
  if (/[<>]/.test(text)) {
    throw new ReportTemplateError("INVALID_TEMPLATE_INPUT", `لا يسمح بوسوم HTML في حقل ${field}`, 400);
  }
}

export async function createReportTemplate(input: CreateTemplateInput, actor: string) {
  assertNoHtml(input.name, "الاسم");
  if (input.description) assertNoHtml(input.description, "الوصف");

  // Validate the base filters/options actually form a runnable report request.
  parseReportRequest({ type: input.reportType, filters: input.filters, options: input.options ?? {} });

  const template = await db.reportTemplate.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      reportType: input.reportType,
      filters: input.filters as Prisma.InputJsonValue,
      options: (input.options ?? {}) as Prisma.InputJsonValue,
      createdBy: actor,
    },
  });

  await writeAuditLog(db, {
    action: "REPORT_TEMPLATE_CREATED",
    entityType: "ReportTemplate",
    entityId: template.id,
    actor,
    metadata: { reportType: template.reportType },
  });

  return template;
}

export async function listReportTemplates(includeInactive: boolean) {
  return db.reportTemplate.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: { createdAt: "desc" },
    include: { schedules: true },
  });
}

export async function getReportTemplateOrThrow(id: string) {
  const template = await db.reportTemplate.findUnique({ where: { id }, include: { schedules: true } });
  if (!template) {
    throw new ReportTemplateError("REPORT_TEMPLATE_NOT_FOUND", "القالب غير موجود", 404);
  }
  return template;
}

export async function updateReportTemplate(id: string, input: UpdateTemplateInput, actor: string) {
  const existing = await getReportTemplateOrThrow(id);

  if (input.name) assertNoHtml(input.name, "الاسم");
  if (input.description) assertNoHtml(input.description, "الوصف");

  if (input.reportType && input.reportType !== existing.reportType) {
    const runCount = await db.reportRun.count({ where: { reportTemplateId: id } });
    if (runCount > 0) {
      throw new ReportTemplateError(
        "REPORT_TEMPLATE_TYPE_LOCKED",
        "لا يمكن تغيير نوع التقرير بعد وجود تشغيلات سابقة لهذا القالب",
        409
      );
    }
  }

  const nextType = input.reportType ?? existing.reportType;
  const nextFilters = (input.filters ?? (existing.filters as ReportFilters)) as ReportFilters;
  const nextOptions = (input.options ?? (existing.options as ReportOptions)) as ReportOptions;
  parseReportRequest({ type: nextType, filters: nextFilters, options: nextOptions });

  const updated = await db.reportTemplate.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description === undefined ? undefined : input.description,
      reportType: input.reportType,
      filters: input.filters ? (input.filters as Prisma.InputJsonValue) : undefined,
      options: input.options ? (input.options as Prisma.InputJsonValue) : undefined,
      isActive: input.isActive,
    },
  });

  await writeAuditLog(db, {
    action: "REPORT_TEMPLATE_UPDATED",
    entityType: "ReportTemplate",
    entityId: id,
    actor,
    metadata: { reportType: updated.reportType },
  });

  return updated;
}

export async function disableReportTemplate(id: string, actor: string) {
  await getReportTemplateOrThrow(id);
  const updated = await db.reportTemplate.update({ where: { id }, data: { isActive: false } });

  await writeAuditLog(db, {
    action: "REPORT_TEMPLATE_DISABLED",
    entityType: "ReportTemplate",
    entityId: id,
    actor,
  });

  return updated;
}

/**
 * Templates store a concrete from/to window, but a schedule must produce a
 * fresh period each time it fires. The stored span (in days) is preserved
 * and re-anchored to end "today" in Riyadh time, so a saved "last 30 days"
 * template always reports the latest 30 days rather than replaying the same
 * frozen dates forever.
 */
export function resolveTemplateRunFilters(filters: ReportFilters, now: Date): ReportFilters {
  const from = new Date(filters.from);
  const to = new Date(filters.to);
  const spanDays = Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000));

  const todayRiyadh = getZonedDateParts(now, RIYADH_TIME_ZONE);
  const endDate = new Date(Date.UTC(todayRiyadh.year, todayRiyadh.month - 1, todayRiyadh.day));
  const startDate = new Date(endDate.getTime() - spanDays * 86_400_000);

  return {
    ...filters,
    from: startDate.toISOString().slice(0, 10),
    to: endDate.toISOString().slice(0, 10),
  };
}

export async function runReportTemplate(
  templateId: string,
  actor: string,
  options?: { formats?: ReportFormat[]; scheduledFor?: Date; idempotencyKey?: string }
): Promise<RunReportResult> {
  const template = await getReportTemplateOrThrow(templateId);
  if (!template.isActive) {
    throw new ReportTemplateError("REPORT_TEMPLATE_DISABLED", "القالب معطل ولا يمكن تشغيله", 409);
  }

  const now = new Date();
  const filters = resolveTemplateRunFilters(template.filters as ReportFilters, now);
  const request = parseReportRequest({
    type: template.reportType,
    filters,
    options: template.options as ReportOptions,
  });

  const definition = getReportDefinition(request.type);
  const formats = options?.formats ?? [
    ...(definition.supportsPdf ? [ReportFormat.PDF] : []),
    ...(definition.supportsXlsx ? [ReportFormat.XLSX] : []),
  ];

  return runReport(
    {
      request,
      formats,
      requestedBy: actor,
      reportTemplateId: template.id,
      scheduledFor: options?.scheduledFor ?? null,
      idempotencyKey: options?.idempotencyKey ?? null,
    },
    now
  );
}
