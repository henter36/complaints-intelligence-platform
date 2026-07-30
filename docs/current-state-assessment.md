# Current State Assessment

## What Works

- Next.js app shell with Arabic RTL layout and sidebar navigation.
- Dashboard API aggregates complaint volume, performance, trends, distributions, and alerts through the central Phase 6 KPI service.
- Complaints API lists complaints with central query validation, filters, pagination, deterministic sorting, soft-delete exclusion, and computed timing fields.
- Analytics API returns central KPI-backed count cross-tabs by classification/region/department, channel effectiveness, anomaly summaries, and distributions.
- Filters, categories/classifications, and import history endpoints exist.
- Prisma schema validates, a real Phase 2 migration exists, and synthetic seed data can populate a local SQLite database.
- Phase 2 domain services exist for complaint status history, duplicate identity, import batch transitions, row counters, and audit logging.
- Phase 3 single-user secure mode protects operational pages and APIs with one administrator credential, database-backed sessions, logout, password change, rate limiting, and security headers.
- Phase 4 import upload reads `.xlsx` files, validates OOXML/ZIP safety, stores private upload files, maps complaint columns, normalizes and validates rows, detects duplicates, persists `ImportBatchRow` preview data, and generates CSV error reports.
- Phase 5 import confirmation applies eligible preview batches transactionally, writes snapshots/status history/audit logs, and supports atomic rollback.
- Phase 6 adds complaint detail, manual update, status transition, central KPI, and safe CSV export APIs.
- TypeScript, ESLint, Vitest, and production build run successfully after Phase 1 changes.

## Partially Working

- Import Center now runs upload, validation, preview, and confirmation. Import Log supports rollback for confirmed batches.
- Reports Center is UI-oriented and not backed by production export/scheduling workflows.
- Classification management currently supports reading and creating categories/classifications. Update/delete operations, enterprise governance, and versioning are not implemented.
- AI Insights can aggregate previously stored AI fields, but there is no governed model execution.

## Stubbed Or Shape-Only

- `POST /api/ai/analyze` returns `501 AI_NOT_CONFIGURED`.
- `POST /api/ai/summary` returns `501 AI_NOT_CONFIGURED`.
- `POST /api/ai/approve` returns `501 AI_NOT_CONFIGURED`.
- Import confirmation is implemented through `POST /api/import/{batchId}/confirm`; `POST /api/import/approve` remains as a compatibility wrapper requiring `batchId`.

## Security And API Data Exposure

- Single-user authentication is implemented. Multi-user authorization, RBAC, roles, permissions, and scoped access are intentionally not implemented.
- Complaint list responses still do not return complainant name, identifier, or phone fields.
- Complaint detail responses are authenticated and mask identifier/phone before returning them.
- Complaint list pagination is validated, `pageSize` is capped at 100, and sorting uses an explicit allowlist rather than user-provided Prisma field names.
- Reports Center respects the public `pageSize` cap by reading complaint pages sequentially at 100 rows per request with deterministic sorting.
- Any screen that needs complainant PII should remain constrained to authenticated detail workflows in a later phase.
- Import upload/list/detail/error-report APIs are authenticated. Preview lists mask complainant identifier, phone, and name.
- Scoped data access is not implemented.
- Transactional import confirmation and rollback are implemented for the current single-user workflow. Snapshots are not exposed through public APIs.

## Missing

- Production database choice and production data migration strategy.
- Complete complaint domain model review.
- Enterprise identity provider integration.
- Role and scope enforcement.
- Exportable PDF/Excel reports and scheduled delivery.
- Governed AI provider abstraction, prompt/version audit, and human approval flow.

## Screens

- Dashboard: `src/components/screens/dashboard.tsx`
- Import Center: `src/components/screens/import-center.tsx`
- Complaints Explorer: `src/components/screens/complaints-explorer.tsx`
- Analytics: `src/components/screens/analytics.tsx`
- AI Analysis: `src/components/screens/ai-analysis.tsx`
- Reports Center: `src/components/screens/reports-center.tsx`
- Classifications Manager: `src/components/screens/classifications-manager.tsx`
- Import Log: `src/components/screens/import-log.tsx`

## API Routes

- `GET /api`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/auth/change-password`
- `GET /api/dashboard`
- `GET /api/analytics`
- `GET /api/complaints`
- `GET /api/complaints/export`
- `GET /api/complaints/{id}`
- `PATCH /api/complaints/{id}`
- `POST /api/complaints/{id}/status`
- `GET /api/filters`
- `GET|POST /api/classifications`
- `GET /api/import/history`
- `POST /api/import/upload`
- `GET /api/import/{batchId}`
- `GET /api/import/{batchId}/rows`
- `POST /api/import/{batchId}/mapping`
- `POST /api/import/{batchId}/reprocess`
- `GET /api/import/{batchId}/errors`
- `POST /api/import/{batchId}/confirm`
- `POST /api/import/{batchId}/rollback`
- `POST /api/import/approve` (compatibility wrapper that requires `batchId` in the request body and delegates confirmation to `/api/import/{batchId}/confirm`)
- `POST /api/ai/analyze` (disabled)
- `POST /api/ai/summary` (disabled)
- `GET /api/ai/insights`
- `POST /api/ai/approve`

## Risks

- SQLite is appropriate only for local prototype development.
- Phase 2 schema is normalized for local single-user use, but still needs production database validation.
- Full `npm audit --audit-level=high` still reports development-tooling high findings through `brace-expansion`/`minimatch` dependency chains.
- UI contains screens for future workflows that are not fully backed by production behavior.
- Single-user authentication protects operational API routes, but multi-user authorization is not present.

## Realistic Completion

Foundation readiness is approximately 84%. The app now has a reliable build/test baseline, a normalized complaint/import data model, single-user authentication, a real Excel validation preview pipeline, transactional confirmation/rollback, and central complaint/KPI query APIs. Report and governed AI workflows remain incomplete.

## Technical Debt

- Replace SQLite with the selected production database and migrations.
- Split API aggregation logic into tested services.
- Remove or gate UI actions for unimplemented workflows.
- Add scoped authorization only if the product moves beyond single-user operation.
- Address remaining dev dependency audit exception when compatible releases are available.
