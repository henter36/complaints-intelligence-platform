import { ComplaintPriority, ComplaintStatus, type Prisma } from "@prisma/client";
import {
  buildComplaintWhere,
  ComplaintQueryValidationError,
  isComplaintQueryValidationError,
  parseComplaintQuery,
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
    return buildComplaintWhere(parseComplaintQuery(params));
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
    const nextWhere = buildComplaintWhere(parseComplaintQuery(params), now);
    return { ...where, ...nextWhere };
  } catch (error) {
    if (isComplaintQueryValidationError(error)) {
      throw new InvalidComplaintQueryError(error.message);
    }
    throw error;
  }
}

export function toLegacyPriority(priority: ComplaintPriority): string {
  return priority.toLowerCase();
}

export function toLegacyStatus(status: ComplaintStatus): string {
  return status.toLowerCase();
}
