/**
 * Locale-independent string ordering for persisted/canonical hashes.
 * Uses UTF-16 code unit order so Node/ICU differences cannot change fingerprints.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
