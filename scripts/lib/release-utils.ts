import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

export function runGitCommand(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

export function resolveCommitSha(): string {
  const sha = runGitCommand(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error("Unable to resolve a valid Git commit SHA");
  }
  return sha;
}

export function listMigrationDirectories(migrationsDir: string): string[] {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs.readdirSync(migrationsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
}

// Keeps a reference to path so shared release consumers can normalize dirs.
export function resolveMigrationsDir(root: string): string {
  return path.join(root, "prisma", "migrations");
}
