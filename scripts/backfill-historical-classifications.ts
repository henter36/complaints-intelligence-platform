#!/usr/bin/env tsx
/**
 * CLI for governed historical classification backfill.
 * Business logic lives in historical-classification-backfill.ts.
 *
 * Modes: dry-run (default) | apply | verify | rollback
 * Never logs sourceDetail, description, subject, or PII.
 */

import { PrismaClient } from "@prisma/client";
import {
  HistoricalBackfillError,
  applyHistoricalClassificationBackfill,
  previewHistoricalClassificationBackfill,
  rollbackHistoricalClassificationBackfill,
  verifyHistoricalClassificationBackfill,
} from "../src/server/classifications/historical-classification-backfill";
import {
  formatBackfillCliError,
  handleUnhandledCliFailure,
} from "../src/server/classifications/backfill-cli-runtime";

const prisma = new PrismaClient();

type CliOptions = {
  mode: string;
  actor: string;
  batchSize?: number;
  from: string | null;
  to: string | null;
  manifest: string | null;
  confirm: string | null;
  runId: string | null;
  overwrite: boolean;
};

function readArg(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function readFlag(name: string): boolean {
  return process.argv.includes(`--${name}`) || readArg(name) === "true";
}

function safePrint(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function parseCliOptions(): CliOptions {
  const batchSizeRaw = readArg("batch-size");
  return {
    mode: readArg("mode") ?? "dry-run",
    actor: readArg("actor") ?? "system",
    batchSize: batchSizeRaw ? Number(batchSizeRaw) : undefined,
    from: readArg("from"),
    to: readArg("to"),
    manifest: readArg("manifest"),
    confirm: readArg("confirm"),
    runId: readArg("run-id"),
    overwrite: readFlag("overwrite"),
  };
}

async function runDryRunMode(options: CliOptions): Promise<number> {
  if (!options.from || !options.to || !options.manifest) {
    throw new HistoricalBackfillError(
      "BACKFILL_PERIOD_REQUIRED",
      "dry-run يتطلب --from و --to و --manifest"
    );
  }
  const result = await previewHistoricalClassificationBackfill(prisma, {
    from: options.from,
    toInclusive: options.to,
    manifestPath: options.manifest,
    overwrite: options.overwrite,
    actor: options.actor,
  });
  safePrint(result);
  return 0;
}

async function runApplyMode(options: CliOptions): Promise<number> {
  if (!options.manifest) {
    throw new HistoricalBackfillError(
      "BACKFILL_MANIFEST_REQUIRED",
      "apply يتطلب --manifest"
    );
  }
  const result = await applyHistoricalClassificationBackfill(prisma, {
    manifestPath: options.manifest,
    confirm: options.confirm ?? undefined,
    batchSize: options.batchSize,
    actor: options.actor,
    resumeRunId: options.runId ?? undefined,
  });
  safePrint(result);
  return result.status === "APPLIED" || result.status === "PARTIALLY_APPLIED" ? 0 : 1;
}

async function runVerifyMode(options: CliOptions): Promise<number> {
  if (!options.runId) {
    throw new HistoricalBackfillError("BACKFILL_RUN_NOT_FOUND", "verify يتطلب --run-id");
  }
  const result = await verifyHistoricalClassificationBackfill(prisma, { runId: options.runId });
  safePrint(result);
  return result.ok ? 0 : 1;
}

async function runRollbackMode(options: CliOptions): Promise<number> {
  if (!options.runId) {
    throw new HistoricalBackfillError("BACKFILL_RUN_NOT_FOUND", "rollback يتطلب --run-id");
  }
  const result = await rollbackHistoricalClassificationBackfill(prisma, {
    runId: options.runId,
    confirm: options.confirm ?? undefined,
    batchSize: options.batchSize,
    actor: options.actor,
  });
  safePrint(result);
  return result.status === "ROLLED_BACK" || result.status === "PARTIALLY_ROLLED_BACK" ? 0 : 1;
}

async function dispatchMode(options: CliOptions): Promise<number> {
  switch (options.mode) {
    case "dry-run":
      return runDryRunMode(options);
    case "apply":
      return runApplyMode(options);
    case "verify":
      return runVerifyMode(options);
    case "rollback":
      return runRollbackMode(options);
    default:
      throw new HistoricalBackfillError(
        "BACKFILL_MANIFEST_INVALID",
        `وضع غير مدعوم: ${options.mode}`
      );
  }
}

async function main(): Promise<number> {
  const options = parseCliOptions();
  try {
    return await dispatchMode(options);
  } catch (error) {
    safePrint({ error: formatBackfillCliError(error) });
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    handleUnhandledCliFailure(error, {
      print: safePrint,
      setExitCode: (code) => {
        process.exitCode = code;
      },
    });
  });
