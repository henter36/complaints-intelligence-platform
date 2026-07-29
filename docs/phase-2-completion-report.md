# Phase 2 Completion Report

## Summary

Phase 2 rebuilds the complaint and import data model for a single-user local prototype. It does not implement authentication, permissions, Excel upload, report generation, or governed AI execution.

## New Entities

- `Category`
- `Classification`
- `Complaint`
- `ComplaintStatusHistory`
- `ImportBatch`
- `ImportBatchRow`
- `AuditLog`

`ReportTemplate` remains for existing UI shape, and the seed creates one synthetic monthly summary template. Report generation is outside Phase 2.

## Enums

- `ComplaintStatus`: `NEW`, `OPEN`, `IN_PROGRESS`, `AWAITING_RESPONSE`, `RESOLVED`, `CLOSED`, `CANCELLED`
- `ComplaintPriority`: `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`
- `ImportBatchStatus`: `UPLOADED`, `PARSING`, `VALIDATED`, `READY_FOR_CONFIRMATION`, `CONFIRMING`, `CONFIRMED`, `FAILED`, `ROLLED_BACK`
- `ImportRowAction`: `NEW`, `UPDATE`, `DUPLICATE`, `REJECT`, `NO_CHANGE`
- `ImportRowValidationStatus`: `PENDING`, `VALID`, `WARNING`, `INVALID`
- `PeriodType`: `DAILY`, `WEEKLY`, `MONTHLY`, `CUSTOM`

## Migration

Migration name: `20260729053000_phase_2_complaint_import_data_model`

The migration creates the normalized schema from an empty SQLite database. A Vitest integration test applies migrations to a temporary SQLite database with `prisma migrate deploy`.

## Constraints And Indexes

- Unique source identity: `Complaint.externalId`
- Unique row position: `ImportBatchRow.importBatchId + rowNumber`
- Classification uniqueness per category: `Classification.categoryId + nameAr`
- Category uniqueness: `Category.nameAr`
- Operational indexes are present for complaint status, due date, created date, soft delete, source reference, import hash/status/date, row batch/match references, status history, and audit entity lookup.

## Duplicate Policy

`ComplaintIdentityService` implements the matching order:

1. Normalized `externalId`.
2. Normalized `sourceReference` plus the UTC calendar date derived from `complaintDate`.
3. Stable composite fingerprint using the UTC calendar date derived from `complaintDate`, source reference, region, facility, department, and subject.

It never merges on complainant name, phone number, identifier, or complaint text alone.

## Services

- `src/server/complaints/complaint-service.ts`: creation, status changes, soft delete, optimistic concurrency with `expectedVersion`, status history, audit.
- `src/server/complaints/identity-service.ts`: duplicate identity and fingerprint policy.
- `src/server/imports/import-batch-service.ts`: batch creation, status transition guards, confirmation/rollback rules, row counters.
- `src/server/audit/audit-log-service.ts`: append-only audit log writes.

## Seed Results

The seed creates:

- 2 categories.
- 3 classifications.
- 4 synthetic complaints: open, closed, late, and within SLA.
- 2 import batches: confirmed and ready for confirmation.
- 6 import rows covering new, update, duplicate, and reject actions.
- 1 synthetic monthly report template for the current UI shape.
- Complaint status history.
- Audit logs.

No real personal data is used.

## API Compatibility

- Dashboard and analytics read the new `Complaint` model and exclude soft-deleted complaints.
- Complaint list returns compatibility fields needed by the current UI.
- Filters derive region, department, facility, channels, categories, and classifications from the new model.
- Import history reads Phase 2 batches without user relations.
- Import approval returns `501 NOT_IMPLEMENTED` instead of fake success.
- AI approval returns `501 AI_NOT_CONFIGURED`; AI execution remains outside scope.
- Complaint list query inputs validate `page`, `pageSize`, `sortBy`, and `sortOrder`; `pageSize` is capped at 100 and sort fields use an allowlist.
- Complaint list responses omit complainant name, identifier, and phone fields because the routes are not authenticated.
- Dashboard trend data applies the same non-time request filters as the KPI query and intersects request `from/to` with the last 30 days.
- Import history exposes `rejectionReason` only for failed or rolled-back batches, and legacy approved fields only for confirmed batches.

## Verification Results

- `npm ci`: passed.
- `DATABASE_URL="file:./dev.db" npm run db:validate`: passed.
- `DATABASE_URL="file:./dev.db" npm run db:generate`: passed.
- `DATABASE_URL="file:./dev.db" npx prisma migrate reset --force`: blocked by Prisma's AI-agent dangerous-action guard before execution.
- `DATABASE_URL="file:./dev.db" npx prisma migrate deploy`: passed, no pending migrations after applying the Phase 2 migration.
- `DATABASE_URL="file:./dev.db" npm run db:seed`: passed.
- Temporary SQLite `prisma migrate deploy` + `npm run db:seed`: passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: passed, 83 tests.
- `DATABASE_URL="file:./dev.db" npm run build`: passed outside the sandbox due to Turbopack process/port requirements.
- `npm run audit:runtime`: passed, 0 vulnerabilities.
- `npm audit --audit-level=high`: fails only for documented development tooling chains through `brace-expansion`/`minimatch`.
- `git diff --check`: passed.

Coverage includes complaint creation, unique external IDs, soft delete, version increments, status history, import batch transition guards, row uniqueness and JSON persistence, duplicate detection, route compatibility, and temporary-database migration deployment.

## Migration Policy

The prototype had no prior migration baseline. Existing local prototype data is synthetic and can be recreated with seed. No production data migration is claimed.

## Risks

- SQLite remains local prototype storage only.
- `prisma migrate reset --force` is blocked by Prisma's AI-agent dangerous-action guard unless the user provides explicit consent at runtime.
- Full Excel parsing, validation UI integration, transactional confirmation, and rollback execution remain for later phases.
- Authentication and authorization are still absent by architectural decision for this single-user phase.

## Excluded

- Login, roles, permissions, scopes, and multi-user identity.
- Actual Excel upload and parser.
- Transactional import confirmation execution.
- Report exports or scheduling.
- Governed AI execution or prompt workflows.

## Phase 3 Readiness

Phase 3 can build the Excel import engine on top of persisted `ImportBatch` and `ImportBatchRow`, using the centralized duplicate policy and domain services to validate, preview, and eventually confirm rows transactionally.
