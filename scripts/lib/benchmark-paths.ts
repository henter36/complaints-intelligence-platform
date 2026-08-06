const WINDOWS_DEV_DB_SUFFIX = String.raw`\prisma\dev.db`;

export function isDevDbUrl(url: string): boolean {
  const normalized = url.replace(/^file:/, "");
  return (
    normalized.endsWith("/prisma/dev.db") ||
    normalized.endsWith(WINDOWS_DEV_DB_SUFFIX) ||
    normalized === "prisma/dev.db" ||
    normalized.endsWith("prisma/dev.db")
  );
}
