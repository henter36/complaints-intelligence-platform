import { ComplaintStatus } from "@prisma/client";
import {
  isClosedComplaintStatus,
  isOpenComplaintStatus,
} from "@/server/complaints/status";

export type ComplaintTiming = {
  status: string;
  dueDate: Date | null;
  closedAt?: Date | null;
  closureDate?: Date | null;
};

function normalizeStatus(status: string): ComplaintStatus | null {
  const normalized = status.toUpperCase();
  if (normalized === "REJECTED") return ComplaintStatus.CANCELLED;
  if (Object.values(ComplaintStatus).includes(normalized as ComplaintStatus)) {
    return normalized as ComplaintStatus;
  }
  return null;
}

export function isComplaintLate(complaint: ComplaintTiming, now = new Date()): boolean {
  if (!complaint.dueDate) {
    return false;
  }

  const status = normalizeStatus(complaint.status);
  if (!status) return false;
  const closedAt = complaint.closedAt ?? complaint.closureDate ?? null;
  if (isClosedComplaintStatus(status)) {
    return closedAt ? closedAt > complaint.dueDate : false;
  }

  return isOpenComplaintStatus(status) && now > complaint.dueDate;
}

export function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}
