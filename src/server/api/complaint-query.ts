import { ComplaintPriority, ComplaintStatus, type Prisma } from "@prisma/client";
import {
  buildComplaintWhere,
  ComplaintQueryValidationError,
  isComplaintQueryValidationError,
  parseComplaintQuery,
  type ComplaintQuery,
} from "@/server/complaints/complaint-query-service";

export class InvalidComplaintQueryError extends ComplaintQueryValidationError {
  readonly code = "INVALID_COMPLAINT_QUERY";
}

export function isInvalidComplaintQueryError(error: unknown): error is InvalidComplaintQueryError {
  return isComplaintQueryValidationError(error);
}

export function parsePriority(value: string | null): ComplaintPriority | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toUpperCase();
  return Object.values(ComplaintPriority).find((priority) => priority === normalized);
}

export function parseOptionalDateFilter(value: string | null, fieldName: "from" | "to"): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidComplaintQueryError(`${fieldName} must be a valid date`);
  }
  return parsed;
}

export function buildComplaintWhereFromParams(params: URLSearchParams): Prisma.ComplaintWhereInput {
  try {
    return buildComplaintWhere(withoutRequestFilters(parseComplaintQuery(params)));
  } catch (error) {
    if (isComplaintQueryValidationError(error)) {
      throw new InvalidComplaintQueryError(error.message);
    }
    throw error;
  }
}

export function addComplaintRequestFilters(
  where: Prisma.ComplaintWhereInput,
  params: URLSearchParams,
  now = new Date()
): Prisma.ComplaintWhereInput {
  try {
    const nextWhere = buildComplaintWhere(onlyRequestFilters(parseComplaintQuery(params)), now);
    delete nextWhere.isDeleted;
    return mergeComplaintWhere(where, nextWhere);
  } catch (error) {
    if (isComplaintQueryValidationError(error)) {
      throw new InvalidComplaintQueryError(error.message);
    }
    throw error;
  }
}

function withoutRequestFilters(query: ComplaintQuery): ComplaintQuery {
  return {
    ...query,
    isLate: undefined,
    isOpen: undefined,
    isClosed: undefined,
    hasDueDate: undefined,
    hasClassification: undefined,
  };
}

function onlyRequestFilters(query: ComplaintQuery): ComplaintQuery {
  return {
    ...query,
    search: undefined,
    externalId: undefined,
    sourceReference: undefined,
    status: undefined,
    priority: undefined,
    severity: undefined,
    channel: undefined,
    region: undefined,
    regionId: undefined,
    facility: undefined,
    facilityId: undefined,
    department: undefined,
    departmentId: undefined,
    categoryId: undefined,
    classificationId: undefined,
    importBatchId: undefined,
    from: undefined,
    to: undefined,
    dueFrom: undefined,
    dueTo: undefined,
    closedFrom: undefined,
    closedTo: undefined,
    isRepeated: undefined,
    isValidated: undefined,
    aiAnalyzed: undefined,
  };
}

function toAndConditions(
  value: Prisma.ComplaintWhereInput["AND"]
): Prisma.ComplaintWhereInput[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function mergeComplaintWhere(
  base: Prisma.ComplaintWhereInput,
  additional: Prisma.ComplaintWhereInput
): Prisma.ComplaintWhereInput {
  const { AND: baseAnd, ...baseWithoutAnd } = base;
  const { AND: additionalAnd, ...additionalWithoutAnd } = additional;
  const conditions = [
    baseWithoutAnd,
    ...toAndConditions(baseAnd),
    additionalWithoutAnd,
    ...toAndConditions(additionalAnd),
  ].filter((condition) => Object.keys(condition).length > 0);

  return conditions.length === 1 ? conditions[0]! : { AND: conditions };
}

export function toLegacyPriority(priority: ComplaintPriority): string {
  return priority.toLowerCase();
}

export function toLegacyStatus(status: ComplaintStatus): string {
  return status.toLowerCase();
}
