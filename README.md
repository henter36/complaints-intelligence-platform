# Complaints Intelligence Platform

Arabic complaints intelligence prototype with Phase 3 single-user secure mode foundations.

This repository is not production ready. Phase 1 made the codebase buildable and testable. Phase 2 added a normalized single-user complaint/import schema, migration, seed, and domain services. Phase 3 adds single-user administrator login, database-backed sessions, logout, password change, rate limiting, security headers, and API/page protection. Excel upload, report exports, and governed AI remain out of scope.

## Current Status

- Working: dashboard read APIs, complaints listing, filters, classification/category basics, import history, UI navigation, Phase 2 Prisma migration, synthetic Prisma seed, and Phase 3 single-user authentication.
- Working foundation: `Complaint`, `ComplaintStatusHistory`, `ImportBatch`, `ImportBatchRow`, `AuditLog`, duplicate identity service, and import batch transition guards.
- Security: one administrator credential, bcrypt password hashes, hashed session tokens in `AdminSession`, `cip_session` HttpOnly cookie, login rate limiting, logout, password change, and operational API guards.
- Partial: import center UI can collect metadata, but full Excel parsing/import is not implemented.
- Stubbed: import approval and AI approval/execution endpoints return `501` until their later phases.
- Missing: scoped permissions, transactional import confirmation/rollback, production database architecture, exports, report scheduling, MFA, and external identity providers.

## Requirements

- Node.js 24.x
- npm via `package-lock.json`
- SQLite for local prototype development

Do not use Bun for this project. `bun.lock` and Z.ai generation runtime files were removed in Phase 1.

## Environment

Create a local `.env` from `.env.example`:

```env
DATABASE_URL="file:./dev.db"
ADMIN_USERNAME="admin"
ADMIN_PASSWORD_HASH="CHANGE_ME_TO_BCRYPT_HASH"
AUTH_SECRET="CHANGE_ME_WITH_AT_LEAST_32_RANDOM_BYTES"
SESSION_TTL_HOURS="8"
OPENAI_API_KEY="CHANGE_ME"
```

Generate and initialize the administrator credential:

```bash
npm run auth:hash-password -- "YOUR_LONG_PASSWORD"
ADMIN_USERNAME="admin" ADMIN_PASSWORD_HASH="<hash>" npm run auth:init-admin
```

`DATABASE_URL`, `AUTH_SECRET`, and the initialized admin credential are required for authenticated operation. `OPENAI_API_KEY` remains a placeholder until governed AI is implemented.

## Local Setup

```bash
npm ci
DATABASE_URL="file:./dev.db" npm run db:validate
DATABASE_URL="file:./dev.db" npm run db:generate
DATABASE_URL="file:./dev.db" npx prisma migrate deploy
DATABASE_URL="file:./dev.db" npm run db:seed
ADMIN_USERNAME="admin" ADMIN_PASSWORD_HASH="<hash>" npm run auth:init-admin
npm run dev
```

Use Prisma migrations for schema changes. `db:push` is retained for local experiments only and must not replace migrations.

## Verification

```bash
npx prisma validate
npx prisma generate
npx prisma migrate deploy
npm run typecheck
npm run lint
npm test
npm run build
npm run audit:runtime
```

Runtime high audit is expected to pass. Known exception: the full audit currently reports high findings in development tooling through `brace-expansion`/`minimatch` chains:

```bash
npm audit --audit-level=high
```

## Documentation

- `docs/current-state-assessment.md`
- `docs/foundation-hardening-report.md`
- `docs/phase-2-data-model-design.md`
- `docs/phase-2-completion-report.md`
- `docs/phase-3-single-user-security-design.md`
- `docs/phase-3-completion-report.md`
- `docs/roadmap.md`
