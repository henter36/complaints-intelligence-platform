import { UNSPECIFIED_REGION_KEY, normalizeRegionName } from "@/lib/reports/region-normalization";
import { normalizeArabic } from "@/server/imports/arabic-normalize";
import { normalizeTextCell } from "@/server/imports/normalization";

const UNSPECIFIED_FACILITY_KEY = normalizeArabic("غير محدد");

export function normalizeFacilityDisplayName(value: unknown): string | null {
  const displayName = normalizeTextCell(value)?.replaceAll("\n", " ");
  if (!displayName) return null;

  const key = normalizeArabic(displayName)
    .replaceAll(/\s+/g, " ")
    .toLocaleLowerCase("ar-SA");
  if (!key || key === UNSPECIFIED_FACILITY_KEY) return null;
  return displayName;
}

export function normalizeFacilityName(value: unknown): string | null {
  const displayName = normalizeFacilityDisplayName(value);
  if (!displayName) return null;
  return normalizeArabic(displayName)
    .replaceAll(/\s+/g, " ")
    .toLocaleLowerCase("ar-SA");
}

export function normalizeFacilityRegion(value: unknown): string | null {
  const displayName = normalizeTextCell(value)?.replaceAll("\n", " ");
  if (!displayName) return null;
  const canonical = normalizeRegionName(displayName);
  return canonical === UNSPECIFIED_REGION_KEY ? null : canonical;
}
