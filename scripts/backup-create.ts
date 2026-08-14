#!/usr/bin/env tsx
// Thin CLI wrapper around the reusable backup service.

import { createBackup, sanitizeBackupError } from "./lib/backup-service";

try {
  createBackup();
} catch (error) {
  console.error("Backup failed:", sanitizeBackupError(error));
  process.exitCode = 1;
}
