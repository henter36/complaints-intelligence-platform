import { normalizeArabic } from "@/server/imports/arabic-normalize";

/**
 * Shared keyword / source-detail value normalization for client and server.
 * Keeps Arabic character rules, whitespace collapse, and ar-SA case folding consistent.
 */
export function normalizeClassificationKeyword(value: string): string {
  return normalizeArabic(value)
    .replaceAll(/\s+/g, " ")
    .toLocaleLowerCase("ar-SA");
}
