# Complaints Intelligence Platform

Arabic complaints intelligence prototype with Phase 6 complaint explorer and KPI engine.

This repository is not production ready. Phase 1 made the codebase buildable and testable. Phase 2 added a normalized single-user complaint/import schema, migration, seed, and domain services. Phase 3 adds single-user administrator login, database-backed sessions, logout, password change, rate limiting, security headers, and API/page protection. Phase 4 adds secure `.xlsx` upload, OOXML parsing, validation, duplicate detection, preview rows, and CSV error reports. Phase 5 adds transactional import confirmation and rollback. Phase 6 adds a central complaint query service, KPI engine, complaint detail/update/status APIs, and safe CSV list export. PDF/XLSX reports and governed AI remain out of scope.

## Current Status

- Working: dashboard read APIs, complaints listing, filters, classification/category basics, import history, UI navigation, Phase 2 Prisma migration, synthetic Prisma seed, and Phase 3 single-user authentication.
- Working foundation: `Complaint`, `ComplaintStatusHistory`, `ImportBatch`, `ImportBatchRow`, `AuditLog`, duplicate identity service, and import batch transition guards.
- Security: one administrator credential, bcrypt password hashes, hashed session tokens in `AdminSession`, `cip_session` HttpOnly cookie, login rate limiting, logout, password change, and operational API guards.
- Working: import center can upload `.xlsx`, validate rows, store preview rows, confirm eligible batches, and roll back confirmed batches.
- Working: complaint explorer can query confirmed active complaints with validated filters, deterministic sorting, pagination, detail APIs, status/update APIs, central KPIs, and safe CSV export.
- Stubbed: AI approval/execution endpoints return `501` until their later phases.
- Missing: scoped permissions, production database architecture, exports, report scheduling, MFA, and external identity providers.

## Requirements

- Node.js 24.x
- npm via `package-lock.json`
- SQLite for local prototype development

Do not use Bun for this project. `bun.lock` and Z.ai generation runtime files were removed in Phase 1.

## Environment

Create a local `.env` from `.env.example`:

```env
DATABASE_URL="file:./dev.db"
AUTH_SECRET="CHANGE_ME_WITH_AT_LEAST_32_RANDOM_BYTES"
SESSION_TTL_HOURS="8"
IMPORT_MAX_FILE_SIZE_MB="10"
IMPORT_MAX_ROWS="10000"
IMPORT_MAX_COLUMNS="100"
IMPORT_MAX_SHEETS="5"
IMPORT_STORAGE_PATH="./storage/imports"
IMPORT_RETENTION_DAYS="30"
OPENAI_API_KEY="CHANGE_ME"
```

Generate and initialize the administrator credential:

```bash
npm run auth:hash-password
npm run auth:init-admin -- --env-file .env.admin
```

`auth:hash-password` reads from a hidden prompt when run interactively, or protected stdin in automation. Store `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH` in a protected local env file such as `.env.admin`; do not pass reusable administrator credentials or password hashes inline in shell commands.

`DATABASE_URL`, `AUTH_SECRET`, and the initialized admin credential are required for authenticated operation. `OPENAI_API_KEY` remains a placeholder until governed AI is implemented.

## Local Setup

```bash
npm ci
DATABASE_URL="file:./dev.db" npm run db:validate
DATABASE_URL="file:./dev.db" npm run db:generate
DATABASE_URL="file:./dev.db" npx prisma migrate deploy
DATABASE_URL="file:./dev.db" npm run db:seed
npm run auth:init-admin -- --env-file .env.admin
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

## Excel Import

Phase 4 accepts `.xlsx` files only. The server validates extension, MIME type, ZIP magic bytes, OOXML structure, internal ZIP paths, active workbook content, file size, sheet count, row count, and column count before saving import rows. Files are stored under `IMPORT_STORAGE_PATH`, which is ignored by Git, and are never placed under `public/`.

The parser uses `jszip` and `fast-xml-parser` to read OOXML XML parts directly. It does not evaluate formulas, macros, or external links.

## Import Confirmation

Phase 5 confirms batches only from `READY_FOR_CONFIRMATION`. Confirmation runs transactionally, creates `NEW` complaints, updates `UPDATE` complaints with optimistic preview-version checks, skips `NO_CHANGE` and `DUPLICATE`, and blocks any batch containing rejected or invalid rows. Rollback uses immutable `ImportChangeSnapshot` records and refuses to proceed if complaints changed after confirmation.

## Complaint Explorer And KPIs

Phase 6 centralizes complaint filters and KPI definitions. `GET /api/complaints`, `GET /api/dashboard`, `GET /api/analytics`, and `GET /api/complaints/export` share the same query contract. `RESOLVED` and `CLOSED` are operationally closed, `CANCELLED` is terminal but separate, and due-date compliance uses only closed complaints with due dates in its denominator.

## Documentation

- `docs/current-state-assessment.md`
- `docs/foundation-hardening-report.md`
- `docs/phase-2-data-model-design.md`
- `docs/phase-2-completion-report.md`
- `docs/phase-3-single-user-security-design.md`
- `docs/phase-3-completion-report.md`
- `docs/phase-4-excel-import-design.md`
- `docs/phase-4-completion-report.md`
- `docs/phase-5-import-confirmation-design.md`
- `docs/phase-5-completion-report.md`
- `docs/phase-6-explorer-kpi-design.md`
- `docs/phase-6-completion-report.md`
- `docs/roadmap.md`
