import { db } from "../src/lib/db";
import { runReportsCleanup } from "../src/server/reports/report-cleanup-service";

const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const result = await runReportsCleanup({ dryRun });

  if (result.candidates.length === 0) {
    console.log("reports:cleanup — no expired artifacts to remove.");
    return;
  }

  if (result.dryRun) {
    console.log(`reports:cleanup (dry-run) — ${result.candidates.length} artifact(s) would be removed:`);
    for (const artifact of result.candidates) {
      console.log(`  - ${artifact.id} (${artifact.format}, expired ${artifact.expiresAt})`);
    }
    return;
  }

  console.log(`reports:cleanup — removed ${result.removedCount} expired artifact(s).`);
}

main()
  .catch((error) => {
    console.error("reports:cleanup failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
