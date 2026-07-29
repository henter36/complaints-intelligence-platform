import { ComplaintPriority, ComplaintStatus, type Prisma } from "@prisma/client";
import { parseComplaintStatus } from "@/server/complaints/status";

const OPEN_LATE_STATUSES: ComplaintStatus[] = [
  ComplaintStatus.NEW,
  ComplaintStatus.OPEN,
  ComplaintStatus.IN_PROGRESS,
  ComplaintStatus.AWAITING_RESPONSE,
  ComplaintStatus.RESOLVED,
];

export class InvalidComplaintQueryError extends Error {
  readonly code = "INVALID_COMPLAINT_QUERY";

  constructor(message: string) {
    super(message);
    this.name = "InvalidComplaintQueryError";
  }
}

export function isInvalidComplaintQueryError(error: unknown): error is InvalidComplaintQueryError {
  return error instanceof InvalidComplaintQueryError;
}

function addAndCondition(
  where: Prisma.ComplaintWhereInput,
  condition: Prisma.ComplaintWhereInput
): void {
  const current = where.AND;
  if (!current) {
    where.AND = [condition];
    return;
  }

  where.AND = Array.isArray(current) ? [...current, condition] : [current, condition];
}

export function parsePriority(value: string | null): ComplaintPriority | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toUpperCase();
  return Object.values(ComplaintPriority).find((priority) => priority === normalized);
}

export function parseOptionalDateFilter(
  value: string | null,
  fieldName: "from" | "to"
): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidComplaintQueryError(`${fieldName} must be a valid date`);
  }

  return parsed;
}

export function buildComplaintWhereFromParams(params: URLSearchParams): Prisma.ComplaintWhereInput {
  const from = parseOptionalDateFilter(params.get("from"), "from");
  const to = parseOptionalDateFilter(params.get("to"), "to");
  const region = params.get("regionId");
  const department = params.get("departmentId");
  const classificationId = params.get("classificationId");
  const channel = params.get("channel");
  const statusValue = params.get("status");
  const status = parseComplaintStatus(statusValue);
  const priority = parsePriority(params.get("priority"));
  const severity = parsePriority(params.get("severity"));

  const where: Prisma.ComplaintWhereInput = { isDeleted: false };
  if (from && to && from > to) {
    throw new InvalidComplaintQueryError("from must be before or equal to to");
  }
  if (statusValue && !status) {
    throw new InvalidComplaintQueryError("status is not supported");
  }

  if (from || to) {
    where.complaintDate = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    };
  }
  if (region) where.region = region;
  if (department) where.department = department;
  if (classificationId) where.classificationId = classificationId;
  if (channel) where.channel = channel;
  if (status) where.status = status;
  if (priority) where.priority = priority;
  if (severity) where.severity = severity;
  return where;
}

export function addComplaintRequestFilters(
  where: Prisma.ComplaintWhereInput,
  params: URLSearchParams,
  now = new Date()
): Prisma.ComplaintWhereInput {
  const search = params.get("search")?.trim() ?? "";
  const isLate = params.get("isLate");
  const isRepeated = params.get("isRepeated");
  const isValidated = params.get("isValidated");
  const aiAnalyzed = params.get("aiAnalyzed");

  if (search) {
    const searchFilter: Prisma.ComplaintWhereInput = {
      OR: [
        { externalId: { contains: search } },
        { sourceReference: { contains: search } },
        { subject: { contains: search } },
        { description: { contains: search } },
      ],
    };
    addAndCondition(where, searchFilter);
  }
  if (isRepeated === "true") where.isRepeated = true;
  if (isRepeated === "false") where.isRepeated = false;
  if (isValidated === "true") where.isValidated = true;
  if (isValidated === "false") where.isValidated = false;
  if (aiAnalyzed === "true") where.aiAnalyzedAt = { not: null };
  if (aiAnalyzed === "false") where.aiAnalyzedAt = null;
  if (isLate === "true") {
    addAndCondition(where, {
      dueDate: { lt: now },
      status: { in: OPEN_LATE_STATUSES },
    });
  }
  if (isLate === "false") {
    addAndCondition(where, {
      OR: [
        { dueDate: null },
        { dueDate: { gte: now } },
        { status: { notIn: OPEN_LATE_STATUSES } },
      ],
    });
  }

  return where;
}

export function toLegacyPriority(priority: ComplaintPriority): string {
  return priority.toLowerCase();
}
