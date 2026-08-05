import { HistoricalBackfillError } from "./historical-classification-backfill";

export function formatBackfillCliError(
  error: unknown
): { code: string; message: string; details?: unknown } {
  if (error instanceof HistoricalBackfillError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return {
    code: "UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
  };
}

/**
 * Handles rejections that escape main() (e.g. prisma.$disconnect() failing in finally).
 * Never prints stack traces, DATABASE_URL, or PII.
 */
export function handleUnhandledCliFailure(
  error: unknown,
  options: {
    print: (value: unknown) => void;
    setExitCode: (code: number) => void;
  }
): void {
  options.print({ error: formatBackfillCliError(error) });
  options.setExitCode(1);
}
