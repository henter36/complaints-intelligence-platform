import { normalizeArabic } from "@/server/imports/arabic-normalize";

/** Internal sentinel for missing / blank region values. */
export const UNSPECIFIED_REGION_KEY = "__unspecified__";

/** Arabic display label for the unspecified region bucket. */
export const UNSPECIFIED_REGION_LABEL = "غير محدد";

/**
 * @deprecated Prefer UNSPECIFIED_REGION_KEY for Map keys and UNSPECIFIED_REGION_LABEL for display.
 * Kept as the display label so existing call sites that show the value remain correct.
 */
export const UNSPECIFIED_REGION = UNSPECIFIED_REGION_LABEL;

/** Canonical display names prevent variants such as الرياض/منطقة الرياض. */
const SAUDI_REGION_NAMES = [
  "منطقة الرياض",
  "منطقة مكة المكرمة",
  "منطقة المدينة المنورة",
  "منطقة القصيم",
  "المنطقة الشرقية",
  "منطقة عسير",
  "منطقة تبوك",
  "منطقة حائل",
  "منطقة الحدود الشمالية",
  "منطقة جازان",
  "منطقة نجران",
  "منطقة الباحة",
  "منطقة الجوف",
] as const;

type SaudiRegionName = (typeof SAUDI_REGION_NAMES)[number];

/**
 * Extra aliases beyond the canonical name itself.
 * Keys are already passed through regionKey when building the lookup map.
 * Do not add forms that regionKey already collapses (e.g. "منطقه الشرقيه" → "الشرقيه").
 */
const REGION_ALIASES_BY_CANONICAL: Partial<Record<SaudiRegionName, readonly string[]>> = {
  "المنطقة الشرقية": ["الشرقيه"],
  "منطقة مكة المكرمة": ["مكه", "مكه المكرمه"],
  "منطقة المدينة المنورة": ["المدينه", "المدينه المنوره"],
  "منطقة الرياض": ["الرياض"],
};

function regionKey(value: string): string {
  return normalizeArabic(value)
    .replace(/^منطقه\s+/, "")
    .replace(/^اماره\s+منطقه\s+/, "")
    .replace(/^اماره\s+/, "")
    .trim();
}

const CANONICAL_REGION_BY_KEY = new Map(
  SAUDI_REGION_NAMES.flatMap((canonicalName) => {
    const aliases = REGION_ALIASES_BY_CANONICAL[canonicalName] ?? [];
    return [canonicalName, ...aliases].map(
      (alias) => [regionKey(alias), canonicalName] as const
    );
  })
);

/**
 * Canonical region key for aggregation. Blank → UNSPECIFIED_REGION_KEY.
 * Known Saudi aliases collapse to one canonical Arabic name.
 * Unknown non-blank values stay as trimmed display text (never guessed into a Saudi region).
 */
export function normalizeRegionName(value: string | null | undefined): string {
  const display = value?.trim().replace(/\s+/g, " ");
  if (!display) return UNSPECIFIED_REGION_KEY;
  if (display === UNSPECIFIED_REGION_KEY || display === UNSPECIFIED_REGION_LABEL) {
    return UNSPECIFIED_REGION_KEY;
  }
  return CANONICAL_REGION_BY_KEY.get(regionKey(display)) ?? display;
}

/** User-facing region label (maps the unspecified sentinel to Arabic). */
export function displayRegionName(canonicalKey: string): string {
  return canonicalKey === UNSPECIFIED_REGION_KEY ? UNSPECIFIED_REGION_LABEL : canonicalKey;
}

export type RegionalReconciliationInput = {
  currentRows: ReadonlyArray<{ currentCount: number }>;
  previousRows: ReadonlyArray<{ previousCount: number }>;
  currentTotal: number;
  previousTotal: number | null;
  unmatchedCurrent?: number;
  unmatchedPrevious?: number;
};

/**
 * Ensures every period complaint lands in exactly one regional bucket
 * (including the unspecified bucket). Throws when sums drift.
 */
export function assertRegionalReconciliation(input: RegionalReconciliationInput): void {
  const unmatchedCurrent = input.unmatchedCurrent ?? 0;
  const unmatchedPrevious = input.unmatchedPrevious ?? 0;
  const currentSum =
    input.currentRows.reduce((sum, row) => sum + row.currentCount, 0) + unmatchedCurrent;
  if (currentSum !== input.currentTotal) {
    throw new Error(
      `Regional current sum ${currentSum} !== currentTotal ${input.currentTotal}`
    );
  }
  if (input.previousTotal === null) return;
  const previousSum =
    input.previousRows.reduce((sum, row) => sum + row.previousCount, 0) + unmatchedPrevious;
  if (previousSum !== input.previousTotal) {
    throw new Error(
      `Regional previous sum ${previousSum} !== previousTotal ${input.previousTotal}`
    );
  }
}
