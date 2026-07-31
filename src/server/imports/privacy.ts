export function maskIdentifier(value: string): string {
  const normalized = value.trim();

  if (normalized.length <= 4) {
    return "****";
  }

  return `****${normalized.slice(-4)}`;
}
