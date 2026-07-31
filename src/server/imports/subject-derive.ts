export function deriveSubject(description: string): string {
  const normalized = description.replace(/\s+/g, " ").trim();

  return normalized.length <= 120
    ? normalized
    : `${normalized.slice(0, 117)}...`;
}
