import { ComplaintPriority, type Prisma } from "@prisma/client";
import { parseComplaintStatus } from "@/server/complaints/status";

export function parsePriority(value: string | null): ComplaintPriority | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toUpperCase();
  return Object.values(ComplaintPriority).find((priority) => priority === normalized);
}

export function buildComplaintWhereFromParams(params: URLSearchParams): Prisma.ComplaintWhereInput {
  const from = params.get("from");
  const to = params.get("to");
  const region = params.get("regionId");
  const department = params.get("departmentId");
  const classificationId = params.get("classificationId");
  const channel = params.get("channel");
  const status = parseComplaintStatus(params.get("status"));
  const priority = parsePriority(params.get("priority"));
  const severity = parsePriority(params.get("severity"));

  const where: Prisma.ComplaintWhereInput = { isDeleted: false };
  if (from || to) {
    where.complaintDate = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to) } : {}),
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

export function toLegacyPriority(priority: ComplaintPriority): string {
  return priority.toLowerCase();
}
