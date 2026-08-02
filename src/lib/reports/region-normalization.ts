import { normalizeArabic } from "@/server/imports/arabic-normalize";

export const UNSPECIFIED_REGION = "غير محدد";

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

function regionKey(value: string): string {
  return normalizeArabic(value)
    .replace(/^منطقه\s+/, "")
    .replace(/^اماره\s+منطقه\s+/, "")
    .replace(/^اماره\s+/, "")
    .trim();
}

const CANONICAL_REGION_BY_KEY = new Map(
  SAUDI_REGION_NAMES.flatMap((name) => {
    const key = regionKey(name);
    const aliases: Array<[string, string]> = [[key, name]];
    if (name === "المنطقة الشرقية") aliases.push(["الشرقيه", name]);
    if (name === "منطقة مكة المكرمة") aliases.push(["مكه", name]);
    if (name === "منطقة المدينة المنورة") aliases.push(["المدينه", name]);
    return aliases;
  })
);

export function normalizeRegionName(value: string | null | undefined): string {
  const display = value?.trim().replace(/\s+/g, " ");
  if (!display) return UNSPECIFIED_REGION;
  return CANONICAL_REGION_BY_KEY.get(regionKey(display)) ?? display;
}
