import { ComplaintPriority, TextRiskSignalType } from "@prisma/client";
import type { TextRiskCertainty } from "@prisma/client";

// Single source of truth — bump this when any rule changes.
export const RULE_CATALOG_VERSION = "rule-v1";

// Proximity window (chars in normalized text) for AND-term groups.
const WIDE_WINDOW = 120;
const NARROW_WINDOW = 60;

// How many chars of normalized text to extract around a match.
export const EVIDENCE_WINDOW_CHARS = 150;

// Maximum length of normalized text fed to the matcher.
export const MAX_TEXT_LENGTH_CHARS = 5000;

export type TextRiskRule = Readonly<{
  ruleId: string;
  signalType: TextRiskSignalType;
  title: string;
  severity: ComplaintPriority;
  // Primary phrase groups: OR between groups, AND between tokens within a group.
  // Each token is a normalized Arabic substring that must appear in the text.
  primaryGroups: ReadonlyArray<ReadonlyArray<string>>;
  // Window (chars) within which AND-tokens must all appear.
  groupWindowChars: number;
  // Normalized tokens whose presence near a match negates it.
  negationTokens: ReadonlyArray<string>;
  // Window (chars) within which a negation token cancels the match.
  negationWindowChars: number;
  // Tokens that raise certainty to SUSPECTED (if match is not negated).
  suspicionTokens: ReadonlyArray<string>;
  // Tokens that indicate ALLEGED certainty.
  allegationTokens: ReadonlyArray<string>;
  // Tokens that indicate the event is historical and resolved.
  historicalTokens: ReadonlyArray<string>;
  // Tokens that indicate the event is still ongoing.
  ongoingTokens: ReadonlyArray<string>;
  // Base confidence when a match is found (0–1).
  baseConfidence: number;
}>;

// ---------- Shared token lists ----------

const COMMON_NEGATION: ReadonlyArray<string> = [
  "لا يوجد",
  "لا توجد",
  "لم يحدث",
  "لم يكن",
  "لم تحدث",
  "لم يتم",
  "لم تكن",
  "لن يكون",
  "نفي",
  "نفت",
  "نفي وجود",
  "غير صحيح",
  "غير حقيقي",
  "ثبت عدم",
  "لا اشتباه",
  "لا يوجد اشتباه",
  "لا يوجد دليل",
];

const COMMON_SUSPICION: ReadonlyArray<string> = [
  "اشتباه",
  "يشتبه",
  "محتمل",
  "قد يكون",
  "يحتمل",
  "ربما",
  "يبدو",
  "يظن",
  "اعتقد",
  "ربما يكون",
];

const COMMON_ALLEGATION: ReadonlyArray<string> = [
  "يدعي",
  "ادعاء",
  "يزعم",
  "زعم",
  "افاد",
  "ذكر",
  "اشتكي",
  "يقول",
  "اخبر",
  "اكد",
];

const COMMON_HISTORICAL: ReadonlyArray<string> = [
  "تم اصلاح",
  "تم الاصلاح",
  "تمت المعالجه",
  "عادت الخدمه",
  "عاد التيار",
  "عادت الكهرباء",
  "استعيد",
  "تم الاطلاق",
  "اطلق سراح",
  "سابقا",
  "قديم",
  "سبق",
  "تم حل",
  "حل المشكله",
  "انتهت المشكله",
];

const COMMON_ONGOING: ReadonlyArray<string> = [
  "لا يزال",
  "مازال",
  "ما زال",
  "مستمر",
  "حتى الان",
  "لحد الان",
  "لم يتم الاصلاح",
  "لم يتم الحل",
  "مستمره",
  "لا يزال مستمر",
  "منذ",
  "حتي الان",
];

// ---------- Rule catalog ----------

export const TEXT_RISK_RULES: ReadonlyArray<TextRiskRule> = [

  // ── SERVICE_OUTAGE ──────────────────────────────────────────────────────────
  {
    ruleId: "SVC_OUT_001",
    signalType: TextRiskSignalType.SERVICE_OUTAGE,
    title: "انقطاع الكهرباء",
    severity: ComplaintPriority.HIGH,
    primaryGroups: [
      ["انقطاع", "كهرباء"],
      ["انقطاع", "تيار"],
      ["انقطع", "التيار"],
      ["انقطع", "الكهرباء"],
      ["تعطل", "كهرباء"],
      ["انقطاع الكهرباء"],
    ],
    groupWindowChars: WIDE_WINDOW,
    negationTokens: COMMON_NEGATION,
    negationWindowChars: NARROW_WINDOW,
    suspicionTokens: COMMON_SUSPICION,
    allegationTokens: COMMON_ALLEGATION,
    historicalTokens: COMMON_HISTORICAL,
    ongoingTokens: COMMON_ONGOING,
    baseConfidence: 0.85,
  },

  {
    ruleId: "SVC_OUT_002",
    signalType: TextRiskSignalType.SERVICE_OUTAGE,
    title: "انقطاع المياه",
    severity: ComplaintPriority.HIGH,
    primaryGroups: [
      ["انقطاع", "مياه"],
      ["انقطاع", "ماء"],
      ["انقطع", "الماء"],
      ["انقطع", "المياه"],
      ["انقطاع المويه"],
      ["نقص", "مياه"],
      ["انعدام", "مياه"],
    ],
    groupWindowChars: WIDE_WINDOW,
    negationTokens: COMMON_NEGATION,
    negationWindowChars: NARROW_WINDOW,
    suspicionTokens: COMMON_SUSPICION,
    allegationTokens: COMMON_ALLEGATION,
    historicalTokens: COMMON_HISTORICAL,
    ongoingTokens: COMMON_ONGOING,
    baseConfidence: 0.85,
  },

  {
    ruleId: "SVC_OUT_003",
    signalType: TextRiskSignalType.SERVICE_OUTAGE,
    title: "تعطل التكييف",
    severity: ComplaintPriority.MEDIUM,
    primaryGroups: [
      ["تعطل", "تكييف"],
      ["تعطل", "مكيف"],
      ["تعطل التكييف"],
      ["تعطل المكيف"],
      ["توقف", "تكييف"],
      ["لا يعمل", "تكييف"],
      ["عطل", "تكييف"],
    ],
    groupWindowChars: WIDE_WINDOW,
    negationTokens: COMMON_NEGATION,
    negationWindowChars: NARROW_WINDOW,
    suspicionTokens: COMMON_SUSPICION,
    allegationTokens: COMMON_ALLEGATION,
    historicalTokens: COMMON_HISTORICAL,
    ongoingTokens: COMMON_ONGOING,
    baseConfidence: 0.80,
  },

  {
    ruleId: "SVC_OUT_004",
    signalType: TextRiskSignalType.SERVICE_OUTAGE,
    title: "تعطل الشبكة أو النظام",
    severity: ComplaintPriority.HIGH,
    primaryGroups: [
      ["تعطل", "شبكه"],
      ["تعطل", "نظام"],
      ["تعطل السيستم"],
      ["توقف", "شبكه"],
      ["توقف", "نظام"],
      ["انهيار", "شبكه"],
      ["انهيار", "نظام"],
      ["عطل", "شبكه"],
      ["عطل", "نظام"],
    ],
    groupWindowChars: WIDE_WINDOW,
    negationTokens: COMMON_NEGATION,
    negationWindowChars: NARROW_WINDOW,
    suspicionTokens: COMMON_SUSPICION,
    allegationTokens: COMMON_ALLEGATION,
    historicalTokens: COMMON_HISTORICAL,
    ongoingTokens: COMMON_ONGOING,
    baseConfidence: 0.80,
  },

  {
    ruleId: "SVC_OUT_005",
    signalType: TextRiskSignalType.SERVICE_OUTAGE,
    title: "توقف خدمة الإعاشة أو النقل",
    severity: ComplaintPriority.HIGH,
    primaryGroups: [
      ["توقف", "اعاشه"],
      ["انقطاع", "اعاشه"],
      ["توقف", "وجبات"],
      ["انقطاع", "وجبات"],
      ["توقف", "نقل"],
      ["انقطاع", "نقل"],
      ["توقف", "اعاشه"],
      ["توقف خدمه", "اعاشه"],
    ],
    groupWindowChars: WIDE_WINDOW,
    negationTokens: COMMON_NEGATION,
    negationWindowChars: NARROW_WINDOW,
    suspicionTokens: COMMON_SUSPICION,
    allegationTokens: COMMON_ALLEGATION,
    historicalTokens: COMMON_HISTORICAL,
    ongoingTokens: COMMON_ONGOING,
    baseConfidence: 0.82,
  },

  // ── INFRASTRUCTURE_FAILURE ──────────────────────────────────────────────────
  {
    ruleId: "INFRA_001",
    signalType: TextRiskSignalType.INFRASTRUCTURE_FAILURE,
    title: "حريق",
    severity: ComplaintPriority.CRITICAL,
    primaryGroups: [
      ["حريق"],
      ["اندلع", "نار"],
      ["اشتعل"],
      ["حريق مشتعل"],
    ],
    groupWindowChars: WIDE_WINDOW,
    negationTokens: COMMON_NEGATION,
    negationWindowChars: NARROW_WINDOW,
    suspicionTokens: COMMON_SUSPICION,
    allegationTokens: COMMON_ALLEGATION,
    historicalTokens: COMMON_HISTORICAL,
    ongoingTokens: COMMON_ONGOING,
    baseConfidence: 0.90,
  },

  {
    ruleId: "INFRA_002",
    signalType: TextRiskSignalType.INFRASTRUCTURE_FAILURE,
    title: "تسرب",
    severity: ComplaintPriority.HIGH,
    primaryGroups: [
      ["تسرب"],
      ["تسريب"],
      ["يتسرب"],
      ["تسرب مياه"],
      ["تسرب غاز"],
      ["كرب غاز"],
    ],
    groupWindowChars: WIDE_WINDOW,
    negationTokens: COMMON_NEGATION,
    negationWindowChars: NARROW_WINDOW,
    suspicionTokens: COMMON_SUSPICION,
    allegationTokens: COMMON_ALLEGATION,
    historicalTokens: COMMON_HISTORICAL,
    ongoingTokens: COMMON_ONGOING,
    baseConfidence: 0.82,
  },

  // ── POISONING ───────────────────────────────────────────────────────────────
  {
    ruleId: "POISON_001",
    signalType: TextRiskSignalType.POISONING,
    title: "تسمم أو اشتباه تسمم",
    severity: ComplaintPriority.CRITICAL,
    primaryGroups: [
      ["تسمم"],
      ["حالات تسمم"],
      ["اعراض تسمم"],
      ["غثيان", "اقياء", "نزله"],
    ],
    groupWindowChars: WIDE_WINDOW,
    negationTokens: COMMON_NEGATION,
    negationWindowChars: NARROW_WINDOW,
    suspicionTokens: COMMON_SUSPICION,
    allegationTokens: COMMON_ALLEGATION,
    historicalTokens: COMMON_HISTORICAL,
    ongoingTokens: COMMON_ONGOING,
    baseConfidence: 0.88,
  },

  // ── PUBLIC_HEALTH ────────────────────────────────────────────────────────────
  {
    ruleId: "HEALTH_001",
    signalType: TextRiskSignalType.PUBLIC_HEALTH,
    title: "انتشار مرض أو عدوى جماعية",
    severity: ComplaintPriority.CRITICAL,
    primaryGroups: [
      ["انتشار", "مرض"],
      ["انتشار", "عدوي"],
      ["انتشار", "وباء"],
      ["اعراض", "متشابهه"],
      ["اعراض", "جماعيه"],
      ["عدوي", "جماعيه"],
      ["حمي", "متكرره"],
      ["اصابه", "جماعيه"],
    ],
    groupWindowChars: WIDE_WINDOW,
    negationTokens: COMMON_NEGATION,
    negationWindowChars: NARROW_WINDOW,
    suspicionTokens: COMMON_SUSPICION,
    allegationTokens: COMMON_ALLEGATION,
    historicalTokens: COMMON_HISTORICAL,
    ongoingTokens: COMMON_ONGOING,
    baseConfidence: 0.85,
  },

  {
    ruleId: "HEALTH_002",
    signalType: TextRiskSignalType.PUBLIC_HEALTH,
    title: "وفاة أو فقدان وعي أو تأخر إسعاف",
    severity: ComplaintPriority.CRITICAL,
    primaryGroups: [
      ["وفاه"],
      ["فقد", "وعي"],
      ["فقدان", "وعي"],
      ["تاخر", "اسعاف"],
      ["تاخر", "الاسعاف"],
      ["لم يصل", "اسعاف"],
      ["انتهت", "حياته"],
      ["انتهي", "اجله"],
    ],
    groupWindowChars: WIDE_WINDOW,
    negationTokens: [...COMMON_NEGATION, "طبيعي", "سليم", "بخير"],
    negationWindowChars: NARROW_WINDOW,
    suspicionTokens: COMMON_SUSPICION,
    allegationTokens: COMMON_ALLEGATION,
    historicalTokens: COMMON_HISTORICAL,
    ongoingTokens: COMMON_ONGOING,
    baseConfidence: 0.87,
  },

  // ── MEDICATION_SHORTAGE ──────────────────────────────────────────────────────
  {
    ruleId: "MED_001",
    signalType: TextRiskSignalType.MEDICATION_SHORTAGE,
    title: "نقص دواء ضروري",
    severity: ComplaintPriority.CRITICAL,
    primaryGroups: [
      ["نقص", "دواء"],
      ["نقص", "الدواء"],
      ["نقص الادويه"],
      ["انعدام", "دواء"],
      ["لا يوجد", "دواء"],
      ["عدم توفر", "دواء"],
      ["نفاد", "دواء"],
    ],
    groupWindowChars: WIDE_WINDOW,
    negationTokens: ["يوجد دواء", "تم توفير", "تم توفر", "صرف الدواء", "تم الصرف"],
    negationWindowChars: NARROW_WINDOW,
    suspicionTokens: COMMON_SUSPICION,
    allegationTokens: COMMON_ALLEGATION,
    historicalTokens: ["تم توفير الدواء", "صرف الدواء", "توافر الدواء"],
    ongoingTokens: COMMON_ONGOING,
    baseConfidence: 0.88,
  },

  // ── FOOD_OR_WATER_SAFETY ─────────────────────────────────────────────────────
  {
    ruleId: "FOOD_001",
    signalType: TextRiskSignalType.FOOD_OR_WATER_SAFETY,
    title: "تلوث الغذاء أو المياه",
    severity: ComplaintPriority.CRITICAL,
    primaryGroups: [
      ["تلوث", "غذاء"],
      ["تلوث", "طعام"],
      ["تلوث", "مياه"],
      ["تلوث", "ماء"],
      ["طعام فاسد"],
      ["طعام ملوث"],
      ["طعام", "تالف"],
      ["مياه ملوثه"],
      ["مياه", "غير صالحه"],
    ],
    groupWindowChars: WIDE_WINDOW,
    negationTokens: COMMON_NEGATION,
    negationWindowChars: NARROW_WINDOW,
    suspicionTokens: COMMON_SUSPICION,
    allegationTokens: COMMON_ALLEGATION,
    historicalTokens: COMMON_HISTORICAL,
    ongoingTokens: COMMON_ONGOING,
    baseConfidence: 0.87,
  },

  // ── SENTENCE_EXPIRY ──────────────────────────────────────────────────────────
  {
    ruleId: "SENT_001",
    signalType: TextRiskSignalType.SENTENCE_EXPIRY,
    title: "انتهاء محكومية دون إطلاق",
    severity: ComplaintPriority.CRITICAL,
    primaryGroups: [
      ["انتهاء", "محكوميه", "اطلاق"],
      ["انتهت", "محكوميه", "اطلاق"],
      ["محكوميه", "انتهت", "لم يطلق"],
      ["انتهاء المحكوميه"],
      ["انتهاء محكوميته"],
      ["انتهاء المحكوميه", "سراح"],
      ["انتهي", "محكوميه"],
      ["انتهي المده", "اطلاق"],
    ],
    groupWindowChars: WIDE_WINDOW,
    negationTokens: ["لم تنته", "لم تنتهي", "لم تنته محكوميته", ...COMMON_NEGATION],
    negationWindowChars: NARROW_WINDOW,
    suspicionTokens: COMMON_SUSPICION,
    allegationTokens: COMMON_ALLEGATION,
    historicalTokens: ["تم الاطلاق", "اطلق سراحه", "افرج عنه"],
    ongoingTokens: [...COMMON_ONGOING, "لا يزال محتجز", "لم يطلق", "لم يفرج"],
    baseConfidence: 0.88,
  },

  // ── LEGAL_DELAY ──────────────────────────────────────────────────────────────
  {
    ruleId: "LEGAL_001",
    signalType: TextRiskSignalType.LEGAL_DELAY,
    title: "تأخر تنفيذ أمر قضائي",
    severity: ComplaintPriority.HIGH,
    primaryGroups: [
      ["تاخر", "امر قضائي"],
      ["تاخر", "تنفيذ", "قضائي"],
      ["امر قضائي", "لم ينفذ"],
      ["قرار قضائي", "لم ينفذ"],
      ["تاخر تنفيذ"],
    ],
    groupWindowChars: WIDE_WINDOW,
    negationTokens: COMMON_NEGATION,
    negationWindowChars: NARROW_WINDOW,
    suspicionTokens: COMMON_SUSPICION,
    allegationTokens: COMMON_ALLEGATION,
    historicalTokens: ["تم التنفيذ", "نفذ الامر", "نفذ القرار"],
    ongoingTokens: [...COMMON_ONGOING, "لم ينفذ", "لا يزال"],
    baseConfidence: 0.83,
  },

  {
    ruleId: "LEGAL_002",
    signalType: TextRiskSignalType.LEGAL_DELAY,
    title: "عدم احتساب مدة الاحتجاز",
    severity: ComplaintPriority.HIGH,
    primaryGroups: [
      ["عدم احتساب", "مده"],
      ["لم تحتسب", "مده"],
      ["لم يحتسب", "مده"],
      ["مده احتجاز", "لم"],
      ["مده الاحتجاز", "غير محتسبه"],
      ["احتساب المده"],
    ],
    groupWindowChars: WIDE_WINDOW,
    negationTokens: COMMON_NEGATION,
    negationWindowChars: NARROW_WINDOW,
    suspicionTokens: COMMON_SUSPICION,
    allegationTokens: COMMON_ALLEGATION,
    historicalTokens: ["تم احتساب", "تمت احتساب", "احتسبت المده"],
    ongoingTokens: COMMON_ONGOING,
    baseConfidence: 0.83,
  },

  {
    ruleId: "LEGAL_003",
    signalType: TextRiskSignalType.LEGAL_DELAY,
    title: "تكرار التأخر في العرض على المحكمة",
    severity: ComplaintPriority.HIGH,
    primaryGroups: [
      ["تاخر", "عرض", "محكمه"],
      ["لم يعرض", "محكمه"],
      ["تكرر", "تاخر", "محكمه"],
      ["محكمه", "تاخير", "عرض"],
      ["جلسه", "تاجلت"],
      ["تاجيل", "الجلسه"],
    ],
    groupWindowChars: WIDE_WINDOW,
    negationTokens: COMMON_NEGATION,
    negationWindowChars: NARROW_WINDOW,
    suspicionTokens: COMMON_SUSPICION,
    allegationTokens: COMMON_ALLEGATION,
    historicalTokens: ["تم العرض", "عرض علي المحكمه", "تمت الجلسه"],
    ongoingTokens: COMMON_ONGOING,
    baseConfidence: 0.82,
  },

  // ── SECURITY_INCIDENT ────────────────────────────────────────────────────────
  {
    ruleId: "SEC_001",
    signalType: TextRiskSignalType.SECURITY_INCIDENT,
    title: "اعتداء أو تهديد",
    severity: ComplaintPriority.CRITICAL,
    primaryGroups: [
      ["اعتداء"],
      ["اعتدي"],
      ["تهديد"],
      ["يهدد"],
      ["ضرب"],
      ["اعتداء جسدي"],
      ["ايذاء"],
    ],
    groupWindowChars: WIDE_WINDOW,
    negationTokens: COMMON_NEGATION,
    negationWindowChars: NARROW_WINDOW,
    suspicionTokens: COMMON_SUSPICION,
    allegationTokens: COMMON_ALLEGATION,
    historicalTokens: COMMON_HISTORICAL,
    ongoingTokens: COMMON_ONGOING,
    baseConfidence: 0.85,
  },

  {
    ruleId: "SEC_002",
    signalType: TextRiskSignalType.SECURITY_INCIDENT,
    title: "محاولة هروب",
    severity: ComplaintPriority.CRITICAL,
    primaryGroups: [
      ["محاوله هروب"],
      ["هروب"],
      ["حاول الهروب"],
    ],
    groupWindowChars: WIDE_WINDOW,
    negationTokens: COMMON_NEGATION,
    negationWindowChars: NARROW_WINDOW,
    suspicionTokens: COMMON_SUSPICION,
    allegationTokens: COMMON_ALLEGATION,
    historicalTokens: COMMON_HISTORICAL,
    ongoingTokens: COMMON_ONGOING,
    baseConfidence: 0.87,
  },

  {
    ruleId: "SEC_003",
    signalType: TextRiskSignalType.SECURITY_INCIDENT,
    title: "إدخال ممنوعات",
    severity: ComplaintPriority.CRITICAL,
    primaryGroups: [
      ["ادخال ممنوعات"],
      ["ممنوعات"],
      ["مخدرات"],
      ["ادخال", "محظورات"],
      ["تهريب"],
    ],
    groupWindowChars: WIDE_WINDOW,
    negationTokens: COMMON_NEGATION,
    negationWindowChars: NARROW_WINDOW,
    suspicionTokens: COMMON_SUSPICION,
    allegationTokens: COMMON_ALLEGATION,
    historicalTokens: COMMON_HISTORICAL,
    ongoingTokens: COMMON_ONGOING,
    baseConfidence: 0.87,
  },

  {
    ruleId: "SEC_004",
    signalType: TextRiskSignalType.SECURITY_INCIDENT,
    title: "تعطل كاميرات المراقبة",
    severity: ComplaintPriority.HIGH,
    primaryGroups: [
      ["تعطل", "مراقبه"],
      ["تعطل", "كاميرا"],
      ["تعطل", "كاميرات"],
      ["تعطل المراقبه"],
      ["توقف", "مراقبه"],
      ["عطل", "كاميرات"],
    ],
    groupWindowChars: WIDE_WINDOW,
    negationTokens: COMMON_NEGATION,
    negationWindowChars: NARROW_WINDOW,
    suspicionTokens: COMMON_SUSPICION,
    allegationTokens: COMMON_ALLEGATION,
    historicalTokens: COMMON_HISTORICAL,
    ongoingTokens: COMMON_ONGOING,
    baseConfidence: 0.82,
  },

  {
    ruleId: "SEC_005",
    signalType: TextRiskSignalType.SECURITY_INCIDENT,
    title: "فقدان مفتاح أو عهدة أمنية",
    severity: ComplaintPriority.HIGH,
    primaryGroups: [
      ["فقدان مفتاح"],
      ["فقد مفتاح"],
      ["ضياع مفتاح"],
      ["فقدان عهده"],
      ["فقد عهده"],
      ["عهده امنيه", "مفقود"],
      ["عهده", "مفقوده"],
    ],
    groupWindowChars: WIDE_WINDOW,
    negationTokens: COMMON_NEGATION,
    negationWindowChars: NARROW_WINDOW,
    suspicionTokens: COMMON_SUSPICION,
    allegationTokens: COMMON_ALLEGATION,
    historicalTokens: ["تم العثور", "وجد المفتاح", "استرجاع"],
    ongoingTokens: COMMON_ONGOING,
    baseConfidence: 0.83,
  },

] as const;

// Stable lookup map: ruleId → rule
export const RULE_BY_ID: ReadonlyMap<string, TextRiskRule> = new Map(
  TEXT_RISK_RULES.map((r) => [r.ruleId, r])
);

// Determine the resulting certainty given match context.
export function resolveCertainty(
  isNegated: boolean,
  hasSuspicion: boolean,
  hasAllegation: boolean,
  isHistorical: boolean
): TextRiskCertainty {
  if (isNegated) return "UNCLEAR";
  if (isHistorical) return "HISTORICAL_RESOLVED";
  if (hasSuspicion) return "SUSPECTED";
  if (hasAllegation) return "ALLEGED";
  return "CONFIRMED_IN_TEXT";
}
