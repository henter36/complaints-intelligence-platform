/**
 * Central library + selector for the executive brief's periodic
 * "ممارسات تشغيلية مقترحة" (suggested operational practices) section.
 *
 * These 4 cards are pre-approved, generic operational guidance — never a
 * claim that a practice caused a real facility's improvement, and never a
 * "proven best practice discovered from the data". That governed workflow
 * (a real SUSTAINED_IMPROVEMENT finding → BestPracticeCandidate → human
 * verification → documented BestPracticeRecord) lives entirely in
 * best-practice-candidate.ts / best-practice-record.ts and is intentionally
 * untouched here — see EXCLUDED_FROM_SELECTION_IDS below for the one library
 * entry whose own wording narrates that workflow and must never be
 * auto-selected alongside it.
 */

import type { AnalyticalFinding } from "@/lib/analytics/analytical-finding";
import { classificationLabelFromEntityName } from "@/lib/analytics/finding-labels";
import { PATTERN_ANALYSIS_CONFIG } from "@/lib/analytics/pattern-analysis-config";
import { normalizeClassificationKeyword } from "@/lib/classifications/classification-keyword-normalizer";
import type { ClassificationTrendRow, FacilityFollowUpRow } from "./report-contract";

// ---------------------------------------------------------------------------
// 1. Library
// ---------------------------------------------------------------------------

export type OperationalPracticeTopic =
  | "HEALTH_ACCESS"
  | "MEDICAL_APPOINTMENTS"
  | "MEDICATION"
  | "REQUEST_MANAGEMENT"
  | "REPEAT_COMPLAINTS"
  | "COLLECTIVE_COMPLAINTS"
  | "FIELD_VISITS"
  | "BELONGINGS"
  | "AGENCIES"
  | "LEGAL_RELEASE"
  | "NAZEEL_DATA"
  | "COORDINATION"
  | "SERVICE_TIME"
  | "ROOT_CAUSE"
  | "CHRONIC_PROBLEMS"
  | "POST_ACTION_MONITORING"
  | "KNOWLEDGE_TRANSFER"
  | "RESPONSE_QUALITY"
  | "GENERAL";

export type OperationalPractice = {
  id: string;
  title: string;
  description: string;
  topic: OperationalPracticeTopic;
  /** Keywords matched against a classification's display label (see normalizeForTopicMatching). */
  classificationMatchers: readonly string[];
  isGeneral: boolean;
};

/**
 * One row per approved practice. Authored as a compact data table (one line
 * per practice) rather than 24 repeated `{ id:, title:, description:, ... }`
 * object literals — the previous shape was flagged as duplicated code (every
 * entry has the exact same field sequence, so any run of a few consecutive
 * entries structurally matched any other run) even though the actual data
 * never repeated. The 24 practices' ids, text, topics, matchers, and order
 * are byte-for-byte unchanged — see OPERATIONAL_PRACTICES below, and
 * operational-practices.test.ts for the invariant that keeps every row's
 * title/description within the PDF card's line budget.
 */
type OperationalPracticeSeed = readonly [
  id: string,
  title: string,
  description: string,
  topic: OperationalPracticeTopic,
  classificationMatchers: readonly string[],
  isGeneral: boolean,
];

const OPERATIONAL_PRACTICE_SEEDS: readonly OperationalPracticeSeed[] = [
  ["daily-health-request-followup", "المتابعة اليومية للطلبات الصحية", "حصر طلبات النزلاء الصحية يومياً، وتحديد الأولوية، ومتابعتها حتى العرض على المختص وإقفال الطلب.", "HEALTH_ACCESS", ["طبيب", "صحة", "رعاية صحية", "عيادة", "كشف طبي"], false],
  ["medical-appointment-attendance", "ضمان حضور المواعيد الطبية", "تسجيل المواعيد وترتيبات النقل مسبقاً ومتابعة تنفيذها لمنع فوات الموعد أو تأخر النزيل عنه.", "MEDICAL_APPOINTMENTS", ["موعد طبي", "مستشفى", "عيادة خارجية", "نقل طبي"], false],
  ["medication-continuity", "استمرارية صرف الأدوية", "متابعة الوصفات والأدوية قبل نفادها ومعالجة أي تعثر في الصرف قبل أن يؤدي إلى انقطاع العلاج.", "MEDICATION", ["دواء", "علاج", "وصفة", "صرف علاج", "استمرارية العلاج"], false],
  ["urgent-health-case-triage", "فرز الحالات الصحية العاجلة", "تطبيق آلية واضحة لتمييز الحالات الصحية العاجلة وإحالتها فوراً دون انتظار مسار الطلبات الاعتيادي.", "HEALTH_ACCESS", ["حالة عاجلة", "مرض", "تسمم", "خطر صحي"], false],
  ["request-tracking-number", "رقم متابعة لكل طلب", "منح كل طلب رقماً مرجعياً يتيح معرفة حالته والإجراء المتخذ عليه حتى الإقفال.", "REQUEST_MANAGEMENT", ["طلبات", "متابعة", "خدمات", "معاملات"], false],
  ["verified-request-closure", "إقفال الطلب بعد التحقق من التنفيذ", "عدم اعتبار الطلب منجزاً بمجرد إحالته، بل بعد تنفيذ الإجراء وتوثيق النتيجة.", "REQUEST_MANAGEMENT", ["طلبات", "معاملات", "تأخر", "لم يتم التنفيذ"], true],
  ["repeat-complaint-root-review", "منع تكرار الشكوى", "عند تكرار الشكوى تتم مراجعة المعالجة السابقة والتأكد من معالجة السبب الجذري وليس إعادة الإجراء نفسه.", "REPEAT_COMPLAINTS", ["الشكاوى المتكررة", "إعادة الشكوى", "نفس المشتكي"], false],
  ["collective-complaint-pattern-review", "تحليل الشكاوى الجماعية", "ارتفاع الشكوى نفسها لدى عدة نزلاء يعامل كمؤشر على مشكلة تشغيلية مشتركة وليس كحالات فردية منفصلة.", "COLLECTIVE_COMPLAINTS", ["شكاوى جماعية", "انتشار المشكلة", "عدد كبير من النزلاء"], false],
  ["complaint-owner-assignment", "تحديد مسؤول لكل شكوى", "إسناد كل شكوى إلى مسؤول واضح مع مدة مستهدفة للمعالجة ومتابعتها حتى الإقفال.", "REQUEST_MANAGEMENT", ["متابعة", "تأخر", "عدم الرد", "شكوى مفتوحة"], true],
  ["early-overdue-escalation", "التصعيد المبكر للمتأخرات", "تصعيد الشكاوى التي تتجاوز المدة المعتمدة إلى المستوى الإداري المناسب قبل تحولها إلى مشكلة مزمنة.", "SERVICE_TIME", ["متأخرة", "تجاوز المدة", "تأخر المعالجة"], false],
  ["periodic-ward-rounds", "المرور الدوري داخل العنابر", "تنظيم مرور المختصين بصورة دورية لاستقبال طلبات النزلاء ميدانياً وتقليل الحاجة إلى تقديم شكوى للوصول إلى الخدمة.", "FIELD_VISITS", ["عدم دخول المختص", "مقابلة المختص", "طلبات النزلاء", "عنابر"], false],
  ["field-visit-documentation", "توثيق نتائج المرور الميداني", "تسجيل ما تم رصده خلال الجولات والإجراء المتخذ والمسؤول عن المعالجة وتاريخ الإقفال.", "FIELD_VISITS", ["جولات", "متابعة ميدانية", "ملاحظات"], false],
  ["belongings-custody-control", "ضبط الأمانات والمقتنيات", "توثيق استلام وتسليم وحركة الأمانات والمقتنيات بما يتيح الرجوع إلى سجل واضح عند وجود مطالبة أو شكوى.", "BELONGINGS", ["أمانات", "مقتنيات", "ودائع", "أموال", "أغراض شخصية"], false],
  // "وكالات" (plural) is listed alongside "وكالة" (singular): a real classification
  // label is as likely to read "الوكالات" as "الوكالة", and substring matching
  // after normalization cannot bridge that plural/singular difference alone.
  ["agency-service-control", "ضبط إجراءات الوكالات والخدمات الشخصية", "تحديد متطلبات الخدمة ومسؤول التنفيذ والمدة المستهدفة وإبلاغ النزيل بحالة الطلب.", "AGENCIES", ["وكالة", "وكالات", "جهات", "خدمات شخصية", "وثائق"], false],
  ["release-case-followup", "متابعة طلبات الإفراج والقضايا", "متابعة الطلبات المرتبطة بالإفراج والقضايا والجهات العدلية وفق مدة محددة وعدم تركها دون تحديث.", "LEGAL_RELEASE", ["إفراج", "قضية", "عدلية", "محكمة", "نيابة"], false],
  ["periodic-legal-status-review", "المراجعة الدورية للوضع النظامي", "مراجعة مدد المحكوميات وأوامر التوقيف والإجراءات النظامية قبل تواريخ الانتهاء وليس بعد حدوث التأخير.", "LEGAL_RELEASE", ["انتهاء محكومية", "توقيف", "سند نظامي", "إطلاق سراح"], false],
  ["nazeel-data-immediate-update", "تحديث بيانات نظام نزيل فوراً", "تسجيل المواعيد والإجراءات وحركة النزيل والتغير في حالته فور حدوثها لضمان سلامة البيانات والقرارات المبنية عليها.", "NAZEEL_DATA", ["نظام نزيل", "بيانات", "تحديث", "موعد", "نقل"], false],
  ["direct-interagency-coordination", "التنسيق المباشر بين الجهات", "معالجة الموضوعات المشتركة بالتواصل المباشر بين المختصين مع استخدام المخاطبات الرسمية لتوثيق ما تم.", "COORDINATION", ["تنسيق", "جهة أخرى", "منطقة أخرى", "انتظار إفادة"], true],
  ["service-completion-time-measurement", "قياس زمن إنجاز الخدمة", "قياس المدة من تقديم الطلب حتى تنفيذه، وعدم الاكتفاء بقياس أعداد الطلبات أو الشكاوى.", "SERVICE_TIME", ["مدة", "تأخير", "إنجاز", "خدمة"], true],
  ["root-cause-remediation", "معالجة السبب الجذري", "عند تكرار المشكلة يتم تحديد السبب التشغيلي ووضع إجراء يمنع تكرارها بدلاً من معالجة الحالات بصورة منفردة.", "ROOT_CAUSE", ["مشكلة مزمنة", "تكرار", "استمرار", "ارتفاع مستمر"], true],
  ["weekly-chronic-issue-review", "مراجعة المشكلات المزمنة أسبوعياً", "عرض المشكلات المستمرة على إدارة الموقع أسبوعياً مع تحديد مسؤول وخطة معالجة وتاريخ مستهدف للإقفال.", "CHRONIC_PROBLEMS", ["CHRONIC_ISSUE", "مشكلة مزمنة", "استمرار عدة فترات"], true],
  ["post-action-improvement-monitoring", "متابعة التحسن بعد المعالجة", "استمرار قياس المؤشر عدة فترات بعد تنفيذ المعالجة للتأكد من أن الانخفاض مستدام وليس مؤقتاً.", "POST_ACTION_MONITORING", ["تحسن", "انخفاض", "متابعة النتائج"], true],
  ["cross-facility-knowledge-transfer", "نقل التجارب الناجحة بين السجون", "دراسة المواقع التي تحقق تحسناً مستداماً في مشكلة محددة ومقارنتها بالمواقع التي لا تزال تواجه المشكلة نفسها.", "KNOWLEDGE_TRANSFER", ["SUSTAINED_IMPROVEMENT", "مقارنة المواقع", "نقل المعرفة"], false],
  ["response-quality-verification", "التحقق من جودة الرد على الشكوى", "يجب أن يوضح الرد الإجراء المنفذ ونتيجته وألا يقتصر على عبارات عامة مثل «تمت الإفادة» أو «تم التوجيه».", "RESPONSE_QUALITY", ["رد الشكوى", "تمت الإفادة", "تم التوجيه", "إقفال الشكوى"], true],
];

export const OPERATIONAL_PRACTICES: readonly OperationalPractice[] = OPERATIONAL_PRACTICE_SEEDS.map(
  ([id, title, description, topic, classificationMatchers, isGeneral]) => ({
    id,
    title,
    description,
    topic,
    classificationMatchers,
    isGeneral,
  })
);

const OPERATIONAL_PRACTICE_BY_ID: ReadonlyMap<string, OperationalPractice> = new Map(
  OPERATIONAL_PRACTICES.map((p) => [p.id, p])
);

export function getOperationalPracticeById(id: string): OperationalPractice | undefined {
  return OPERATIONAL_PRACTICE_BY_ID.get(id);
}

/** Rotating 4th-slot pool (spec §4), in the fixed order used to seed deterministic rotation. */
export const GENERAL_OPERATIONAL_PRACTICE_IDS: readonly string[] = [
  "complaint-owner-assignment",
  "verified-request-closure",
  "service-completion-time-measurement",
  "root-cause-remediation",
  "response-quality-verification",
  "direct-interagency-coordination",
  "weekly-chronic-issue-review",
  "post-action-improvement-monitoring",
] as const;

/**
 * "نقل التجارب الناجحة بين السجون" describes the BestPracticeCandidate
 * workflow in prose. Kept in the library for completeness (spec §1 lists all
 * 24) but never auto-selected — doing so would blur this generic, unproven
 * section with that separate, human-verified governance workflow (spec §10).
 */
const EXCLUDED_FROM_SELECTION_IDS: ReadonlySet<string> = new Set(["cross-facility-knowledge-transfer"]);

// ---------------------------------------------------------------------------
// 2. Report contract row
// ---------------------------------------------------------------------------

export type OperationalPracticeSelectionReason =
  | "REPORT_PRIORITY"
  | "REPORT_VOLUME"
  | "PERSISTENT_PROBLEM"
  | "GENERAL_ROTATION";

export type OperationalPracticeRow = {
  id: string;
  title: string;
  description: string;
  topic: OperationalPracticeTopic;
  /** Internal only — never rendered in the PDF. */
  selectionReason: OperationalPracticeSelectionReason;
};

function toRow(practice: OperationalPractice, reason: OperationalPracticeSelectionReason): OperationalPracticeRow {
  return {
    id: practice.id,
    title: practice.title,
    description: practice.description,
    topic: practice.topic,
    selectionReason: reason,
  };
}

// ---------------------------------------------------------------------------
// 3. Topic matching (Arabic-aware, no percentage-based logic)
// ---------------------------------------------------------------------------

/**
 * Strips a leading attached conjunction/preposition + definite article
 * ("و"/"ف"/"ب"/"ل"/"ك" + "ال") from one already-normalized word. This is
 * layered ON TOP of the shared normalizeClassificationKeyword (character
 * normalization only, no article handling) — it does not duplicate it, and
 * exists only so a matcher keyword like "خدمات شخصية" still matches a real
 * classification label like "الخدمات الشخصية" without requiring the matcher
 * list itself to enumerate every definite/indefinite word-form combination.
 */
const LEADING_ATTACHED_ARTICLE_RE = /^[وفبلك]?ال/;

function normalizeForTopicMatching(text: string): string {
  return normalizeClassificationKeyword(text)
    .split(" ")
    .filter(Boolean)
    .map((word) => word.replace(LEADING_ATTACHED_ARTICLE_RE, ""))
    .join(" ");
}

/**
 * Non-general, selectable candidates whose classificationMatchers hit this
 * label, ranked by match specificity (the longest matcher keyword that hit —
 * e.g. "خدمات شخصية" outranks the generic "خدمات" shared by several
 * practices) and falling back to library order on a tie (stable sort).
 */
function findMatchingPractices(normalizedLabel: string): readonly OperationalPractice[] {
  const scored: Array<{ practice: OperationalPractice; bestMatchLength: number }> = [];
  for (const practice of OPERATIONAL_PRACTICES) {
    if (practice.isGeneral || EXCLUDED_FROM_SELECTION_IDS.has(practice.id)) continue;
    let bestMatchLength = 0;
    for (const matcher of practice.classificationMatchers) {
      const normalizedMatcher = normalizeForTopicMatching(matcher);
      if (normalizedMatcher.length > 0 && normalizedLabel.includes(normalizedMatcher)) {
        bestMatchLength = Math.max(bestMatchLength, normalizedMatcher.length);
      }
    }
    if (bestMatchLength > 0) scored.push({ practice, bestMatchLength });
  }
  scored.sort((a, b) => b.bestMatchLength - a.bestMatchLength);
  return scored.map((s) => s.practice);
}

// ---------------------------------------------------------------------------
// 4. Classification-topic priority ranking (spec §2)
// ---------------------------------------------------------------------------

type Tier = 1 | 2 | 3 | 4 | 5 | 6;

type ClassificationTopicSignal = {
  label: string;
  normalizedLabel: string;
  isChronic: boolean;
  isHighPriorityNegative: boolean;
  isRelapse: boolean;
  affectedFacilityCount: number;
  currentVolume: number;
  maxPriorityScore: number;
  /** How many HIGH-priority-band facilities cite this topic as their own top issue (report-wide corroboration). */
  highPriorityFollowUpVotes: number;
  tier: Tier;
};

const NEGATIVE_PATTERN_LABELS: ReadonlySet<ClassificationTrendRow["patternLabel"]> = new Set([
  "استمرار مرتفع",
  "تصاعد مستمر",
]);

function buildClassificationTopicSignals(input: {
  classificationTrends: readonly ClassificationTrendRow[];
  facilitiesNeedingFollowUp: readonly FacilityFollowUpRow[];
  patternFindings: readonly AnalyticalFinding[];
}): ClassificationTopicSignal[] {
  const { classificationTrends, facilitiesNeedingFollowUp, patternFindings } = input;

  // CHRONIC_ISSUE is only reliable straight from the finding type — a
  // ClassificationTrendRow's patternLabel falls back to the generic "نمط
  // ملحوظ" for chronic rows (they carry no supportingMetrics.pattern), so it
  // can never be told apart from a merely-notable trend there.
  const chronicLabelByKey = new Map<string, string>();
  for (const finding of patternFindings) {
    if (finding.entityType !== "CLASSIFICATION" || finding.type !== "CHRONIC_ISSUE") continue;
    const label = classificationLabelFromEntityName(finding.entityName);
    chronicLabelByKey.set(normalizeForTopicMatching(label), label);
  }

  const highPriorityVotesByKey = new Map<string, number>();
  for (const row of facilitiesNeedingFollowUp) {
    if (row.priorityBand !== "مرتفعة" || row.topIssueLabel === "—") continue;
    const key = normalizeForTopicMatching(row.topIssueLabel);
    highPriorityVotesByKey.set(key, (highPriorityVotesByKey.get(key) ?? 0) + 1);
  }

  type Group = { label: string; rows: ClassificationTrendRow[]; facilities: Set<string> };
  const groupByKey = new Map<string, Group>();
  for (const row of classificationTrends) {
    const key = normalizeForTopicMatching(row.classification);
    const group = groupByKey.get(key) ?? { label: row.classification, rows: [], facilities: new Set<string>() };
    group.rows.push(row);
    group.facilities.add(row.facility);
    groupByKey.set(key, group);
  }

  const { high } = PATTERN_ANALYSIS_CONFIG.priorityBandThresholds;
  const minVolume = PATTERN_ANALYSIS_CONFIG.minComplaintsForSignal;

  const partial: Array<Omit<ClassificationTopicSignal, "tier">> = [];
  for (const [key, group] of groupByKey) {
    const currentVolume = group.rows.reduce((sum, r) => sum + r.currentCount, 0);
    const maxPriorityScore = Math.max(...group.rows.map((r) => r.priorityScore));
    // Never gate on percentage/priorityScore alone (spec §2): a genuine
    // signal must also clear a minimum absolute current-period volume.
    const isHighPriorityNegative = group.rows.some(
      (r) => NEGATIVE_PATTERN_LABELS.has(r.patternLabel) && r.priorityScore >= high && r.currentCount >= minVolume
    );
    const isRelapse = group.rows.some((r) => r.patternLabel === "عودة للارتفاع بعد تحسن");
    partial.push({
      label: group.label,
      normalizedLabel: key,
      isChronic: chronicLabelByKey.has(key),
      isHighPriorityNegative,
      isRelapse,
      affectedFacilityCount: group.facilities.size,
      currentVolume,
      maxPriorityScore,
      highPriorityFollowUpVotes: highPriorityVotesByKey.get(key) ?? 0,
    });
  }

  // A chronic classification that fell outside the (possibly capped)
  // classificationTrends input must still be visible to this selector —
  // callers should pass an uncapped classificationTrends list, but this
  // keeps tier-1 correct even if one doesn't.
  for (const [key, label] of chronicLabelByKey) {
    if (groupByKey.has(key)) continue;
    partial.push({
      label,
      normalizedLabel: key,
      isChronic: true,
      isHighPriorityNegative: false,
      isRelapse: false,
      affectedFacilityCount: 0,
      currentVolume: 0,
      maxPriorityScore: 0,
      highPriorityFollowUpVotes: highPriorityVotesByKey.get(key) ?? 0,
    });
  }

  // Tier 3 is a single dedicated slot for "the highest current-period
  // volume" classification among those not already claimed by tier 1/2 —
  // gated by the same minimum-signal volume as everywhere else so a
  // near-zero-volume leftover can never win it by default (spec §2).
  let topVolumeKey: string | null = null;
  let topVolume = -1;
  for (const s of partial) {
    if (s.isChronic || s.isHighPriorityNegative) continue;
    if (s.currentVolume > topVolume) {
      topVolume = s.currentVolume;
      topVolumeKey = s.normalizedLabel;
    }
  }

  return partial.map((s) => {
    let tier: Tier;
    if (s.isChronic) tier = 1;
    else if (s.isHighPriorityNegative) tier = 2;
    else if (s.normalizedLabel === topVolumeKey && topVolume >= minVolume) tier = 3;
    else if (s.affectedFacilityCount > 1) tier = 4;
    else if (s.isRelapse) tier = 5;
    else tier = 6;
    return { ...s, tier };
  });
}

function compareWithinTier(a: ClassificationTopicSignal, b: ClassificationTopicSignal): number {
  return (
    b.maxPriorityScore - a.maxPriorityScore
    || b.highPriorityFollowUpVotes - a.highPriorityFollowUpVotes
    || b.currentVolume - a.currentVolume
    || a.label.localeCompare(b.label, "ar")
  );
}

/** Flattened tier-1..tier-6 ranking (spec §2) — the order candidate topics are considered in. */
function rankClassificationTopics(signals: readonly ClassificationTopicSignal[]): ClassificationTopicSignal[] {
  const byTier = new Map<Tier, ClassificationTopicSignal[]>();
  for (const s of signals) {
    const list = byTier.get(s.tier) ?? [];
    list.push(s);
    byTier.set(s.tier, list);
  }
  const ranked: ClassificationTopicSignal[] = [];
  for (const tier of [1, 2, 3, 4, 5, 6] as const) {
    ranked.push(...(byTier.get(tier) ?? []).sort(compareWithinTier));
  }
  return ranked;
}

/** A topic that still justifies repeating a recently-shown practice (spec §5 exception). */
function isPersistentTopic(signal: ClassificationTopicSignal): boolean {
  return signal.isChronic || signal.isHighPriorityNegative || signal.tier <= 3;
}

function baseReasonForTier(tier: Tier): OperationalPracticeSelectionReason {
  return tier === 3 || tier === 6 ? "REPORT_VOLUME" : "REPORT_PRIORITY";
}

// ---------------------------------------------------------------------------
// 5. Deterministic general-pool rotation (spec §4 — report period, never Math.random)
// ---------------------------------------------------------------------------

function hashReportPeriod(period: { from: string; to: string }): number {
  const str = `${period.from}|${period.to}`;
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function pickGeneralRotationPractices(
  count: number,
  usedPracticeIds: ReadonlySet<string>,
  recentPracticeIds: ReadonlySet<string>,
  reportPeriod: { from: string; to: string }
): OperationalPracticeRow[] {
  if (count <= 0) return [];
  const pool = GENERAL_OPERATIONAL_PRACTICE_IDS.filter((id) => !usedPracticeIds.has(id));
  if (pool.length === 0) return [];

  const startIndex = hashReportPeriod(reportPeriod) % pool.length;
  const picks: OperationalPracticeRow[] = [];
  const taken = new Set<string>();

  // Pass 1: prefer ids not shown in the last 3 reports.
  for (let step = 0; step < pool.length && picks.length < count; step++) {
    const id = pool[(startIndex + step) % pool.length];
    if (taken.has(id) || recentPracticeIds.has(id)) continue;
    taken.add(id);
    const practice = getOperationalPracticeById(id);
    if (practice) picks.push(toRow(practice, "GENERAL_ROTATION"));
  }
  // Pass 2: the general pool is small — if every remaining id was recently
  // shown, repeat one rather than leaving a card empty (a repeated generic
  // tip is harmless, unlike repeating a problem-specific claim).
  for (let step = 0; step < pool.length && picks.length < count; step++) {
    const id = pool[(startIndex + step) % pool.length];
    if (taken.has(id)) continue;
    taken.add(id);
    const practice = getOperationalPracticeById(id);
    if (practice) picks.push(toRow(practice, "GENERAL_ROTATION"));
  }
  return picks;
}

// ---------------------------------------------------------------------------
// 6. Public selector
// ---------------------------------------------------------------------------

export const OPERATIONAL_PRACTICE_CARD_COUNT = 4;
const DATA_LINKED_CARD_COUNT = 3;

export type SelectOperationalPracticesInput = {
  classificationTrends: readonly ClassificationTrendRow[];
  facilitiesNeedingFollowUp: readonly FacilityFollowUpRow[];
  patternFindings: readonly AnalyticalFinding[];
  /** Practice ids shown in the last 3 comparable reports — see report-executive-brief-data-service.ts for the current limitation. */
  recentPracticeIds: readonly string[];
  reportPeriod: { from: string; to: string };
};

function pickDataLinkedPractice(
  candidates: readonly OperationalPractice[],
  topic: ClassificationTopicSignal,
  usedPracticeIds: ReadonlySet<string>,
  usedTopics: ReadonlySet<OperationalPracticeTopic>,
  recentPracticeIds: ReadonlySet<string>
): OperationalPracticeRow | null {
  // A topic already represented by an earlier (higher-ranked) pick is never
  // reconsidered here — each of the (up to) 3 data-linked slots must be a
  // genuinely DIFFERENT topic (spec: "3 موضوعات مختلفة فعلياً"). When fewer
  // than 3 distinct, matchable topics exist this period, the caller fills
  // the remaining slot(s) from the general pool instead of repeating a topic.
  const eligible = candidates.filter((c) => !usedPracticeIds.has(c.id) && !usedTopics.has(c.topic));

  const fresh = eligible.find((c) => !recentPracticeIds.has(c.id));
  if (fresh) return toRow(fresh, baseReasonForTier(topic.tier));

  // Every remaining candidate for this topic was shown recently. Only reuse
  // one when the underlying problem is still genuinely urgent (spec §5).
  if (eligible.length > 0 && isPersistentTopic(topic)) {
    return toRow(eligible[0], "PERSISTENT_PROBLEM");
  }
  return null;
}

/**
 * Picks the 4 "ممارسات تشغيلية مقترحة" cards for one report: up to 3 tied to
 * this period's most important, DISTINCT classification topics (spec §2-3 —
 * one practice per topic, never two for the same topic), plus a general/
 * rotating practice filling the 4th slot AND any data-linked slot a
 * genuinely distinct, matchable topic could not be found for (spec: don't
 * pick two GENERAL practices when a third real topic with a suitable
 * practice exists, but do fall back to the general pool when it doesn't).
 * Pure, deterministic — same input always produces the same 4 ids; never
 * Math.random.
 */
export function selectOperationalPractices(
  input: SelectOperationalPracticesInput
): OperationalPracticeRow[] {
  const recentSet = new Set(input.recentPracticeIds);
  const signals = buildClassificationTopicSignals(input);
  const rankedTopics = rankClassificationTopics(signals);

  const selected: OperationalPracticeRow[] = [];
  const usedPracticeIds = new Set<string>();
  const usedTopics = new Set<OperationalPracticeTopic>();

  for (const topic of rankedTopics) {
    if (selected.length >= DATA_LINKED_CARD_COUNT) break;
    const candidates = findMatchingPractices(topic.normalizedLabel);
    const pick = pickDataLinkedPractice(candidates, topic, usedPracticeIds, usedTopics, recentSet);
    if (pick) {
      selected.push(pick);
      usedPracticeIds.add(pick.id);
      usedTopics.add(pick.topic);
    }
  }

  const remaining = OPERATIONAL_PRACTICE_CARD_COUNT - selected.length;
  selected.push(...pickGeneralRotationPractices(remaining, usedPracticeIds, recentSet, input.reportPeriod));

  return selected.slice(0, OPERATIONAL_PRACTICE_CARD_COUNT);
}
