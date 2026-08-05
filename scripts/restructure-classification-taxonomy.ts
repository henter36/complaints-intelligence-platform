#!/usr/bin/env tsx
/**
 * CLI for governed classification taxonomy restructure.
 * Does NOT run historical complaint backfill.
 */

import { PrismaClient } from "@prisma/client";
import {
  RESTRUCTURE_ERROR_CODES,
  TaxonomyRestructureError,
  applyTaxonomyRestructure,
  previewTaxonomyRestructure,
  rollbackTaxonomyRestructure,
  verifyTaxonomyRestructure,
} from "../src/server/classifications/classification-taxonomy-restructure";
import {
  dispatchRestructureMode,
  formatRestructureCliError,
  handleUnhandledCliFailure,
  rollbackExitCode,
  type RestructureCliOptions,
} from "../src/server/classifications/restructure-cli-runtime";

const prisma = new PrismaClient();

function safePrint(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function parseCliOptions(argv: string[] = process.argv): RestructureCliOptions {
  const read = (name: string): string | null => {
    const prefix = `--${name}=`;
    const value = argv.find((arg) => arg.startsWith(prefix));
    return value ? value.slice(prefix.length) : null;
  };
  const flag = (name: string): boolean =>
    argv.includes(`--${name}`) || read(name) === "true";
  return {
    mode: read("mode") ?? "dry-run",
    actor: read("actor") ?? "system",
    proposal: read("proposal"),
    mapping: read("mapping"),
    manifest: read("manifest"),
    confirm: read("confirm"),
    runId: read("run-id"),
    overwrite: flag("overwrite"),
  };
}

async function runDryRunMode(options: RestructureCliOptions): Promise<number> {
  if (!options.proposal) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.PROPOSAL_REQUIRED,
      "dry-run يتطلب --proposal"
    );
  }
  if (!options.mapping) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.MAPPING_REQUIRED,
      "dry-run يتطلب --mapping"
    );
  }
  if (!options.manifest) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.MANIFEST_REQUIRED,
      "dry-run يتطلب --manifest"
    );
  }
  const result = await previewTaxonomyRestructure(prisma, {
    proposalPath: options.proposal,
    mappingPath: options.mapping,
    manifestPath: options.manifest,
    overwrite: options.overwrite,
  });
  safePrint(result);
  return 0;
}

async function runApplyMode(options: RestructureCliOptions): Promise<number> {
  if (!options.manifest) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.MANIFEST_REQUIRED,
      "apply يتطلب --manifest"
    );
  }
  const result = await applyTaxonomyRestructure(prisma, {
    manifestPath: options.manifest,
    confirm: options.confirm ?? undefined,
    actor: options.actor,
  });
  safePrint(result);
  return result.status === "APPLIED" ? 0 : 1;
}

async function runVerifyMode(options: RestructureCliOptions): Promise<number> {
  if (!options.runId) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.RUN_ID_REQUIRED,
      "verify يتطلب --run-id"
    );
  }
  if (!options.proposal) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.PROPOSAL_REQUIRED,
      "verify يتطلب --proposal"
    );
  }
  if (!options.mapping) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.MAPPING_REQUIRED,
      "verify يتطلب --mapping"
    );
  }
  const result = await verifyTaxonomyRestructure(prisma, {
    runId: options.runId,
    proposalPath: options.proposal,
    mappingPath: options.mapping,
  });
  safePrint(result);
  return result.ok ? 0 : 1;
}

async function runRollbackMode(options: RestructureCliOptions): Promise<number> {
  if (!options.runId) {
    throw new TaxonomyRestructureError(
      RESTRUCTURE_ERROR_CODES.RUN_ID_REQUIRED,
      "rollback يتطلب --run-id"
    );
  }
  const result = await rollbackTaxonomyRestructure(prisma, {
    runId: options.runId,
    confirm: options.confirm ?? undefined,
    actor: options.actor,
  });
  safePrint(result);
  return rollbackExitCode(result.status);
}

async function dispatchMode(options: RestructureCliOptions): Promise<number> {
  return dispatchRestructureMode(options, {
    dryRun: runDryRunMode,
    apply: runApplyMode,
    verify: runVerifyMode,
    rollback: runRollbackMode,
  });
}

async function main(): Promise<number> {
  const options = parseCliOptions();
  try {
    return await dispatchMode(options);
  } catch (error) {
    safePrint({ error: formatRestructureCliError(error) });
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
