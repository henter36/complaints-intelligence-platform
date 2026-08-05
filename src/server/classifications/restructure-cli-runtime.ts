import {
  RESTRUCTURE_ERROR_CODES,
  TaxonomyRestructureError,
} from "./classification-taxonomy-proposal";
import { RESTRUCTURE_RUN_STATUSES } from "./classification-taxonomy-manifest";

export type RestructureCliOptions = {
  mode: string;
  actor: string;
  proposal: string | null;
  mapping: string | null;
  manifest: string | null;
  confirm: string | null;
  runId: string | null;
  overwrite: boolean;
};

export function formatRestructureCliError(
  error: unknown
): { code: string; message: string; details?: unknown } {
  if (error instanceof TaxonomyRestructureError) {
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
  options.print({ error: formatRestructureCliError(error) });
  options.setExitCode(1);
}

export function rollbackExitCode(status: string): number {
  if (status === RESTRUCTURE_RUN_STATUSES.ROLLED_BACK) return 0;
  if (status === RESTRUCTURE_RUN_STATUSES.PARTIALLY_ROLLED_BACK) return 2;
  return 1;
}

export type RestructureModeHandlers = {
  dryRun: (options: RestructureCliOptions) => Promise<number>;
  apply: (options: RestructureCliOptions) => Promise<number>;
  verify: (options: RestructureCliOptions) => Promise<number>;
  rollback: (options: RestructureCliOptions) => Promise<number>;
};

export async function dispatchRestructureMode(
  options: RestructureCliOptions,
  handlers: RestructureModeHandlers
): Promise<number> {
  switch (options.mode) {
    case "dry-run":
      return handlers.dryRun(options);
    case "apply":
      return handlers.apply(options);
    case "verify":
      return handlers.verify(options);
    case "rollback":
      return handlers.rollback(options);
    default:
      throw new TaxonomyRestructureError(
        RESTRUCTURE_ERROR_CODES.MODE_UNSUPPORTED,
        `وضع غير مدعوم: ${options.mode}`
      );
  }
}
