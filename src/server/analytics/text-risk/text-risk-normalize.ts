import { normalizeArabic } from "@/server/imports/arabic-normalize";

// Maximum input length — texts longer than this are truncated before matching
// to prevent O(n) string scanning on enormous inputs.
const MAX_INPUT_LENGTH = 5000;

// Punctuation characters to collapse to a space for matching purposes.
// Using a character class without quantifier nesting — linear O(n) performance.
const PUNCTUATION_RE = /[،,؛;:.!?،؟]/g;

// Multiple spaces → single space.
const MULTI_SPACE_RE = /\s\s+/g;

/**
 * Normalizes Arabic text for matching purposes only.
 * The original text is never modified.
 * Applies: tashkeel removal, tatweel removal, alef variants, ya/taa marbuta,
 *          punctuation collapse, whitespace normalization.
 */
export function normalizeForMatching(text: string): string {
  const truncated = text.length > MAX_INPUT_LENGTH ? text.slice(0, MAX_INPUT_LENGTH) : text;
  return normalizeArabic(truncated)
    .replace(PUNCTUATION_RE, " ")
    .replace(MULTI_SPACE_RE, " ")
    .trim();
}

/**
 * Combines subject and description into a single normalized text for matching.
 * Records the char offset of where description starts (for evidence span mapping).
 */
export function buildMatchableText(
  subject: string,
  description: string | null
): { text: string; descriptionOffset: number } {
  const normSubject = normalizeForMatching(subject);
  if (!description) {
    return { text: normSubject, descriptionOffset: normSubject.length };
  }
  const normDescription = normalizeForMatching(description);
  const combined = `${normSubject} ${normDescription}`;
  return { text: combined, descriptionOffset: normSubject.length + 1 };
}
