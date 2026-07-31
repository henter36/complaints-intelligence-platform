export const SORT_LOCALE = "en";

export function compareJsonKeys(a: string, b: string): number {
  return a.localeCompare(b, SORT_LOCALE, { sensitivity: "base", numeric: true });
}

export function normalizeJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  const obj = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(obj).sort(compareJsonKeys).map(k => [k, normalizeJsonValue(obj[k])])
  );
}
