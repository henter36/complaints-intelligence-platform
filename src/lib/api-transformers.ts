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
): Record<string, unknown> {
  const raw = complaint as T & {
    id?: string;
    externalId?: string | null;
    sourceReference?: string | null;
    complaintDate?: Date | null;
    receivedAt?: Date | null;
    dueDate?: Date | null;
    closedAt?: Date | null;
    status?: string;
    subject?: string | null;
    description?: string | null;
    region?: string | null;
    facility?: string | null;
    department?: string | null;
    categoryId?: string | null;
    classificationId?: string | null;
    category?: { nameAr: string } | null;
    classification?: { nameAr: string; color?: string | null } | null;
    priority?: string;
    severity?: string;
    channel?: string | null;
    resolution?: string | null;
    firstActionAt?: Date | null;
    processingStartedAt?: Date | null;
    delayReason?: string | null;
    isRepeated?: boolean;
    isValidated?: boolean;
    beneficiarySatisfaction?: number | null;
    aiClassification?: string | null;
    aiConfidence?: number | null;
    aiReasoning?: string | null;
    aiSentiment?: string | null;
    aiSeverityScore?: number | null;
    aiSummary?: string | null;
    aiAnalyzedAt?: Date | null;
    isPotentialDuplicate?: boolean;
  };

  return {
    id: raw.id,
    externalId: raw.externalId ?? null,
    sourceReference: raw.sourceReference ?? null,
    complaintNumber: raw.externalId ?? raw.sourceReference ?? raw.id ?? "",
    complaintDate: raw.complaintDate ?? null,
    receivedDate: raw.complaintDate ?? raw.receivedAt ?? null,
    receivedAt: raw.receivedAt ?? null,
    dueDate: raw.dueDate ?? null,
    closedAt: raw.closedAt ?? null,
    closureDate: raw.closedAt ?? null,
    referralDate: null,
    firstActionDate: raw.firstActionAt ?? null,
    firstActionAt: raw.firstActionAt ?? null,
    processingDate: raw.processingStartedAt ?? null,
    processingStartedAt: raw.processingStartedAt ?? null,
    status: toLegacyStatus(raw.status as never),
    rawStatus: raw.status ?? null,
    subject: raw.subject ?? "",
    description: raw.description ?? "",
    region: raw.region ? { name: raw.region } : null,
    regionName: raw.region ?? null,
    location: raw.facility ? { name: raw.facility } : null,
    facility: raw.facility ?? null,
    department: raw.department ? { name: raw.department } : null,
    departmentName: raw.department ?? null,
    categoryId: raw.categoryId ?? null,
    classificationId: raw.classificationId ?? null,
    classification: resolveLegacyClassification(raw.classification, raw.category),
    priority: raw.priority ?? null,
    severity: raw.severity ?? null,
    channel: raw.channel ?? null,
    resolution: raw.resolution ?? null,
    delayReason: raw.delayReason ?? null,
    isRepeated: raw.isRepeated ?? false,
    isValidated: raw.isValidated ?? false,
    beneficiarySatisfaction: raw.beneficiarySatisfaction ?? null,
    aiClassification: raw.aiClassification ?? null,
    aiConfidence: raw.aiConfidence ?? null,
    aiReasoning: raw.aiReasoning ?? null,
    aiSentiment: raw.aiSentiment ?? null,
    aiSeverityScore: raw.aiSeverityScore ?? null,
    aiSummary: raw.aiSummary ?? null,
    aiAnalyzedAt: raw.aiAnalyzedAt ?? null,
    isPotentialDuplicate: raw.isPotentialDuplicate ?? false,
    isLate: isComplaintLate(complaint, now),
  };
}
