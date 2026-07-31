# Production Deployment Guide

## Prerequisites

- Node.js 20+ (tested on 24)
- 1GB+ disk space
- A reverse proxy (nginx/caddy) for HTTPS
- SQLite 3.x (built into Node.js via better-sqlite3)

## Initial Setup

```bash
# 1. Clone repository
git clone <repo-url> /opt/complaints-platform
cd /opt/complaints-platform

# 2. Install dependencies (no scripts for security)
npm ci --omit=dev --ignore-scripts

# 3. Configure environment
cp .env.production.example .env
# Edit .env with real values (see file comments)

# 4. Initialize database
DATABASE_URL="file:/opt/complaints-platform/data/database.sqlite" npm run db:generate
DATABASE_URL="file:/opt/complaints-platform/data/database.sqlite" npx prisma migrate deploy
DATABASE_URL="file:/opt/complaints-platform/data/database.sqlite" npm run db:seed

# 5. Initialize admin account
AUTH_ADMIN_USERNAME="admin" npx tsx scripts/init-admin.ts

# 6. Create storage directories
mkdir -p /opt/complaints-platform/storage/imports
mkdir -p /opt/complaints-platform/storage/reports
mkdir -p /opt/complaints-platform/backups
chmod 700 /opt/complaints-platform/storage
chmod 700 /opt/complaints-platform/backups

# 7. Build
npm run build

# 8. Start
npm run start
```

## HTTPS Configuration (nginx example)

```nginx
server {
    listen 443 ssl http2;
    server_name complaints.example.com;
    
    ssl_certificate /etc/ssl/certs/complaints.pem;
    ssl_certificate_key /etc/ssl/private/complaints.key;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Scheduled Reports

Add to cron:
```bash
# Run due reports every 5 minutes
*/5 * * * * cd /opt/complaints-platform && DATABASE_URL="file:./data/database.sqlite" INTERNAL_SCHEDULER_SECRET="..." node scripts/reports-run-due.ts

# Clean expired reports daily
0 2 * * * cd /opt/complaints-platform && DATABASE_URL="file:./data/database.sqlite" node scripts/reports-cleanup.ts

# AI cleanup (if AI enabled)
0 3 * * * cd /opt/complaints-platform && DATABASE_URL="file:./data/database.sqlite" node scripts/ai-cleanup.ts
```

## Upgrade Procedure

```bash
# 1. Create backup
npm run backup:create

# 2. Pull new code
git pull

# 3. Install dependencies
npm ci --omit=dev --ignore-scripts

# 4. Run migrations
DATABASE_URL="file:./data/database.sqlite" npx prisma migrate deploy

# 5. Build
npm run build

# 6. Restart application
pm2 restart complaints-platform
# or: systemctl restart complaints-platform
```

## Rollback Procedure

```bash
# Stop application
pm2 stop complaints-platform

# Restore from backup (backup created before upgrade)
npm run backup:restore -- ./backups/backup-<timestamp> --confirm

# Checkout previous version
git checkout <previous-tag>
npm ci --omit=dev --ignore-scripts
npm run build

# Restart
pm2 start complaints-platform
```

## Health Monitoring

```bash
# Liveness: always returns 200 if process is up
curl http://localhost:3000/api/health/live

# Readiness: checks DB, storage, auth config
curl http://localhost:3000/api/health/ready

# Integrity check
npm run integrity:check

# Release check (pre-deployment validation)
npm run release:check
```

## Cookie Security

In production, the auth cookie requires HTTPS. Set in .env:
- `AUTH_SECRET` must be 32+ random bytes
- Access site via HTTPS only — HTTP will not set the secure cookie

## Storage Permissions

```bash
# Storage must be writable by the Node process
chown -R nodeuser:nodeuser /opt/complaints-platform/storage
chown -R nodeuser:nodeuser /opt/complaints-platform/backups
chmod 700 /opt/complaints-platform/storage
chmod 700 /opt/complaints-platform/backups
```

## Log Location

Application logs are written to stdout. In PM2:
- `~/.pm2/logs/complaints-platform-out.log`
- `~/.pm2/logs/complaints-platform-error.log`

Format: JSON in production (`NODE_ENV=production`).
