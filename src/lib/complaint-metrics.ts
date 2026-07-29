export type ComplaintTiming = {
  status: string;
  dueDate: Date | null;
  closedAt?: Date | null;
  closureDate?: Date | null;
};

const CLOSED_STATUSES = new Set(["CLOSED", "closed"]);
const CANCELLED_STATUSES = new Set(["CANCELLED", "cancelled", "rejected"]);

export function isComplaintLate(complaint: ComplaintTiming, now = new Date()): boolean {
  if (!complaint.dueDate) {
    return false;
  }

  const closedAt = complaint.closedAt ?? complaint.closureDate ?? null;
  if (CLOSED_STATUSES.has(complaint.status)) {
    return closedAt ? closedAt > complaint.dueDate : false;
  }

  return !CANCELLED_STATUSES.has(complaint.status) && now > complaint.dueDate;
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
