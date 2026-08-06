import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PRISMA_CLI_PATH = require.resolve("prisma/build/index.js");

function copyOptionalEnvironmentValue(target: NodeJS.ProcessEnv, key: string): void {
  const value = process.env[key];
  if (value) target[key] = value;
}

export function buildPrismaChildEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  env.DATABASE_URL = databaseUrl;

  for (const key of ["HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "TMPDIR"]) {
    copyOptionalEnvironmentValue(env, key);
  }

  return env;
}

export function runPrismaMigrateDeploy(databaseUrl: string): void {
  execFileSync(process.execPath, [PRISMA_CLI_PATH, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: buildPrismaChildEnvironment(databaseUrl),
    stdio: "pipe",
  });
}
