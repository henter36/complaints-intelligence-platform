# Backup & Restore Guide

## Overview

The backup system captures:
- SQLite database (consistent snapshot)
- Import artifacts (uploaded XLSX files)
- Report artifacts (generated PDFs/XLSXs not yet expired)
- Manifest with SHA-256 checksums

Does NOT include:
- `.env` or secrets
- `node_modules`
- `.next` build directory
- Previous backups

## Create a Backup

```bash
npm run backup:create
```

Output is written to `./backups/backup-<timestamp>/`.

## Verify a Backup

```bash
npm run backup:verify -- ./backups/backup-2026-07-31T10-00-00
```

Checks:
- Manifest exists and is valid JSON
- Every file in the manifest exists on disk
- SHA-256 checksums match

## Restore from Backup

**The system should be stopped during restore.**

```bash
# 1. Verify first
npm run backup:verify -- ./backups/backup-2026-07-31T10-00-00

# 2. Restore (requires --confirm)
npm run backup:restore -- ./backups/backup-2026-07-31T10-00-00 --confirm
```

The restore process:
1. Verifies backup integrity
2. Creates a pre-restore backup automatically
3. Restores database
4. Restores import storage
5. Restores report storage

Does NOT restore `.env` or secrets.

## Backup Retention

Old backups should be cleaned up periodically:

```bash
# List backups
ls -la ./backups/

# Remove backups older than 30 days
find ./backups -maxdepth 1 -name "backup-*" -mtime +30 -exec rm -rf {} \;
```

## Test Restore (Safe)

To test restore to a temporary location:

```bash
# Verify backup
npm run backup:verify -- ./backups/backup-<timestamp>

# Manual test: copy backup db to a temp path and open with sqlite3
sqlite3 ./backups/backup-<timestamp>/db/database.sqlite ".tables"
```

## Backup Before Upgrades

Always run `npm run backup:create` before:
- Upgrading the application version
- Running database migrations
- Changing storage configuration
- Any destructive operation
