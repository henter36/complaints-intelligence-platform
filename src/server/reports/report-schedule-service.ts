import { ReportFrequency } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/audit/audit-log-service";
import { isReportRunError, type RunReportResult } from "./report-export-service";
import { getReportTemplateOrThrow, runReportTemplate } from "./report-template-service";
import { daysInMonth, getZonedDateParts, RIYADH_TIME_ZONE, zonedWallTimeToUtc } from "./report-time";

export class ReportScheduleError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ReportScheduleError";
    this.code = code;
    this.status = status;
  }
}

export function isReportScheduleError(error: unknown): error is ReportScheduleError {
  return error instanceof ReportScheduleError;
}

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const scheduleInputSchema = z
  .object({
    reportTemplateId: z.string().trim().min(1),
    frequency: z.nativeEnum(ReportFrequency),
    timeOfDay: z.string().regex(TIME_OF_DAY_PATTERN, "صيغة الوقت يجب أن تكون HH:MM"),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    isEnabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.frequency === ReportFrequency.WEEKLY && value.dayOfWeek === undefined) {
      ctx.addIssue({ code: "custom", message: "يجب تحديد يوم الأسبوع للجدولة الأسبوعية" });
    }
    if (value.frequency === ReportFrequency.MONTHLY && value.dayOfMonth === undefined) {
      ctx.addIssue({ code: "custom", message: "يجب تحديد يوم الشهر للجدولة الشهرية" });
    }
  });

export const scheduleUpdateSchema = z
  .object({
    frequency: z.nativeEnum(ReportFrequency).optional(),
    timeOfDay: z.string().regex(TIME_OF_DAY_PATTERN).optional(),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    isEnabled: z.boolean().optional(),
  })
  .strict();

export type ScheduleInput = z.infer<typeof scheduleInputSchema>;
export type ScheduleUpdateInput = z.infer<typeof scheduleUpdateSchema>;

type ScheduleTiming = {
  frequency: ReportFrequency;
  timeOfDay: string;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  timezone: string;
};

function parseTimeOfDay(timeOfDay: string): { hour: number; minute: number } {
  const match = TIME_OF_DAY_PATTERN.exec(timeOfDay);
  if (!match) throw new ReportScheduleError("INVALID_SCHEDULE_TIME", "صيغة الوقت غير صالحة", 400);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function addCalendarDays(year: number, month: number, day: number, delta: number): {
  year: number;
  month: number;
  day: number;
} {
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function addCalendarMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const total = (month - 1) + delta;
  const newYear = year + Math.floor(total / 12);
  const newMonth = ((total % 12) + 12) % 12 + 1;
  return { year: newYear, month: newMonth };
}

/**
 * Computes the next occurrence strictly after `from`, in the schedule's
 * timezone. MONTHLY policy: if the configured dayOfMonth does not exist in a
 * given month (e.g. 31 in February), the LAST day of that month is used
 * instead of skipping the month or rejecting the run.
 */
export function computeNextRunAt(schedule: ScheduleTiming, from: Date): Date {
  const { hour, minute } = parseTimeOfDay(schedule.timeOfDay);
  const tz = schedule.timezone || RIYADH_TIME_ZONE;
  const fromParts = getZonedDateParts(from, tz);

  if (schedule.frequency === ReportFrequency.DAILY) {
    let candidate = zonedWallTimeToUtc(
      { year: fromParts.year, month: fromParts.month, day: fromParts.day, hour, minute },
      tz
    );
    if (candidate.getTime() <= from.getTime()) {
      const next = addCalendarDays(fromParts.year, fromParts.month, fromParts.day, 1);
      candidate = zonedWallTimeToUtc({ ...next, hour, minute }, tz);
    }
    return candidate;
  }

  if (schedule.frequency === ReportFrequency.WEEKLY) {
    const targetWeekday = schedule.dayOfWeek ?? 0;
    const delta = (targetWeekday - fromParts.weekday + 7) % 7;
    const dateParts = addCalendarDays(fromParts.year, fromParts.month, fromParts.day, delta);
    let candidate = zonedWallTimeToUtc({ ...dateParts, hour, minute }, tz);
    if (candidate.getTime() <= from.getTime()) {
      const next = addCalendarDays(dateParts.year, dateParts.month, dateParts.day, 7);
      candidate = zonedWallTimeToUtc({ ...next, hour, minute }, tz);
    }
    return candidate;
  }

  // MONTHLY
  const targetDay = schedule.dayOfMonth ?? 1;
  const resolveDay = (year: number, month: number) => Math.min(targetDay, daysInMonth(year, month));
  let candidate = zonedWallTimeToUtc(
    { year: fromParts.year, month: fromParts.month, day: resolveDay(fromParts.year, fromParts.month), hour, minute },
    tz
  );
  if (candidate.getTime() <= from.getTime()) {
    const next = addCalendarMonths(fromParts.year, fromParts.month, 1);
    candidate = zonedWallTimeToUtc(
      { year: next.year, month: next.month, day: resolveDay(next.year, next.month), hour, minute },
      tz
    );
  }
  return candidate;
}

export async function createReportSchedule(input: ScheduleInput, actor: string, now: Date = new Date()) {
  await getReportTemplateOrThrow(input.reportTemplateId);

  const nextRunAt = computeNextRunAt(
    { frequency: input.frequency, timeOfDay: input.timeOfDay, dayOfWeek: input.dayOfWeek, dayOfMonth: input.dayOfMonth, timezone: RIYADH_TIME_ZONE },
    now
  );

  const schedule = await db.reportSchedule.create({
    data: {
      reportTemplateId: input.reportTemplateId,
      frequency: input.frequency,
      timeOfDay: input.timeOfDay,
      dayOfWeek: input.dayOfWeek ?? null,
      dayOfMonth: input.dayOfMonth ?? null,
      timezone: RIYADH_TIME_ZONE,
      isEnabled: input.isEnabled ?? true,
      nextRunAt,
    },
  });

  await writeAuditLog(db, {
    action: "REPORT_SCHEDULE_CREATED",
    entityType: "ReportSchedule",
    entityId: schedule.id,
    actor,
    metadata: { templateId: input.reportTemplateId, frequency: input.frequency },
  });

  return schedule;
}

export async function listReportSchedules() {
  return db.reportSchedule.findMany({
    orderBy: { nextRunAt: "asc" },
    include: { reportTemplate: { select: { id: true, name: true, reportType: true, isActive: true } } },
  });
}

async function getScheduleOrThrow(id: string) {
  const schedule = await db.reportSchedule.findUnique({ where: { id } });
  if (!schedule) {
    throw new ReportScheduleError("REPORT_SCHEDULE_NOT_FOUND", "الجدولة غير موجودة", 404);
  }
  return schedule;
}

export async function updateReportSchedule(id: string, input: ScheduleUpdateInput, actor: string, now: Date = new Date()) {
  const existing = await getScheduleOrThrow(id);

  const merged: ScheduleTiming = {
    frequency: input.frequency ?? existing.frequency,
    timeOfDay: input.timeOfDay ?? existing.timeOfDay,
    dayOfWeek: input.dayOfWeek ?? existing.dayOfWeek,
    dayOfMonth: input.dayOfMonth ?? existing.dayOfMonth,
    timezone: existing.timezone,
  };

  if (merged.frequency === ReportFrequency.WEEKLY && merged.dayOfWeek === null) {
    throw new ReportScheduleError("INVALID_SCHEDULE_INPUT", "يجب تحديد يوم الأسبوع للجدولة الأسبوعية", 400);
  }
  if (merged.frequency === ReportFrequency.MONTHLY && merged.dayOfMonth === null) {
    throw new ReportScheduleError("INVALID_SCHEDULE_INPUT", "يجب تحديد يوم الشهر للجدولة الشهرية", 400);
  }

  const timingChanged = input.frequency !== undefined || input.timeOfDay !== undefined
    || input.dayOfWeek !== undefined || input.dayOfMonth !== undefined;
  const nextRunAt = timingChanged ? computeNextRunAt(merged, now) : existing.nextRunAt;

  const updated = await db.reportSchedule.update({
    where: { id },
    data: {
      frequency: input.frequency,
      timeOfDay: input.timeOfDay,
      dayOfWeek: input.dayOfWeek,
      dayOfMonth: input.dayOfMonth,
      isEnabled: input.isEnabled,
      nextRunAt,
    },
  });

  await writeAuditLog(db, {
    action: "REPORT_SCHEDULE_UPDATED",
    entityType: "ReportSchedule",
    entityId: id,
    actor,
  });

  return updated;
}

export async function disableReportSchedule(id: string, actor: string) {
  await getScheduleOrThrow(id);
  const updated = await db.reportSchedule.update({ where: { id }, data: { isEnabled: false } });

  await writeAuditLog(db, {
    action: "REPORT_SCHEDULE_DISABLED",
    entityType: "ReportSchedule",
    entityId: id,
    actor,
  });

  return updated;
}

export type RunDueResult =
  | { ran: false; reason: "no_due_schedule" }
  | { ran: false; reason: "already_running"; scheduleId: string }
  | { ran: false; reason: "contended"; scheduleId: string }
  | { ran: true; scheduleId: string; run: RunReportResult }
  | { ran: true; scheduleId: string; failed: true; errorCode: string };

/**
 * Claims and executes at most one due schedule per call. Concurrency-safe:
 * the nextRunAt advance is a conditional update (only succeeds if nextRunAt
 * still matches what we read), so two overlapping invocations of the
 * scheduler script can never both execute the same due slot.
 */
export async function runDueSchedule(now: Date = new Date(), actor = "system"): Promise<RunDueResult> {
  const due = await db.reportSchedule.findFirst({
    where: { isEnabled: true, nextRunAt: { lte: now } },
    orderBy: { nextRunAt: "asc" },
  });

  if (!due) {
    return { ran: false, reason: "no_due_schedule" };
  }

  const runningCount = await db.reportRun.count({
    where: { reportTemplateId: due.reportTemplateId, status: "RUNNING" },
  });
  if (runningCount > 0) {
    return { ran: false, reason: "already_running", scheduleId: due.id };
  }

  const scheduledFor = due.nextRunAt;
  const nextRunAt = computeNextRunAt(
    {
      frequency: due.frequency,
      timeOfDay: due.timeOfDay,
      dayOfWeek: due.dayOfWeek,
      dayOfMonth: due.dayOfMonth,
      timezone: due.timezone,
    },
    scheduledFor
  );

  const claim = await db.reportSchedule.updateMany({
    where: { id: due.id, nextRunAt: due.nextRunAt },
    data: { nextRunAt, lastRunAt: now },
  });

  if (claim.count === 0) {
    return { ran: false, reason: "contended", scheduleId: due.id };
  }

  const idempotencyKey = `${due.id}:${scheduledFor.toISOString()}`;

  try {
    const run = await runReportTemplate(due.reportTemplateId, actor, { scheduledFor, idempotencyKey });

    await writeAuditLog(db, {
      action: "REPORT_SCHEDULE_EXECUTED",
      entityType: "ReportSchedule",
      entityId: due.id,
      actor,
      metadata: { templateId: due.reportTemplateId, runId: run.runId },
    });

    return { ran: true, scheduleId: due.id, run };
  } catch (error) {
    const errorCode = isReportRunError(error) ? error.code : "REPORT_SCHEDULE_RUN_FAILED";
    await writeAuditLog(db, {
      action: "REPORT_SCHEDULE_EXECUTED",
      entityType: "ReportSchedule",
      entityId: due.id,
      actor,
      metadata: { templateId: due.reportTemplateId, errorCode, failed: true },
    });
    return { ran: true, scheduleId: due.id, failed: true, errorCode };
  }
}
