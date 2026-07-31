# Complaints Intelligence Platform

Arabic complaints intelligence prototype with a Phase 7 reports, exports, and scheduling engine.

This repository is not production ready. Phase 1 made the codebase buildable and testable. Phase 2 added a normalized single-user complaint/import schema, migration, seed, and domain services. Phase 3 adds single-user administrator login, database-backed sessions, logout, password change, rate limiting, security headers, and API/page protection. Phase 4 adds secure `.xlsx` upload, OOXML parsing, validation, duplicate detection, preview rows, and CSV error reports. Phase 5 adds transactional import confirmation and rollback. Phase 6 adds a central complaint query service, KPI engine, complaint detail/update/status APIs, and safe CSV list export. Phase 7 adds a central report engine (six governed report types), PDF/XLSX export, saved templates, internal scheduling, and a 90-day artifact retention policy. Governed AI remains out of scope.

## Current Status

- Working: dashboard read APIs, complaints listing, filters, classification/category basics, import history, UI navigation, Phase 2 Prisma migration, synthetic Prisma seed, and Phase 3 single-user authentication.
- Working foundation: `Complaint`, `ComplaintStatusHistory`, `ImportBatch`, `ImportBatchRow`, `AuditLog`, duplicate identity service, and import batch transition guards.
- Security: one administrator credential, bcrypt password hashes, hashed session tokens in `AdminSession`, `cip_session` HttpOnly cookie, login rate limiting, logout, password change, and operational API guards.
- Working: import center can upload `.xlsx`, validate rows, store preview rows, confirm eligible batches, and roll back confirmed batches.
- Working: complaint explorer can query confirmed active complaints with validated filters, deterministic sorting, pagination, detail APIs, status/update APIs, central KPIs, and safe CSV export.
- Working: reports center can preview, export PDF/XLSX, save/run templates, schedule recurring runs (daily/weekly/monthly, Asia/Riyadh), browse run history, and download artifacts — all backed by the same KPI/query services as the Dashboard and Analytics screens.
- Stubbed: AI approval/execution endpoints return `501` until their later phases.
- Missing: scoped permissions, production database architecture, email delivery of reports, MFA, and external identity providers.

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
REPORT_STORAGE_PATH="./storage/reports"
REPORT_RETENTION_DAYS="90"
REPORT_MAX_ROWS="10000"
REPORT_MAX_FILE_SIZE_MB="25"
INTERNAL_SCHEDULER_SECRET="CHANGE_ME_WITH_AT_LEAST_32_RANDOM_BYTES"
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

## Reports, Exports, And Scheduling

Phase 7 adds a central report engine on top of the Phase 6 `ComplaintQueryService`/`ComplaintKpiService` — no report recomputes a metric independently, so PDF/XLSX/preview numbers always match the Dashboard and Analytics screens for the same filters.

- **Report types**: `EXECUTIVE_SUMMARY`, `DEPARTMENT_PERFORMANCE`, `REGION_FACILITY_PERFORMANCE`, `CLASSIFICATION_ANALYSIS`, `COMPLAINT_DETAIL` (XLSX only, 10,000-row cap, no PII by default), `OVERDUE_COMPLAINTS`.
- **PDF**: `pdfkit` + the OFL-licensed Amiri font (bundled locally under `src/server/reports/assets/fonts`, full Unicode coverage so Arabic and Latin digits render in the same document), right-aligned RTL layout, page numbers, and a Riyadh-time generation stamp.
- **XLSX**: `exceljs`, right-to-left sheet views, frozen header row, autofilter, real numeric/date cell types, and formula-injection protection (`=`, `+`, `-`, `@` prefixes are neutralized as literal text).
- **Templates and scheduling**: `ReportTemplate` stores a reusable filter/option set; `ReportSchedule` computes `nextRunAt` in `Asia/Riyadh` for `DAILY`/`WEEKLY`/`MONTHLY` frequencies (a `MONTHLY` day that doesn't exist in a given month falls back to that month's last day). `POST /api/internal/reports/run-due` executes at most one due schedule per call, is protected by `INTERNAL_SCHEDULER_SECRET` (not the session cookie, constant-time compared), and is idempotent per scheduled slot.
- **Storage and retention**: generated files are stored outside `public/` under `REPORT_STORAGE_PATH` with random filenames and sha256 checksums; `npm run reports:cleanup` (supports `--dry-run`) removes artifacts past their `REPORT_RETENTION_DAYS` (default 90) expiry and audit-logs each deletion without touching `ReportRun` or `AuditLog` rows.
- **Local scheduler script**: `npm run reports:run-due` calls the internal endpoint once; run it from an OS-level cron (`INTERNAL_SCHEDULER_SECRET` and, optionally, `APP_BASE_URL` must be set in the environment it runs under).

See `docs/phase-7-reporting-design.md` and `docs/phase-7-completion-report.md` for the full design and results.

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
- `docs/phase-7-reporting-design.md`
- `docs/phase-7-completion-report.md`
- `docs/roadmap.md`
