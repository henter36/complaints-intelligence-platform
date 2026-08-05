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

const prisma = new PrismaClient();

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

async function main(): Promise<number> {
  const mode = readArg("mode") ?? "dry-run";
  const actor = readArg("actor") ?? "system";
  const batchSizeRaw = readArg("batch-size");
  const batchSize = batchSizeRaw ? Number(batchSizeRaw) : undefined;

  try {
    if (mode === "dry-run") {
      const from = readArg("from");
      const to = readArg("to");
      const manifest = readArg("manifest");
      if (!from || !to || !manifest) {
        throw new HistoricalBackfillError(
          "BACKFILL_PERIOD_REQUIRED",
          "dry-run يتطلب --from و --to و --manifest"
        );
      }
      const result = await previewHistoricalClassificationBackfill(prisma, {
        from,
        toInclusive: to,
        manifestPath: manifest,
        overwrite: readFlag("overwrite"),
        actor,
      });
      safePrint(result);
      return 0;
    }

    if (mode === "apply") {
      const manifest = readArg("manifest");
      if (!manifest) {
        throw new HistoricalBackfillError(
          "BACKFILL_MANIFEST_REQUIRED",
          "apply يتطلب --manifest"
        );
      }
      const result = await applyHistoricalClassificationBackfill(prisma, {
        manifestPath: manifest,
        confirm: readArg("confirm") ?? undefined,
        batchSize,
        actor,
        resumeRunId: readArg("run-id") ?? undefined,
      });
      safePrint(result);
      return result.status === "APPLIED" || result.status === "PARTIALLY_APPLIED" ? 0 : 1;
    }

    if (mode === "verify") {
      const runId = readArg("run-id");
      if (!runId) {
        throw new HistoricalBackfillError("BACKFILL_RUN_NOT_FOUND", "verify يتطلب --run-id");
      }
      const result = await verifyHistoricalClassificationBackfill(prisma, { runId });
      safePrint(result);
      return result.ok ? 0 : 1;
    }

    if (mode === "rollback") {
      const runId = readArg("run-id");
      if (!runId) {
        throw new HistoricalBackfillError("BACKFILL_RUN_NOT_FOUND", "rollback يتطلب --run-id");
      }
      const result = await rollbackHistoricalClassificationBackfill(prisma, {
        runId,
        confirm: readArg("confirm") ?? undefined,
        batchSize,
        actor,
      });
      safePrint(result);
      return result.status === "ROLLED_BACK" || result.status === "PARTIALLY_ROLLED_BACK" ? 0 : 1;
    }

    throw new HistoricalBackfillError(
      "BACKFILL_MANIFEST_INVALID",
      `وضع غير مدعوم: ${mode}`
    );
  } catch (error) {
    if (error instanceof HistoricalBackfillError) {
      safePrint({ error: { code: error.code, message: error.message, details: error.details } });
      return 1;
    }
    safePrint({
      error: {
        code: "UNEXPECTED_ERROR",
        message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      },
    });
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().then((code) => {
  process.exitCode = code;
});
