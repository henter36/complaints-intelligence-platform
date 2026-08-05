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

/** Normalize Arabic for pattern matching: NFC, strip diacritics/tatweel, unify alef. */
export function normalizeArabicForMatch(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[\u064B-\u065F\u0670]/g, "") // harakat + superscript alef
    .replace(/\u0640/g, "") // tatweel
    .replace(/[إأآٱ]/g, "ا")
    .replace(/\u0629/g, "ه") // teh marbuta → heh
    .replace(/\s+/g, " ")
    .trim();
}

const PATTERNS: Array<{ code: string; label: string; re: RegExp }> = [
  { code: "NO_ACTION", label: "عدم اتخاذ إجراء", re: /لم\s*يتم\s*اتخاذ|بدون\s*اجراء|لا\s*يوجد\s*اجراء/i },
  { code: "INCOMPLETE_ACTION", label: "إجراء غير مكتمل", re: /غير\s*مكتمل|تحت\s*الاعداد|جارى?\s*العمل|جاري\s*العمل/i },
  { code: "ACTION_BLOCKED", label: "تعطل إجراء", re: /تعطل|معلق|تعذر\s*التنفيذ/i },
  {
    code: "CLOSURE_WITHOUT_TREATMENT",
    label: "إغلاق دون معالجة واضحة",
    re: /(?:(?:تم\s*)?الاغلاق|اغلق)\s*دون\s*(?:معالجه|اجراء|حل)|اغلاق\s*اداري/i,
  },
];

export function detectOperationalTextPatterns(input: MultiSourceTextInput): OperationalTextPattern[] {
  const findings: OperationalTextPattern[] = [];
  for (const { source, text } of iterTextSignalSources(input)) {
    const normalized = normalizeArabicForMatch(text);
    for (const pattern of PATTERNS) {
      if (pattern.re.test(normalized)) {
        findings.push({ code: pattern.code, label: pattern.label, source });
      }
    }
  }
  return findings;
}
