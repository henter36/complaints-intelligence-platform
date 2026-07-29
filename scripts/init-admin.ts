import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const replace = process.argv.includes("--replace");

function readOptionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function loadEnvFile(path: string): void {
  const absolutePath = resolve(path);
  const mode = statSync(absolutePath).mode;

  if ((mode & 0o077) !== 0) {
    console.warn("Warning: env file is readable by group/others. Restrict permissions before production use.");
  }

  const contents = readFileSync(absolutePath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

async function main(): Promise<void> {
  const envFile = readOptionValue("--env-file");
  if (envFile) {
    loadEnvFile(envFile);
  }

  try {
    const { initializeAdminCredential } = await import("../src/server/auth/admin-service");
    const admin = await initializeAdminCredential({ replace });
    console.log(`Admin credential initialized for ${admin.username}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Admin initialization failed: ${message}`);
    process.exit(1);
  }
}

void main();
