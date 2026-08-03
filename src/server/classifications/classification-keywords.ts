export function parseClassificationKeywords(value: unknown): string[] {
  if (value === null || value === undefined) return [];

  if (!Array.isArray(value)) {
    throw new TypeError("CLASSIFICATION_KEYWORDS_SHAPE_INVALID");
  }

  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new TypeError("CLASSIFICATION_KEYWORDS_SHAPE_INVALID");
    }
    const trimmed = item.trim();
    if (trimmed) result.push(trimmed);
  }
  return result;
}
