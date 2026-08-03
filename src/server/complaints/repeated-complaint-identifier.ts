const ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const EASTERN_ARABIC_INDIC_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

function normalizeDigit(character: string): string {
  const arabicIndicIndex = ARABIC_INDIC_DIGITS.indexOf(character);
  if (arabicIndicIndex >= 0) return String(arabicIndicIndex);

  const easternIndex = EASTERN_ARABIC_INDIC_DIGITS.indexOf(character);
  if (easternIndex >= 0) return String(easternIndex);

  return character;
}

export function normalizeComplainantIdentifier(
  value: string | null | undefined
): string | undefined {
  if (typeof value !== "string") return undefined;

  const normalized = [...value.trim()]
    .map(normalizeDigit)
    .join("")
    .replaceAll(/\s+/g, "");

  return normalized || undefined;
}

export function countComplaintsByIdentifier(
  values: readonly (string | null | undefined)[]
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const value of values) {
    const normalized = normalizeComplainantIdentifier(value);
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  return counts;
}

export function isRepeatedComplainantIdentifier(
  value: string | null | undefined,
  counts: ReadonlyMap<string, number>
): boolean {
  const normalized = normalizeComplainantIdentifier(value);
  return normalized ? (counts.get(normalized) ?? 0) > 1 : false;
}
