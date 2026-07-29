# Complaints Intelligence Platform

Arabic complaints intelligence prototype with Phase 2 complaint/import data model foundations.

This repository is not production ready. Phase 1 made the codebase buildable and testable. Phase 2 adds a normalized single-user complaint/import schema, migration, seed, and domain services. Authentication, Excel upload, reports, and governed AI remain out of scope.

## Current Status

- Working: dashboard read APIs, complaints listing, filters, classification/category basics, import history, UI navigation, Phase 2 Prisma migration, synthetic Prisma seed.
- Working foundation: `Complaint`, `ComplaintStatusHistory`, `ImportBatch`, `ImportBatchRow`, `AuditLog`, duplicate identity service, and import batch transition guards.
- Partial: import center UI can collect metadata, but full Excel parsing/import is not implemented.
- Stubbed: import approval and AI approval/execution endpoints return `501` until their later phases.
- Missing: enterprise authentication, scoped permissions, transactional import confirmation/rollback, production database architecture, exports, report scheduling.

## Requirements

- Node.js 24.x
- npm via `package-lock.json`
- SQLite for local prototype development

Do not use Bun for this project. `bun.lock` and Z.ai generation runtime files were removed in Phase 1.

## Environment

Create a local `.env` from `.env.example`:

```env
DATABASE_URL="file:./dev.db"
AUTH_SECRET="CHANGE_ME"
NEXTAUTH_URL="http://localhost:3000"
OPENAI_API_KEY="CHANGE_ME"
```

`DATABASE_URL` is required in production. `AUTH_SECRET`, `NEXTAUTH_URL`, and `OPENAI_API_KEY` are placeholders until authentication and governed AI are implemented.

## Local Setup

```bash
npm ci
DATABASE_URL="file:./dev.db" npm run db:validate
DATABASE_URL="file:./dev.db" npm run db:generate
DATABASE_URL="file:./dev.db" npx prisma migrate deploy
DATABASE_URL="file:./dev.db" npm run db:seed
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
- `docs/roadmap.md`
