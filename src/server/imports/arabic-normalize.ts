/**
 * Shared Arabic character normalization for import matching.
 * Call-site-specific extras (whitespace collapse, locale case folding) stay outside.
 */
export function normalizeArabic(value: string): string {
  return value
    .trim()
    .replaceAll(/[\u064B-\u065F\u0670]/g, "")
    .replaceAll("\u0640", "")
    .replaceAll(/[إأآا]/g, "ا")
    .replaceAll("ى", "ي")
    .replaceAll("ة", "ه");
}
