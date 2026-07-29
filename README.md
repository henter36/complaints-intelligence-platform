# Complaints Intelligence Platform

Foundation Recovery phase for an Arabic complaints intelligence prototype.

This repository is not production ready. Phase 1 focuses on making the current codebase buildable, testable, and auditable before expanding the data model, authentication, Excel import, reporting, or AI governance.

## Current Status

- Working: dashboard read APIs, complaints listing, filters, classifications basics, import history, UI navigation, synthetic Prisma seed.
- Partial: import center UI and approval metadata flow. Full Excel parsing/import is not implemented.
- Stubbed: AI analysis and AI executive summary endpoints return `501` until governed AI is designed.
- Missing: enterprise authentication, scoped permissions, transactional approval/rollback, production database architecture, exports, report scheduling.

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
npm run db:validate
npm run db:generate
npm run db:push
npm run db:seed
npm run dev
```

`db:push` is retained for local prototype setup only and does not use `--accept-data-loss`. Use migrations for intentional schema changes.

## Verification

```bash
npx prisma validate
npx prisma generate
npm run typecheck
npm run lint
npm test
npm run build
npm audit --audit-level=high
```

Known exception: the full audit currently reports high findings in development tooling through `brace-expansion`/`minimatch` chains. Runtime high audit is available through:

```bash
npm run audit:runtime
```

## Documentation

- `docs/current-state-assessment.md`
- `docs/foundation-hardening-report.md`
- `docs/roadmap.md`
