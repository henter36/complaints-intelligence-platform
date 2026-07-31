import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const UNIX_GIT_CANDIDATES = [
  "/usr/bin/git",
  "/usr/local/bin/git",
  "/opt/homebrew/bin/git",
] as const;

const WINDOWS_GIT_CANDIDATES = [
  String.raw`C:\Program Files\Git\cmd\git.exe`,
  String.raw`C:\Program Files\Git\bin\git.exe`,
] as const;

export function resolveGitExecutable(
  candidates?: readonly string[]
): string {
  const list =
    candidates ??
    (process.platform === "win32"
      ? WINDOWS_GIT_CANDIDATES
      : UNIX_GIT_CANDIDATES);

  const executable = list.find(
    (candidate) =>
      path.isAbsolute(candidate) &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile()
  );

  if (!executable) {
    throw new Error(
      "Git executable was not found in trusted system locations"
    );
  }

  return executable;
}

export function runGitCommand(args: readonly string[]): string {
  return execFileSync(
    resolveGitExecutable(),
    [...args],
    {
      encoding: "utf8",
      shell: false,
      env: {
        HOME: process.env.HOME,
        LANG: process.env.LANG || "C.UTF-8",
      } as unknown as NodeJS.ProcessEnv,
    }
  ).trim();
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

export function resolveMigrationsDir(root: string): string {
  return path.join(root, "prisma", "migrations");
}
