import { isComplaintLate, type ComplaintTiming } from "@/lib/complaint-metrics";
import { toLegacyStatus } from "@/server/complaints/status";

export type ComplaintListItem<T extends ComplaintTiming> = T & {
  isLate: boolean;
};

export function toComplaintListItem<T extends ComplaintTiming>(
  complaint: T,
  now = new Date()
): ComplaintListItem<T> & Record<string, unknown> {
  const raw = complaint as T & {
    complaintDate?: Date | null;
    receivedAt?: Date | null;
    closedAt?: Date | null;
    region?: string | null;
    facility?: string | null;
    department?: string | null;
    category?: { nameAr: string } | null;
    classification?: { nameAr: string; color?: string | null } | null;
    externalId?: string | null;
    sourceReference?: string | null;
    id?: string;
    firstActionAt?: Date | null;
    processingStartedAt?: Date | null;
  };

  return {
    ...complaint,
    complaintNumber: raw.externalId ?? raw.sourceReference ?? raw.id ?? "",
    receivedDate: raw.complaintDate ?? raw.receivedAt ?? null,
    closureDate: raw.closedAt ?? null,
    referralDate: null,
    firstActionDate: raw.firstActionAt ?? null,
    processingDate: raw.processingStartedAt ?? null,
    status: toLegacyStatus(raw.status as never),
    region: raw.region ? { name: raw.region } : null,
    location: raw.facility ? { name: raw.facility } : null,
    department: raw.department ? { name: raw.department } : null,
    classification: raw.classification
      ? { name: raw.classification.nameAr, color: raw.classification.color ?? "#64748b" }
      : raw.category
        ? { name: raw.category.nameAr, color: "#64748b" }
        : null,
    isLate: isComplaintLate(complaint, now),
  };
}
