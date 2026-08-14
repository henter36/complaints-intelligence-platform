import { readFileSync, rmSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVerifiedBackup,
  type BackupLogger,
  type BackupServiceOptions,
} from "./lib/backup-service";

const temporaryDirectories: string[] = [];
const silentLogger: BackupLogger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function testOptions(): BackupServiceOptions {
  const projectRoot = mkdtempSync(join(tmpdir(), "classification-audit-backup-"));
  temporaryDirectories.push(projectRoot);
  mkdirSync(join(projectRoot, "prisma"), { recursive: true });
  writeFileSync(join(projectRoot, "prisma", "dev.db"), "deterministic-test-database");
  return {
    projectRoot,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "file:./dev.db",
      BACKUP_PATH: "./backups",
    },
    logger: silentLogger,
    now: new Date("2026-08-14T12:34:56.000Z"),
    spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })) as never,
  };
}

describe("historical classification audit backup guard", () => {
  it("creates and verifies the backup directly through TypeScript services", () => {
    const options = testOptions();
    const receipt = createVerifiedBackup(options);

    expect(receipt).toEqual({
      backupName: "backup-2026-08-14T12-34-56",
      verified: true,
    });
    const manifestPath = resolve(
      options.projectRoot!,
      "backups",
      receipt.backupName,
      "manifest.json"
    );
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
      backupName: receipt.backupName,
      version: "1",
    });
  });

  it("stops before verification when backup creation fails", () => {
    const verify = vi.fn();
    expect(() =>
      createVerifiedBackup(
        {},
        {
          create: () => {
            throw new Error("create failed");
          },
          verify,
        }
      )
    ).toThrow("create failed");
    expect(verify).not.toHaveBeenCalled();
  });

  it("rejects the guard when backup verification fails", () => {
    expect(() =>
      createVerifiedBackup(
        {},
        {
          create: () => ({ backupName: "backup-test", fileCount: 1 }),
          verify: () => {
            throw new Error("verify failed");
          },
        }
      )
    ).toThrow("verify failed");
  });

  it("does not use npm, a shell, or PATH to select the backup command", () => {
    const source = readFileSync(
      resolve(process.cwd(), "scripts", "audit-historical-classifications.ts"),
      "utf8"
    );
    const backupSource = readFileSync(
      resolve(process.cwd(), "scripts", "lib", "backup-service.ts"),
      "utf8"
    );
    expect(source).not.toContain("node:child_process");
    expect(source).not.toContain("execFile");
    expect(source).not.toContain("shell:");
    expect(source).not.toContain("process.env.PATH");
    expect(source).not.toContain("process.env.npm_execpath");
    expect(source).not.toMatch(/["']npm["']/);
    expect(backupSource).not.toMatch(/spawnSync\(["'](?:npm|sqlite3|sqlite3\.exe)["']/);
  });
});
