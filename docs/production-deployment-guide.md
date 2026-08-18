# Production Deployment Guide

## Prerequisites

- Node.js 20+ (tested on 24)
- 1GB+ disk space
- A reverse proxy (nginx/caddy) for HTTPS
- SQLite 3.x (built into Node.js via better-sqlite3)

## Dependency Policy

`prisma` (the CLI: `generate`/`migrate`/`db seed`/`studio`) is a **build and
operational tool**, not something the running application imports —
`@prisma/client` (the generated client the app actually calls) has zero
runtime dependency on it. So `prisma` lives in `devDependencies`, and
`@prisma/client` lives in `dependencies`. This is why every step below that
needs the Prisma CLI — `db:generate`, `db:validate`, `migrate deploy`, `db
seed` — must run with devDependencies installed (`npm ci`, not `npm ci
--omit=dev`), and why `npm run audit:runtime` (`npm audit --omit=dev`, the
CI hard gate) never sees `prisma`'s own dependency tree.

This project's operational scripts (`backup:*`, `integrity:check`,
`release:*`, `reports:cleanup`, `ai:cleanup`, `auth:*` — see "Scheduled
Reports" and the [operations runbook](./operations-runbook.md)) are also
`tsx`-based (a devDependency) and are meant to keep running for the entire
life of the deployment, not just at install time — so the steps below
**keep devDependencies installed** rather than pruning them. See "Minimal
Web-Process Footprint (optional)" at the end of this guide for a validated,
opt-in alternative for operators who run the web process and operational
tooling on separate hosts/containers.

## Initial Setup

```bash
# 1. Clone repository
git clone <repo-url> /opt/complaints-platform
cd /opt/complaints-platform

# 2. Install dependencies, INCLUDING devDependencies (no scripts for security).
#    devDependencies are required here and for the lifetime of this host —
#    see "Dependency Policy" above. Do not pass --omit=dev.
npm ci --ignore-scripts

# 3. Configure environment
cp .env.production.example .env
# Edit .env with real values (see file comments)

# 4. Validate and generate the Prisma client, then apply migrations
DATABASE_URL="file:/opt/complaints-platform/data/database.sqlite" npm run db:validate
DATABASE_URL="file:/opt/complaints-platform/data/database.sqlite" npm run db:generate
DATABASE_URL="file:/opt/complaints-platform/data/database.sqlite" npm run db:migrate:deploy

# 5. Seed — only on a genuinely fresh database (db:seed can insert baseline
#    reference data; do not run it against an existing production database
#    as a matter of routine — see "Upgrade Procedure" below, which never seeds).
DATABASE_URL="file:/opt/complaints-platform/data/database.sqlite" npm run db:seed

# 6. Initialize admin account
AUTH_ADMIN_USERNAME="admin" npm run auth:init-admin

# 7. Create storage directories
mkdir -p /opt/complaints-platform/storage/imports
mkdir -p /opt/complaints-platform/storage/reports
mkdir -p /opt/complaints-platform/backups
chmod 700 /opt/complaints-platform/storage
chmod 700 /opt/complaints-platform/backups

# 8. Build
npm run build

# 9. Start
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

Add to cron. `reports-run-due.ts` and `ai-cleanup.ts` have no imports beyond
Node builtins/`@prisma/client`, so they run under plain `node` even without
devDependencies installed; `reports-cleanup.ts` imports application code
under `src/` and needs `tsx` (a devDependency — see "Dependency Policy"
above), so it's run via `npm run` instead:

```bash
# Run due reports every 5 minutes
*/5 * * * * cd /opt/complaints-platform && DATABASE_URL="file:./data/database.sqlite" INTERNAL_SCHEDULER_SECRET="..." node scripts/reports-run-due.ts

# Clean expired reports daily
0 2 * * * cd /opt/complaints-platform && DATABASE_URL="file:./data/database.sqlite" npm run reports:cleanup

# AI cleanup (if AI enabled)
0 3 * * * cd /opt/complaints-platform && DATABASE_URL="file:./data/database.sqlite" node scripts/ai-cleanup.ts
```

## Upgrade Procedure

Migration is a **deployment step**, run once per upgrade with the new code
and devDependencies in place — not something the running application does
on its own. Never run `db:seed` here; it is a fresh-install step only (see
"Initial Setup").

```bash
# 1. Create backup
npm run backup:create

# 2. Pull new code
git pull

# 3. Install dependencies, INCLUDING devDependencies (see "Dependency Policy")
npm ci --ignore-scripts

# 4. Validate schema and run migrations
DATABASE_URL="file:./data/database.sqlite" npm run db:validate
DATABASE_URL="file:./data/database.sqlite" npm run db:migrate:deploy

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
npm ci --ignore-scripts
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

## Minimal Web-Process Footprint (optional)

The default flow above keeps devDependencies installed for the life of the
host, because the operational scripts under "Scheduled Reports" and
[operations runbook](./operations-runbook.md) (`backup:*`,
`integrity:check`, `reports:cleanup`, `release:*`, `auth:*`) are `tsx`-based
and are meant to keep running indefinitely, not just at deploy time.

If your topology instead runs the web process and operational tooling on
**separate** hosts/containers (e.g. the web container only ever runs `npm
run start`, and backups/integrity checks run from a different, fully-`npm
ci`'d checkout against the same database/storage volumes), the web
process's own footprint can be pruned down to production dependencies only,
*after* build:

```bash
npm ci --ignore-scripts
npm run db:validate
npm run db:generate
DATABASE_URL="..." npm run db:migrate:deploy
npm run build
# --legacy-peer-deps works around a pre-existing, unrelated optional peer
# conflict (openai's optional zod@3.x peer vs. this project's zod@4.x) that
# otherwise makes `npm prune` refuse to compute the ideal tree. `npm ci`
# above is unaffected (it never re-resolves), so this is only needed here.
npm prune --omit=dev --legacy-peer-deps   # removes prisma, tsx, typescript, eslint, vitest, ...
npm run start
```

This has been verified to work: `npm audit --omit=dev --audit-level=high`
reports 0 vulnerabilities post-prune, `prisma`/`tsx`/`typescript` are
physically absent from `node_modules`, and a direct `@prisma/client` check
(`new PrismaClient()` + a real query against a test database) succeeds using
only the pruned tree — the generated client (built by `db:generate`
*before* pruning) has no runtime dependency on the `prisma` CLI. The web
process itself starts and serves requests (`next start` logs "Ready").
**Note:** every route except `/login` and a couple of `/api/auth/*` paths
requires an authenticated admin session cookie (see `src/proxy.ts`) — this
is a pre-existing, unrelated application policy, not something pruning
changes, so an unauthenticated `curl /api/health/live` returns 401 by
design; point uptime monitoring at it through a session, or treat process
liveness (`next start` logged "Ready", HTTP port accepting connections) as
your liveness signal.

**After pruning, `npm run backup:create`, `npm run integrity:check`, `npm
run reports:cleanup`, `npm run release:check`, `npm run auth:*`, and `npm
run db:migrate:deploy` itself no longer work on this host** (they need
`tsx`/`prisma`) — run them from an un-pruned checkout, or reinstall
devDependencies (`npm ci --ignore-scripts`) before running them, then prune
again afterward. `reports-run-due.ts` and `ai-cleanup.ts` still work
post-prune (invoked via plain `node`, not `npm run` — see "Scheduled
Reports").

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
