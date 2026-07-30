const secret = process.env.INTERNAL_SCHEDULER_SECRET;
if (!secret) {
  console.error("INTERNAL_SCHEDULER_SECRET is not set in the environment.");
  process.exit(1);
}

const baseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";

async function main() {
  const response = await fetch(`${baseUrl}/api/internal/reports/run-due`, {
    method: "POST",
    headers: { "x-scheduler-secret": secret! },
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    console.error(`reports:run-due failed with status ${response.status}:`, body);
    process.exit(1);
  }

  console.log("reports:run-due result:", JSON.stringify(body));
}

main().catch((error) => {
  console.error("reports:run-due request failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
