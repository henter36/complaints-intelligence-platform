/**
 * Single Arabic label per AnalyticalFindingType, shared by the Analytics UI,
 * the PDF renderers, and the XLSX export so a finding never reads
 * differently depending on where it's shown (spec §11).
 */
export const FINDING_TYPE_LABELS: Record<string, string> = {
  CHRONIC_ISSUE: "مشكلة مزمنة",
  TREND_PATTERN: "نمط ملحوظ",
  SUSTAINED_IMPROVEMENT: "تحسن مستدام",
  REPEAT_COMPLAINANT: "تكرار شكوى",
  MASS_COMPLAINT: "تكرار جماعي",
  WING_CONCENTRATION: "تركّز داخل جناح",
  CROSS_FACILITY_SPREAD: "انتشار عبر مواقع",
  COMPOSITION_SHIFT: "تحول في تركيبة الشكاوى",
  MULTI_ISSUE_FACILITY: "موقع متعدد المشكلات",
  CONCENTRATION: "تركّز تصنيف",
  VOLUME_SPIKE: "ارتفاع حاد",
  BACKLOG_GROWTH: "تراكم متزايد",
  CURRENTLY_OVERDUE: "شكاوى متأخرة",
  LATE_CLOSURE: "إغلاق متأخر",
  RECURRING_THEME: "موضوع متكرر",
  DATA_QUALITY: "جودة بيانات",
  TEXT_RISK: "إشارة نصية",
  EMERGING_TOPIC: "موضوع ناشئ",
};

export function findingTypeLabel(type: string): string {
  return FINDING_TYPE_LABELS[type] ?? type;
}

/**
 * `finding.entityName` for a CLASSIFICATION-scoped finding is always
 * "facility — classification" (see pattern-findings-service.ts); this
 * recovers just the classification half. Shared by the report data service
 * and the brief-conclusions/best-practice-candidate modules so the split
 * logic lives in exactly one place.
 */
export function classificationLabelFromEntityName(entityName: string): string {
  const separatorIndex = entityName.indexOf(" — ");
  return separatorIndex === -1 ? entityName : entityName.slice(separatorIndex + 3);
}
