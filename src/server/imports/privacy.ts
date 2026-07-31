export function maskIdentifier(value: string): string {
  const normalized = value.trim();

  if (normalized.length <= 4) {
    return "****";
  }

  return `${"*".repeat(normalized.length - 4)}${normalized.slice(-4)}`;
}
