import type { TextSignalSource } from "@/server/analytics/operational/operational-analytics-types";

export type MultiSourceTextInput = {
  description: string | null;
  sourceDetail: string | null;
  actionDescription: string | null;
};

/**
 * Keeps free-text sources separate for pattern detection.
 * Does not merge into one blob without documenting the source.
 */
export function iterTextSignalSources(input: MultiSourceTextInput): Array<{
  source: TextSignalSource;
  text: string;
}> {
  const out: Array<{ source: TextSignalSource; text: string }> = [];
  if (input.description?.trim()) {
    out.push({ source: "COMPLAINT_DESCRIPTION", text: input.description.trim() });
  }
  if (input.sourceDetail?.trim()) {
    out.push({ source: "SOURCE_DETAIL", text: input.sourceDetail.trim() });
  }
  if (input.actionDescription?.trim()) {
    out.push({ source: "ACTION_DESCRIPTION", text: input.actionDescription.trim() });
  }
  return out;
}

export type OperationalTextPattern = {
  code: string;
  label: string;
  source: TextSignalSource;
};

const PATTERNS: Array<{ code: string; label: string; re: RegExp }> = [
  { code: "NO_ACTION", label: "عدم اتخاذ إجراء", re: /لم\s*يت[مّ]\s*اتخاذ|بدون\s*إجراء|لا\s*يوجد\s*إجراء/i },
  { code: "INCOMPLETE_ACTION", label: "إجراء غير مكتمل", re: /غير\s*مكتمل|تحت\s*الإجراء|جار[يى]?\s*العمل/i },
  { code: "ACTION_BLOCKED", label: "تعطل إجراء", re: /تعطل|معل[قّ]|تعذر\s*التنفيذ/i },
  { code: "CLOSURE_WITHOUT_TREATMENT", label: "إغلاق دون معالجة واضحة", re: /أُغلق|تم\s*الإغلاق.*دون|إغلاق\s*إداري/i },
];

export function detectOperationalTextPatterns(input: MultiSourceTextInput): OperationalTextPattern[] {
  const findings: OperationalTextPattern[] = [];
  for (const { source, text } of iterTextSignalSources(input)) {
    for (const pattern of PATTERNS) {
      if (pattern.re.test(text)) {
        findings.push({ code: pattern.code, label: pattern.label, source });
      }
    }
  }
  return findings;
}
