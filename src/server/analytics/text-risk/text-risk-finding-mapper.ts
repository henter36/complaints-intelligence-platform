import { type TextRiskReviewStatus } from "@prisma/client";
import {
  AnalyticalFindingSchema,
  type AnalyticalFinding,
  type AnalyticalSeverity,
} from "@/lib/analytics/analytical-finding";
import { RULE_CATALOG_VERSION } from "./text-risk-rule-catalog";

type SignalForMapping = Readonly<{
  id: string;
  complaintId: string;
  title: string;
  severity: string;
  confidenceScore: number;
  certainty: string;
  isOngoing: boolean | null;
  evidenceSpans: unknown;
  region: string | null;
  reviewStatus: TextRiskReviewStatus;
  createdAt: Date;
}>;

function mapSeverity(severity: string): AnalyticalSeverity {
  if (severity === "CRITICAL") return "CRITICAL";
  if (severity === "HIGH") return "HIGH";
  if (severity === "MEDIUM") return "MEDIUM";
  return "LOW";
}

function getCertaintyLabel(certainty: string): string {
  if (certainty === "CONFIRMED_IN_TEXT") return "مؤكد في النص";
  if (certainty === "SUSPECTED") return "اشتباه";
  if (certainty === "ALLEGED") return "ادعاء";
  if (certainty === "HISTORICAL_RESOLVED") return "حدث سابق";
  return "غير محدد";
}

function mapConfidence(score: number): AnalyticalFinding["confidence"] {
  if (score >= 0.8) return "HIGH";
  if (score >= 0.5) return "MEDIUM";
  return "LOW";
}

function parseEvidenceSpans(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === "string").slice(0, 20);
}

/**
 * Maps a TextRiskSignal to an AnalyticalFinding.
 * Only PENDING_REVIEW and CONFIRMED signals should be mapped.
 * DISMISSED/DUPLICATE/NEEDS_MORE_DATA signals are excluded from findings.
 */
export function mapTextRiskSignalToAnalyticalFinding(signal: SignalForMapping): AnalyticalFinding {
  const detectedAt = signal.createdAt.toISOString();
  const evidenceSpans = parseEvidenceSpans(signal.evidenceSpans);

  const limitationsList: string[] = [];
  if (signal.certainty === "SUSPECTED") {
    limitationsList.push("هذه إشارة اشتباه مبنية على وجود كلمات دالة — تحتاج مراجعة يدوية للتأكيد.");
  } else if (signal.certainty === "ALLEGED") {
    limitationsList.push("الإشارة مبنية على ادعاء أو رواية دون تحقق.");
  } else if (signal.certainty === "HISTORICAL_RESOLVED") {
    limitationsList.push("قد يكون الحدث قديمًا وتمت معالجته.");
  }
  limitationsList.push("هذه إشارة آلية وليست قرارًا نهائيًا — تحتاج مراجعة متخصص.");

  const entityName = signal.region ?? "إجمالي الشكاوى";

  return AnalyticalFindingSchema.parse({
    id: `text_risk:${signal.id}`,
    type: "TEXT_RISK",
    entityType: signal.region ? "REGION" : "GLOBAL",
    entityId: null,
    entityName,
    currentValue: 1,
    previousValue: null,
    difference: null,
    changeRate: null,
    severity: mapSeverity(signal.severity),
    priorityScore: Math.round(signal.confidenceScore * 100),
    confidence: mapConfidence(signal.confidenceScore),
    detectionSource: "RULE",
    explanation: `${signal.title}: إشارة مكتشفة بواسطة محرك القواعد في نص الشكوى. (${getCertaintyLabel(signal.certainty)})`,
    supportingMetrics: {
      confidenceScore: signal.confidenceScore,
      certainty: signal.certainty,
      isOngoing: signal.isOngoing,
    },
    evidenceComplaintIds: [signal.complaintId],
    evidenceSpans,
    limitations: limitationsList,
    drilldownFilters: {
      ...(signal.region ? { region: signal.region } : {}),
    },
    firstDetectedAt: detectedAt,
    lastDetectedAt: detectedAt,
    detectorVersion: RULE_CATALOG_VERSION,
  });
}
