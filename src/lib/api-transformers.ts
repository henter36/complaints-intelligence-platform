import { isComplaintLate, type ComplaintTiming } from "@/lib/complaint-metrics";

export type ComplaintListItem<T extends ComplaintTiming> = T & {
  isLate: boolean;
};

export function toComplaintListItem<T extends ComplaintTiming>(
  complaint: T,
  now = new Date()
): ComplaintListItem<T> {
  return {
    ...complaint,
    isLate: isComplaintLate(complaint, now),
  };
}
