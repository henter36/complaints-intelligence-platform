#!/usr/bin/env tsx
/**
 * One-off SQLite repair for ClassificationTaxonomyRestructure schema drift.
 * Default mode is inspect. Apply requires --confirm and --backup-path.
 * Not invoked by npm install or app startup.
 */
import {
  REPAIR_ERROR_CODES,
  TaxonomyMigrationRepairError,
  applyTaxonomyMigrationRepair,
  inspectTaxonomyMigrationRepair,
} from "../src/server/classifications/taxonomy-migration-repair";

type CliOptions = {
  mode: string;
  confirm: string | null;
  backupPath: string | null;
  databaseUrl: string;
};

function parseCliOptions(argv: string[] = process.argv): CliOptions {
  const read = (name: string): string | null => {
    const prefix = `--${name}=`;
    const value = argv.find((arg) => arg.startsWith(prefix));
    return value ? value.slice(prefix.length) : null;
  };
  return {
    mode: read("mode") ?? "inspect",
    confirm: read("confirm"),
    backupPath: read("backup-path"),
    databaseUrl: process.env.DATABASE_URL ?? "file:./dev.db",
  };
}

function safePrint(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function main(argv: string[] = process.argv): number {
  const options = parseCliOptions(argv);
  try {
    if (options.mode === "inspect") {
      const report = inspectTaxonomyMigrationRepair({ databaseUrl: options.databaseUrl });
      safePrint(report);
      return 0;
    }
    if (options.mode === "apply") {
      const report = applyTaxonomyMigrationRepair({
        databaseUrl: options.databaseUrl,
        confirm: options.confirm ?? undefined,
        backupPath: options.backupPath ?? undefined,
      });
      safePrint(report);
      return 0;
    }
    throw new TaxonomyMigrationRepairError(
      REPAIR_ERROR_CODES.REPAIR_UNKNOWN_SCHEMA,
      `وضع غير مدعوم: ${options.mode}`
    );
  } catch (error) {
    if (error instanceof TaxonomyMigrationRepairError) {
      safePrint({
        ok: false,
        code: error.code,
        message: error.message,
        details: error.details ?? null,
      });
      return 1;
    }
    throw error;
  }
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

export { main, parseCliOptions };
