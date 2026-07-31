const secret = process.env.INTERNAL_SCHEDULER_SECRET;
if (!secret) {
  console.error("INTERNAL_SCHEDULER_SECRET is not set in the environment.");
  process.exit(1);
}

const baseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";

/** Strips CR/LF from externally-sourced text before logging, so a crafted
 * response body cannot forge additional log lines (log injection). */
function sanitizeForLog(value: unknown): string {
  return JSON.stringify(value).replace(/[\r\n]/g, " ");
}

async function main() {
  const response = await fetch(`${baseUrl}/api/internal/reports/run-due`, {
    method: "POST",
    headers: { "x-scheduler-secret": secret! },
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    console.error(`reports:run-due failed with status ${response.status}: ${sanitizeForLog(body)}`);
    process.exit(1);
  }

  console.log(`reports:run-due result: ${sanitizeForLog(body)}`);
}

main().catch((error) => {
  console.error("reports:run-due request failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
