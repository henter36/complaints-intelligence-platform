#!/usr/bin/env tsx
/**
 * CLI for governed classification taxonomy restructure.
 * Does NOT run historical complaint backfill.
 */

import { PrismaClient } from "@prisma/client";
import {
  TaxonomyRestructureError,
  applyTaxonomyRestructure,
  previewTaxonomyRestructure,
  rollbackTaxonomyRestructure,
  verifyTaxonomyRestructure,
} from "../src/server/classifications/classification-taxonomy-restructure";

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

  try {
    if (mode === "dry-run") {
      const proposal = readArg("proposal");
      const mapping = readArg("mapping");
      const manifest = readArg("manifest");
      if (!proposal || !mapping || !manifest) {
        throw new TaxonomyRestructureError(
          "PROPOSAL_REQUIRED",
          "dry-run يتطلب --proposal و --mapping و --manifest"
        );
      }
      const result = await previewTaxonomyRestructure(prisma, {
        proposalPath: proposal,
        mappingPath: mapping,
        manifestPath: manifest,
        overwrite: readFlag("overwrite"),
      });
      safePrint(result);
      return 0;
    }

    if (mode === "apply") {
      const manifest = readArg("manifest");
      if (!manifest) {
        throw new TaxonomyRestructureError("MANIFEST_REQUIRED", "apply يتطلب --manifest");
      }
      const result = await applyTaxonomyRestructure(prisma, {
        manifestPath: manifest,
        confirm: readArg("confirm") ?? undefined,
        actor,
      });
      safePrint(result);
      return result.status === "APPLIED" ? 0 : 1;
    }

    if (mode === "verify") {
      const runId = readArg("run-id");
      if (!runId) {
        throw new TaxonomyRestructureError("RUN_NOT_FOUND", "verify يتطلب --run-id");
      }
      const result = await verifyTaxonomyRestructure(prisma, {
        runId,
        proposalPath: readArg("proposal") ?? undefined,
        mappingPath: readArg("mapping") ?? undefined,
      });
      safePrint(result);
      return result.ok ? 0 : 1;
    }

    if (mode === "rollback") {
      const runId = readArg("run-id");
      if (!runId) {
        throw new TaxonomyRestructureError("RUN_NOT_FOUND", "rollback يتطلب --run-id");
      }
      const result = await rollbackTaxonomyRestructure(prisma, {
        runId,
        confirm: readArg("confirm") ?? undefined,
        actor,
      });
      safePrint(result);
      return result.status === "ROLLED_BACK" || result.status === "PARTIALLY_ROLLED_BACK" ? 0 : 1;
    }

    throw new TaxonomyRestructureError("MANIFEST_INVALID", `وضع غير مدعوم: ${mode}`);
  } catch (error) {
    if (error instanceof TaxonomyRestructureError) {
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
