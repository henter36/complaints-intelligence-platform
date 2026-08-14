#!/usr/bin/env tsx
// Thin CLI wrapper around the reusable backup verification service.

import { sanitizeBackupError, verifyBackup } from "./lib/backup-service";

const backupArgument = process.argv[2];
if (!backupArgument) {
  console.error("Usage: tsx scripts/backup-verify.ts <backup-path>");
  process.exitCode = 1;
} else {
  try {
    const result = verifyBackup(backupArgument);
    if (result.errors > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`Security: ${sanitizeBackupError(error)}`);
    process.exitCode = 1;
  }
}
