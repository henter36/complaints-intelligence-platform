export type ComplaintTiming = {
  status: string;
  dueDate: Date | null;
  closureDate: Date | null;
};

export function isComplaintLate(complaint: ComplaintTiming, now = new Date()): boolean {
  if (!complaint.dueDate) {
    return false;
  }

  if (complaint.status === "closed") {
    return complaint.closureDate ? complaint.closureDate > complaint.dueDate : false;
  }

  return complaint.status !== "rejected" && now > complaint.dueDate;
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
