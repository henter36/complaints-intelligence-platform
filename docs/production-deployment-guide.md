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

## Production Runtime: Next.js Standalone

`next.config.ts` sets `output: "standalone"`, so `npm run build` (`next
build && node scripts/prepare-standalone-runtime.mjs`) produces a
self-contained `.next/standalone/` directory: a traced `node_modules`
(generated Prisma Client included, but never the `prisma`/`tsx`/`typescript`
CLIs — see "Dependency Policy"), `server.js`, plus `public/` and
`.next/static/` copied in by the prepare script (Next's tracer does not
copy those on its own — they're not `require()`d by any server code).
`npm run start` runs that artifact directly (`node
.next/standalone/server.js`) — **never `next start`**, which serves from
the untraced, full `.next` build and does not match what was actually built
and tested (CI's "Standalone runtime smoke" step boots this exact artifact
and checks static assets, a real page render, and security headers on
every push — see `.github/workflows/ci.yml`).

### Working Directory & Paths

The generated `server.js` calls `process.chdir(__dirname)` as its very
first action — regardless of where you invoke `node .next/standalone/server.js`
from, the running process's working directory becomes `.next/standalone/`
itself. `src/lib/env.ts` falls back to relative paths when some env vars are
unset (`IMPORT_STORAGE_PATH` → `./storage/imports`, `REPORT_STORAGE_PATH` →
`./storage/reports`, `BACKUP_PATH` → `./backups`, and `DATABASE_URL` would
fall back to `file:./dev.db` if it weren't required in production) — left
unset, these would silently resolve to paths *inside the build artifact*
(`.next/standalone/storage/...`), not the intended project/data
directories. `.env.production.example` already sets all of these as
**absolute** paths for exactly this reason — absolute paths are immune to
`process.cwd()` regardless of what invokes the server or from where. Treat
that as mandatory, not a suggestion: every `DATABASE_URL` /
`IMPORT_STORAGE_PATH` / `REPORT_STORAGE_PATH` / `BACKUP_PATH` in this guide
is an absolute path.

Also worth knowing: `next build` bakes a snapshot of whatever `.env*` files
exist on the build host at build time into `.next/standalone/.env` (a core
Next.js behavior — the standalone directory is meant to be fully portable).
`scripts/prepare-standalone-runtime.mjs` deletes that snapshot after every
build so a stale or misplaced copy of your secrets never ships inside a
build artifact — supply real env vars to the running process instead
(the commands below do this via `VAR=... npm run start`; systemd/PM2
examples further down use `EnvironmentFile=`/an ecosystem `env` block).

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
# Edit .env with real values (see file comments) — DATABASE_URL,
# IMPORT_STORAGE_PATH, REPORT_STORAGE_PATH, and BACKUP_PATH must all be
# absolute paths (see "Working Directory & Paths" above).

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

# 8. Build — produces .next/standalone/ (see "Production Runtime" above)
npm run build

# 9. Start — runs .next/standalone/server.js. Bind to 127.0.0.1 when nginx
#    (see "HTTPS Configuration" below) is fronting it on the same host —
#    never expose the standalone server directly to the internet.
PORT=3000 HOSTNAME=127.0.0.1 \
DATABASE_URL="file:/opt/complaints-platform/data/database.sqlite" \
IMPORT_STORAGE_PATH="/opt/complaints-platform/storage/imports" \
REPORT_STORAGE_PATH="/opt/complaints-platform/storage/reports" \
BACKUP_PATH="/opt/complaints-platform/backups" \
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

## Process Management (PM2 / systemd)

Either way, `WorkingDirectory`/PM2's cwd doesn't affect the app's OWN
relative-path behavior (`server.js` always `chdir`s to its own directory —
see "Working Directory & Paths" above); it's still good practice to set it,
because a relative `EnvironmentFile=`/`.env` path (if you use one) resolves
against it.

**PM2:**

```bash
PORT=3000 HOSTNAME=127.0.0.1 \
DATABASE_URL="file:/opt/complaints-platform/data/database.sqlite" \
IMPORT_STORAGE_PATH="/opt/complaints-platform/storage/imports" \
REPORT_STORAGE_PATH="/opt/complaints-platform/storage/reports" \
BACKUP_PATH="/opt/complaints-platform/backups" \
pm2 start /opt/complaints-platform/.next/standalone/server.js \
  --name complaints-platform \
  --cwd /opt/complaints-platform
```

(Or put the same env vars in a PM2 ecosystem file's `env` block instead of
the command line — either way, PM2 must pass them through to the process;
a bare `pm2 start ... --name complaints-platform` with no env vars set
will fall back to the risky relative defaults described above.)

**systemd** (`/etc/systemd/system/complaints-platform.service`):

```ini
[Unit]
Description=Complaints Intelligence Platform
After=network.target

[Service]
Type=simple
User=nodeuser
WorkingDirectory=/opt/complaints-platform
EnvironmentFile=/opt/complaints-platform/.env
Environment=PORT=3000
Environment=HOSTNAME=127.0.0.1
ExecStart=/usr/bin/node /opt/complaints-platform/.next/standalone/server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`EnvironmentFile=` here should point at the real `.env` you configured in
"Initial Setup" step 3 (on the project root, not inside
`.next/standalone/` — that copy is deleted by the build, see "Working
Directory & Paths"). This repo does not ship a systemd unit file; add one
like the above at `/etc/systemd/system/` on the host if you use systemd
instead of PM2.

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

Every route except `/login`, a couple of `/api/auth/*` paths, and exactly
two exact-path monitoring probes — `/api/health/live` and
`/api/health/ready` — requires an authenticated admin session cookie (see
`src/proxy.ts`'s `PUBLIC_API_PATHS`). Those two are allowlisted by their
**exact path only**, not an `/api/health` prefix — any other route added
under `/api/health/` later stays behind the session gate by default unless
it is explicitly allowlisted too. This does not open up the rest of the
API: `/api/analytics`, `/api/complaints`, and everything else still return
`401` without a session, exactly as before (see `src/proxy.test.ts`).

```bash
# Liveness — always 200 while the process is up. Trivial by design: never
# touches the database, filesystem, or network, so it can't itself become
# the thing that's unavailable.
curl --fail http://127.0.0.1:3000/api/health/live

# Readiness — 200 with status "ready" when DB/storage/auth config are all
# healthy; 503 with status "degraded" otherwise. Observational only (a
# SELECT 1 and filesystem access() checks — never writes, creates, or
# migrates anything) and never returns a secret, a raw database/filesystem
# error, or an absolute path — see src/app/api/health/ready/route.ts and
# its tests for the exact contract.
curl --fail http://127.0.0.1:3000/api/health/ready

# Integrity check
npm run integrity:check

# Release check (pre-deployment validation)
npm run release:check
```

Point your uptime checker / load balancer / orchestrator health probe at
these directly (no session needed) — prefer hitting them over `127.0.0.1`
from the same host or through your reverse proxy's internal network,
rather than exposing them on a public hostname unnecessarily. See the
[operations runbook](./operations-runbook.md#monitoring) for what a
liveness vs. readiness failure means operationally.

## Minimal Web-Process Footprint (optional)

The default flow above keeps a full checkout with devDependencies
installed for the life of the host, because the operational scripts under
"Scheduled Reports" and the [operations runbook](./operations-runbook.md)
(`backup:*`, `integrity:check`, `reports:cleanup`, `release:*`, `auth:*`)
are `tsx`-based and are meant to keep running indefinitely, not just at
deploy time.

If your topology instead runs the web process and operational tooling on
**separate** hosts/containers, the standalone artifact `next build` already
produces (see "Production Runtime: Next.js Standalone" above) *is* the
minimal web-process footprint — there is no separate pruning step to run,
because the standalone tracer only ever included the runtime dependencies
(`@prisma/client` and friends) in the first place. It never needed
`prisma`, `tsx`, `typescript`, `eslint`, or `vitest` to begin with:

**Build host** (needs devDependencies — Prisma CLI generates the client
that gets traced into the artifact):

```bash
npm ci --ignore-scripts
npm run db:generate
npm run build   # -> .next/standalone/ (server.js, traced node_modules,
                #    public/, .next/static/, report PDF assets — see
                #    "Production Runtime" above)
```

**Deploy**: copy `.next/standalone/` to the web-only host/container by
whatever mechanism you already use (rsync, a container COPY layer, a
tarball) — nothing else from the repo is needed there.

**Runtime host** — no `npm install`/`npm ci`/`npm prune` at all, no
`prisma`/`tsx`/`typescript`, just the copied directory and Node itself:

```bash
PORT=3000 HOSTNAME=127.0.0.1 \
DATABASE_URL="file:/opt/complaints-platform/data/database.sqlite" \
IMPORT_STORAGE_PATH="/opt/complaints-platform/storage/imports" \
REPORT_STORAGE_PATH="/opt/complaints-platform/storage/reports" \
node server.js
```

This has been verified to work: a copy of `.next/standalone/` moved
completely outside the repository (no access to its `node_modules`) boots,
serves `/login`/static assets/`.next/static` chunks with the expected
security headers, and a direct `@prisma/client` query against a real
migrated test database succeeds — all using only files inside that copy.
`npm audit --omit=dev --audit-level=high` already reports 0 vulnerabilities
against the full `dependencies` tree (see "Dependency Policy"), so nothing
extra needs pruning or auditing on this host.

**Migrations, backups, integrity checks, and any other `tsx`-based
operational command still need to run from a full, un-pruned checkout**
(the build host, or a separate operational host — see "Scheduled Reports"
and the operations runbook) — they were never part of this minimal
artifact and copying `.next/standalone/` alone does not give you a way to
run them.

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
