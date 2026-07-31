# Release Checklist — v1.0.0

Run `npm run release:check` to automate most of these checks.

## Pre-Release

- [ ] All tests passing: `npm test`
- [ ] TypeScript clean: `npm run typecheck`
- [ ] ESLint clean: `npm run lint`
- [ ] Build succeeds: `npm run build`
- [ ] No high vulnerabilities: `npm run audit:runtime`
- [ ] `.env` has no placeholder values
- [ ] `.env`, `.env.admin` not tracked by git
- [ ] Database not tracked by git
- [ ] Storage directories not tracked by git
- [ ] Backup directories not tracked by git
- [ ] Release manifest generated: `npm run release:manifest`
- [ ] Release check passes: `npm run release:check`
- [ ] Integrity check passes: `npm run integrity:check`

## Database

- [ ] All migrations applied: `npx prisma migrate status`
- [ ] Seed data correct
- [ ] Admin credential exists (not default)
- [ ] Password changed from initial value

## Storage

- [ ] Import storage exists and writable: `./storage/imports` (or custom path)
- [ ] Report storage exists and writable: `./storage/reports` (or custom path)
- [ ] Backup storage exists and writable: `./backups` (or custom path)

## Health Checks

- [ ] `/api/health/live` → 200
- [ ] `/api/health/ready` → 200 with all checks OK

## Security

- [ ] AUTH_SECRET is at least 32 random bytes (not CHANGE_ME)
- [ ] INTERNAL_SCHEDULER_SECRET is at least 32 random bytes
- [ ] HTTPS configured on reverse proxy
- [ ] Access logs enabled on reverse proxy
- [ ] Firewall allows only 80/443 from public

## AI (if enabling)

- [ ] AI_ENABLED=true only if intentional
- [ ] OPENAI_API_KEY is valid (not placeholder)
- [ ] AI_DAILY_RUN_LIMIT set appropriately for budget
- [ ] AI_RETENTION_DAYS set appropriately

## Post-Deploy

- [ ] Create initial backup: `npm run backup:create`
- [ ] Verify backup: `npm run backup:verify -- <path>`
- [ ] Confirm health ready: `curl /api/health/ready`
- [ ] Login and verify dashboard loads
- [ ] Confirm scheduled reports configured (if needed)
- [ ] Document deployment date and commit SHA in team log
