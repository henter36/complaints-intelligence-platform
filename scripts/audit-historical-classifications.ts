#!/usr/bin/env tsx
/**
 * Governed historical classification correction CLI.
 * Modes: dry-run (default) | apply | verify | rollback.
 * Raw complaint text and PII are never written to stdout.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  AUDIT_ERROR_CODES,
  CLASSIFICATION_AUDIT_ACTOR,
  HistoricalClassificationAuditError,
  applyHistoricalClassificationAudit,
  previewHistoricalClassificationAudit,
  rollbackHistoricalClassificationAudit,
  verifyHistoricalClassificationAudit,
} from "../src/server/classifications/historical-classification-audit-service";
import { createVerifiedBackup, type BackupLogger } from "./lib/backup-service";

const prisma = new PrismaClient();
const PROJECT_ROOT = resolve(__dirname, "..");

type CliOptions = {
  mode: string;
  manifest: string | null;
  privateReview: string | null;
  confirm: string | null;
  runId: string | null;
  actor: string;
  batchSize?: number;
  overwrite: boolean;
};

function readArg(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function readFlag(name: string): boolean {
  return process.argv.includes(`--${name}`) || readArg(name) === "true";
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function defaultManifestPath(): string {
  return resolve(
    PROJECT_ROOT,
    ".local",
    "classification-audit",
    `historical-classification-audit-${timestamp()}.json`
  );
}

function parseOptions(): CliOptions {
  const batchSize = readArg("batch-size");
  return {
    mode: readArg("mode") ?? "dry-run",
    manifest: readArg("manifest"),
    privateReview: readArg("private-review"),
    confirm: readArg("confirm"),
    runId: readArg("run-id"),
    actor: readArg("actor") ?? CLASSIFICATION_AUDIT_ACTOR,
    batchSize: batchSize ? Number(batchSize) : undefined,
    overwrite: readFlag("overwrite"),
  };
}

function safePrint(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function safeError(error: unknown): { error: { code: string; message: string; details?: unknown } } {
  if (error instanceof HistoricalClassificationAuditError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }
  return {
    error: {
      code: "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message.replaceAll(/\s+/g, " ").slice(0, 200) : "unknown",
    },
  };
}

const silentBackupLogger: BackupLogger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

async function createAndVerifyBackup() {
  return createVerifiedBackup({
    projectRoot: PROJECT_ROOT,
    env: process.env,
    logger: silentBackupLogger,
  });
}

async function runDryRunMode(options: CliOptions): Promise<number> {
  const manifest = options.manifest ? resolve(options.manifest) : defaultManifestPath();
  const privateReview = options.privateReview
    ? resolve(options.privateReview)
    : resolve(PROJECT_ROOT, ".local", "classification-audit", "private-review.json");
  mkdirSync(resolve(PROJECT_ROOT, ".local", "classification-audit"), { recursive: true });
  const result = await previewHistoricalClassificationAudit(prisma, {
    manifestPath: manifest,
    privateReviewPath: privateReview,
    overwrite: options.overwrite,
  });
  safePrint(result);
  return 0;
}

async function runApplyMode(options: CliOptions): Promise<number> {
  if (!options.manifest) {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.MANIFEST_REQUIRED,
      "apply يتطلب --manifest"
    );
  }
  const result = await applyHistoricalClassificationAudit(prisma, {
    manifestPath: options.manifest,
    confirm: options.confirm ?? undefined,
    actor: options.actor,
    batchSize: options.batchSize,
    createAndVerifyBackup,
  });
  safePrint(result);
  return result.status === "APPLIED" || result.status === "PARTIALLY_APPLIED" ? 0 : 1;
}

async function runVerifyMode(options: CliOptions): Promise<number> {
  if (!options.runId) {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.RUN_NOT_FOUND,
      "verify يتطلب --run-id"
    );
  }
  const result = await verifyHistoricalClassificationAudit(prisma, { runId: options.runId });
  safePrint(result);
  return result.ok ? 0 : 1;
}

async function runRollbackMode(options: CliOptions): Promise<number> {
  if (!options.runId) {
    throw new HistoricalClassificationAuditError(
      AUDIT_ERROR_CODES.RUN_NOT_FOUND,
      "rollback يتطلب --run-id"
    );
  }
  const result = await rollbackHistoricalClassificationAudit(prisma, {
    runId: options.runId,
    confirm: options.confirm ?? undefined,
    actor: options.actor,
    batchSize: options.batchSize,
  });
  safePrint(result);
  return result.status === "ROLLED_BACK" || result.status === "PARTIALLY_ROLLED_BACK" ? 0 : 1;
}

async function run(options: CliOptions): Promise<number> {
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
      throw new HistoricalClassificationAuditError(
        AUDIT_ERROR_CODES.MANIFEST_INVALID,
        `وضع غير مدعوم: ${options.mode}`
      );
  }
}

async function main(): Promise<void> {
  try {
    process.exitCode = await run(parseOptions());
  } catch (error) {
    safePrint(safeError(error));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  safePrint(safeError(error));
  process.exitCode = 1;
});
