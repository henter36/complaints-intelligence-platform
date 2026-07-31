# Operations Runbook

## Phase 8 Release Verification

Before any production deployment run:

```bash
npm run release:manifest
npm run release:check
```

Both must pass without failures. `release:check` requires Node 24.x; it fails (not warns) if the version is different.

## Prerequisites

- **Node.js 24.x** — required at runtime and for all operational scripts.
  (`node --version` must report `v24.x.y`)
- **SQLite3 CLI** (optional but recommended) — used by `backup:create` for a
  WAL-safe atomic snapshot via `.backup`. When absent, the script falls back to
  a raw file copy (copies main + WAL + SHM sidecars).
  Install: `apt install sqlite3` / `brew install sqlite`.

## Daily Operations

### Health Checks

```bash
curl http://localhost:3000/api/health/live    # → {"status":"live"}
curl http://localhost:3000/api/health/ready   # → {"status":"ready","checks":{...}}
```

### Integrity Check

```bash
npm run integrity:check
# Or with JSON output:
npm run integrity:check -- --json
```

### View Recent Logs

```bash
# PM2:
pm2 logs complaints-platform --lines 100

# Systemd:
journalctl -u complaints-platform -n 100 --no-pager
```

## Weekly Operations

### Backup

```bash
npm run backup:create
```

Backs up: `database.sqlite` (+ WAL/SHM sidecars if present), import storage, report storage.
Does **not** back up `.env`, secrets, or `node_modules`.

To verify a backup:

```bash
npm run backup:verify -- <backup-name>
```

### Report Cleanup

```bash
npm run reports:cleanup
```

### AI Cleanup (if AI enabled)

```bash
npm run ai:cleanup
# Dry run (preview only):
npm run ai:cleanup -- --dry-run
```

Expired AI results are soft-deleted and user-controlled fields (filters, input summary, error details,
feedback comments) are redacted. Run metadata and audit logs are retained permanently.

## Troubleshooting

### Application Won't Start

1. Check `.env` exists and has no placeholder values: `npm run release:check`
2. Verify Node 24.x: `node --version`
3. Check database: `DATABASE_URL="..." npx prisma migrate status`
4. Check storage directories exist and are writable
5. If `AI_ENABLED=true`, verify `OPENAI_API_KEY` is set and not a placeholder

### Database Errors

```bash
# Check migration status
DATABASE_URL="file:./data/database.sqlite" npx prisma migrate status

# Run pending migrations
DATABASE_URL="file:./data/database.sqlite" npx prisma migrate deploy

# Integrity check
npm run integrity:check
```

### Storage Full

1. Run `npm run reports:cleanup` to remove expired artifacts
2. Run `npm run ai:cleanup` to remove expired AI results
3. Clean old backups: `find ./backups -name "backup-*" -mtime +30 -exec rm -rf {} \;`
4. Check `IMPORT_RETENTION_DAYS` and `REPORT_RETENTION_DAYS` settings

### Restore from Backup

```bash
# Stop the application first, then:
npm run backup:restore -- <backup-name> --confirm
# Restart the application after restore completes
```

The restore process:
1. Verifies all checksums before touching any files
2. Creates a pre-restore backup automatically
3. Restores database + WAL/SHM sidecars if present in backup
4. Restores import and report storage

**Note:** `.env` and secrets are never restored. Verify configuration after restore.

### Admin Password Reset

```bash
npm run auth:hash-password
# Update ADMIN_PASSWORD_HASH in .env, then restart
```

### Stuck Import Batch

If an import batch is stuck in CONFIRMING or ROLLING_BACK status:
1. Check application logs for errors
2. Run `npm run integrity:check` to assess damage
3. If necessary, restore from backup

### AI Analysis Failing

1. Check `AI_ENABLED=true` in `.env`
2. Verify `OPENAI_API_KEY` is valid (not a placeholder value)
3. Check `/api/ai/status` response
4. Check daily run limit: `AI_DAILY_RUN_LIMIT` (default 20)
5. Stale RUNNING/PENDING runs are automatically swept after 30 minutes

## Monitoring Checklist

- [ ] `/api/health/ready` returns 200 every 5 minutes
- [ ] Disk usage < 80% on data partition
- [ ] No `error` level logs in last 24h
- [ ] Report artifacts not accumulating (cleanup running)
- [ ] Backup created in last 7 days
- [ ] AI cleanup running weekly (if AI enabled)
