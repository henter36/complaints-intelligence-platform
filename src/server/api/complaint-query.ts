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

type ComplaintBaseFilters = {
  from?: Date;
  to?: Date;
  region: string | null;
  department: string | null;
  classificationId: string | null;
  channel: string | null;
  status?: ComplaintStatus;
  priority?: ComplaintPriority;
  severity?: ComplaintPriority;
};

function validateDateRange(from?: Date, to?: Date): void {
  if (from && to && from > to) {
    throw new InvalidComplaintQueryError("from must be before or equal to to");
  }
}

function parseAndValidateStatus(value: string | null): ComplaintStatus | undefined {
  const status = parseComplaintStatus(value);

  if (value && !status) {
    throw new InvalidComplaintQueryError("status is not supported");
  }

  return status;
}

function readBaseFilters(params: URLSearchParams): ComplaintBaseFilters {
  const from = parseOptionalDateFilter(params.get("from"), "from");
  const to = parseOptionalDateFilter(params.get("to"), "to");

  validateDateRange(from, to);

  return {
    from,
    to,
    region: params.get("regionId"),
    department: params.get("departmentId"),
    classificationId: params.get("classificationId"),
    channel: params.get("channel"),
    status: parseAndValidateStatus(params.get("status")),
    priority: parsePriority(params.get("priority")),
    severity: parsePriority(params.get("severity")),
  };
}

function applyDateFilter(
  where: Prisma.ComplaintWhereInput,
  from?: Date,
  to?: Date
): void {
  if (!from && !to) {
    return;
  }

  where.complaintDate = {
    ...(from ? { gte: from } : {}),
    ...(to ? { lte: to } : {}),
  };
}

function applyBaseScalarFilters(
  where: Prisma.ComplaintWhereInput,
  filters: ComplaintBaseFilters
): void {
  if (filters.region) where.region = filters.region;
  if (filters.department) where.department = filters.department;
  if (filters.classificationId) where.classificationId = filters.classificationId;
  if (filters.channel) where.channel = filters.channel;
  if (filters.status) where.status = filters.status;
  if (filters.priority) where.priority = filters.priority;
  if (filters.severity) where.severity = filters.severity;
}

export function buildComplaintWhereFromParams(params: URLSearchParams): Prisma.ComplaintWhereInput {
  const filters = readBaseFilters(params);
  const where: Prisma.ComplaintWhereInput = { isDeleted: false };

  applyDateFilter(where, filters.from, filters.to);
  applyBaseScalarFilters(where, filters);

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
