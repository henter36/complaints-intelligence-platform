# Complaints Intelligence Platform

Arabic complaints intelligence platform — v0.2.1, Phase 8 complete, ready for v1.0.0 release.

Phase 1 made the codebase buildable and testable. Phase 2 normalized the data model. Phase 3 added single-user authentication. Phase 4 added Excel import. Phase 5 added transactional confirmation/rollback. Phase 6 added the complaint explorer and KPIs. Phase 7 added the reports and scheduling engine. Phase 8 added governed AI analysis, backup/restore, health checks, database integrity, security hardening (CSP), and release tooling.

## Current Status

- **Authentication**: Single administrator credential, bcrypt hashes, HttpOnly session cookie, login rate limiting, logout, password change.
- **Import**: `.xlsx` upload, validation, duplicate detection, preview, transactional confirmation and rollback.
- **Complaints**: Explorer with validated filters, deterministic sorting, pagination, detail/status APIs, KPIs, safe CSV export.
- **Reports**: Six report types (executive, department, region/facility, classification, detail, overdue), PDF/XLSX export, saved templates, internal scheduling (Asia/Riyadh), 90-day artifact retention.
- **Governed AI**: 5 analysis types (executive summary, recurring topics, root causes, anomaly analysis, improvement opportunities). AI is **disabled by default** (`AI_ENABLED=false`). When enabled: read-only, PII-free, fully audited, rate-limited, with a daily run limit and 5-minute dedup window. No chatbot, no NL-to-SQL, no scheduled AI runs.
- **Operations**: Backup/restore with SHA-256 checksums (`npm run backup:create/verify/restore`), health endpoints (`/api/health/live`, `/api/health/ready`), database integrity check (`npm run integrity:check`), release manifest (`npm run release:manifest`), release check (`npm run release:check`).
- **Security**: CSP on all routes, centralized logger (no PII in logs), AI key never returned via API or stored in database, placeholder secrets rejected at startup when AI is enabled.
- Missing: scoped permissions, email delivery, MFA, external identity providers (planned post-v1.0).

## Requirements

- Node.js 24.x
- npm via `package-lock.json`
- SQLite for local prototype development

Do not use Bun for this project. `bun.lock` and Z.ai generation runtime files were removed in Phase 1.

## Environment

Create a local `.env` from `.env.example`:

```env
DATABASE_URL="file:./dev.db"
AUTH_SECRET="<generate-a-strong-random-value>"
AI_ENABLED="false"
```

The example above shows only the essentials. AI is optional and **disabled by default** (`AI_ENABLED="false"`). When `AI_ENABLED="true"`, a valid, non-placeholder `OPENAI_API_KEY` is required — placeholder values such as `CHANGE_ME` are rejected at startup. All `AI_*` and `BACKUP_*` variables (and every other supported setting) are documented in `.env.example`; copy from there rather than pasting credentials here. Do not pass credentials or password hashes directly in shell commands.

Generate and initialize the administrator credential:

```bash
npm run auth:hash-password
npm run auth:init-admin -- --env-file .env.admin
```

`auth:hash-password` reads from a hidden prompt when run interactively, or protected stdin in automation. Store `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH` in a protected local env file such as `.env.admin`; do not pass reusable administrator credentials or password hashes inline in shell commands.

`DATABASE_URL`, `AUTH_SECRET`, and the initialized admin credential are required for authenticated operation. `OPENAI_API_KEY` is optional — AI is disabled by default (`AI_ENABLED=false`). Set `AI_ENABLED=true` and provide a valid `OPENAI_API_KEY` only if you want to enable governed AI analysis.

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

Runtime high audit is expected to pass. Known exception: the full audit currently reports high findings in development tooling through `brace-expansion`/`minimatch` chains, and through `deepmerge-ts` (a transitive dependency of the `prisma` CLI's `@prisma/config`, with no fix available within the Prisma 6.x line — `prisma` is a devDependency, so `npm run audit:runtime` never sees it):

```bash
npm audit --audit-level=high
```

## Excel Import

Phase 4 accepts `.xlsx` files only. The server validates extension, MIME type, ZIP magic bytes, OOXML structure, internal ZIP paths, active workbook content, file size, sheet count, row count, and column count before saving import rows. Files are stored under `IMPORT_STORAGE_PATH`, which is ignored by Git, and are never placed under `public/`.

The parser uses `jszip` and `fast-xml-parser` to read OOXML XML parts directly. It does not evaluate formulas, macros, or external links.

### Operational Arabic workbook support

The importer auto-maps common Arabic operational headers without requiring the user to rename columns. Examples:

| Excel header | System field |
| --- | --- |
| رقم الشكوى | `externalId` |
| المُعرف / المعرف | `sourceReference` |
| هوية السجين | `complainantIdentifier` (masked in preview) |
| تاريخ التسجيل | `receivedAt` |
| تاريخ الإنشاء | `complaintDate` |
| الوصف | `description` |
| السجن | `facility` |
| المنطقة | `region` |
| القسم | `department` |
| المصدر | `channel` |
| الحالة | `status` (unknown source labels warn and default to `NEW`) |
| تصنيف | classification name lookup (never auto-created) |
| الإجراء المتخذ | `resolution` |

Arabic header matching strips diacritics/tatweel, folds alef/ya/ta-marbuta variants, collapses whitespace, and case-folds English synonyms. Unmapped columns remain in `rawData` with a non-blocking warning.

**Dates:** Excel serial numbers such as `46126` and fractional values like `46126.47108796296` are parsed as Excel epoch dates (UTC), not Unix timestamps. `آخر تحديث في` is never used as complaint/received date.

**Identity priority:** `externalId` from `رقم الشكوى` wins over `sourceReference` from `المُعرف`. Complainant national IDs are never used as complaint identity or fingerprints.

**Subject policy:** either `subject` or `description` satisfies text requirements. When the database requires `subject` and only `description` is present, the importer derives a deterministic truncated subject (no AI).

**Row limits:** `IMPORT_MAX_ROWS` counts non-empty data rows only (header and trailing/formatting empty rows are excluded).

**Privacy:** preview and row APIs return masked complainant identifiers (for example `1000000000` → `******0000`). Full identifiers are not placed in public errors, CSV error reports, audit metadata, or AI payloads.

**Duplicates:** same `externalId` inside one workbook blocks confirmation; re-import with no meaningful field changes yields `NO_CHANGE`, while allowed field changes yield `UPDATE`.

Synthetic example only:

```text
رقم الشكوى = COMP/TEST-001
المُعرف = TEST-REF-001
تاريخ التسجيل = 46126
الوصف = وصف صناعي لا يحتوي بيانات تشغيلية
```

## Import data quality

Import validation distinguishes:

- **Blocking errors** (reject row): missing identity, missing/invalid required dates, formulas, hard taxonomy conflicts.
- **Warnings** (import allowed): missing description (nullable), terminal status without `closedAt`.
- **Derived values**: description filled from `subject` or a neutral classification label when the original description is empty.

Terminal statuses (`RESOLVED`, `CLOSED`, `CANCELLED`) without `closedAt` are imported with a warning. No invented close dates (not today, not import time, not received date). Timing KPIs that need `closedAt` exclude those rows (`resolutionDays` stays null).

Error CSV includes complaint number (from matched `externalId`, raw headers, or `غير متوفر`), message level, original/used values, and whether the row can be imported.

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

## Phase 8 Release Verification

```bash
npm run integrity:check        # database consistency (10 checks)
npm run release:manifest       # generate release-manifest.json
npm run release:check          # 11 pre-release validations
```

## Documentation

- `docs/production-deployment-guide.md` — step-by-step production setup
- `docs/backup-restore-guide.md` — backup creation, verification, restore
- `docs/operations-runbook.md` — daily/weekly ops and troubleshooting
- `docs/release-checklist.md` — v1.0.0 release checklist
- `docs/phase-8-governed-ai-design.md` — AI architecture and governance
- `docs/phase-8-security-review.md` — security controls summary
- `docs/phase-8-performance-report.md` — performance baselines
- `docs/phase-8-e2e-report.md` — E2E test scope and manual coverage
- `docs/phase-8-final-gap-analysis.md` — what's in scope and out
- `docs/phase-8-completion-report.md` — Phase 8 delivery summary
- `docs/phase-7-reporting-design.md`
- `docs/phase-7-completion-report.md`
- `docs/roadmap.md`
