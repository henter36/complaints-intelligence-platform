import { initializeAdminCredential } from "../src/server/auth/admin-service";

const replace = process.argv.includes("--replace");

async function main(): Promise<void> {
  try {
    const admin = await initializeAdminCredential({ replace });
    console.log(`Admin credential initialized for ${admin.username}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Admin initialization failed: ${message}`);
    process.exit(1);
  }
}

void main();
