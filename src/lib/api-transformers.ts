import { isComplaintLate, type ComplaintTiming } from "@/lib/complaint-metrics";
import { toLegacyStatus } from "@/server/complaints/status";

export type ComplaintListItem<T extends ComplaintTiming> = T & {
  isLate: boolean;
};

type LegacyClassification = { name: string; color: string } | null;

function resolveLegacyClassification(
  classification?: { nameAr: string; color?: string | null } | null,
  category?: { nameAr: string } | null
): LegacyClassification {
  if (classification) {
    return {
      name: classification.nameAr,
      color: classification.color ?? "#64748b",
    };
  }

  if (category) {
    return {
      name: category.nameAr,
      color: "#64748b",
    };
  }

  return null;
}

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
    classification: resolveLegacyClassification(raw.classification, raw.category),
    isLate: isComplaintLate(complaint, now),
  };
}
