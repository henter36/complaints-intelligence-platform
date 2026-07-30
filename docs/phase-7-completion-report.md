# Phase 7 — Reports, Exports, and Scheduling: Completion Report

## What Was Implemented

- A central report engine (`src/server/reports/`) covering six governed report types:
  `EXECUTIVE_SUMMARY`, `DEPARTMENT_PERFORMANCE`, `REGION_FACILITY_PERFORMANCE`,
  `CLASSIFICATION_ANALYSIS`, `COMPLAINT_DETAIL`, `OVERDUE_COMPLAINTS`.
- Zod request contract with period/range/column/title validation (`report-definition-service.ts`).
- Data parity with Dashboard/Analytics/Explorer: every report calls `getComplaintKpis` and/or
  `listComplaints` directly rather than recomputing any rate or status bucket.
- PDF export (`pdfkit` + a bundled full-coverage Amiri TTF font, RTL, page numbers, Riyadh-time
  stamp, local logo) and XLSX export (`exceljs`, RTL views, frozen headers, autofilter,
  formula-injection-safe, no macros/external links).
- Report preview (no artifact created, PII-free, row-truncation warnings).
- `ReportTemplate` (save/run/edit/disable, `reportType` locked after first run),
  `ReportSchedule` (daily/weekly/monthly, Asia/Riyadh, idempotent, contention-safe),
  `ReportRun`, and `ReportArtifact` persistence.
- Local artifact storage outside `public/` with random filenames, sha256, and a protected
  download endpoint that never exposes the storage key.
- `POST /api/internal/reports/run-due`, protected by a constant-time-compared
  `INTERNAL_SCHEDULER_SECRET` independent of the session cookie, plus the
  `npm run reports:run-due` script meant to be invoked by an OS-level cron.
- `npm run reports:cleanup` (`--dry-run` supported) enforcing the 90-day retention policy.
- A real Reports Center UI (create/preview/export, templates, schedules, run history) replacing
  the fully client-side, mock-data prototype.
- 86 new automated tests across 12 new test files (see below), plus one pre-existing test
  updated for the new `ReportTemplate` schema shape.

## Migration

`prisma/migrations/20260730070000_phase_7_reports_exports_scheduling/` — adds
`ReportType`, `ReportFormat`, `ReportRunStatus`, `ReportFrequency` enums; restructures
`ReportTemplate` (`reportType`/`filters`/`options`/`isActive`/`lastRunAt` replacing the old
placeholder `type`/`config` columns); adds `ReportSchedule`, `ReportRun`, `ReportArtifact`
with indexes on `ReportTemplate.isActive`/`reportType`, `ReportSchedule.isEnabled`/`nextRunAt`/
`reportTemplateId`, `ReportRun.status`/`createdAt`/`reportTemplateId`/(unique)`idempotencyKey`,
`ReportArtifact.reportRunId`/`expiresAt`/`deletedAt`. Generated via `prisma migrate diff`
between the pre-Phase-7 schema and the new one (schema-to-schema diffing, no live database
required to author it), then verified end-to-end: `prisma migrate deploy` on a fresh `dev.db`
applies all five migrations (Phase 2 through Phase 7) cleanly, and `npm run db:seed` succeeds
against the result.

## New APIs

```
GET  /api/reports/definitions
POST /api/reports/preview
POST /api/reports/run
GET  /api/reports/runs
GET  /api/reports/artifacts/{id}/download
GET  /api/reports/templates
POST /api/reports/templates
GET|PATCH|DELETE /api/reports/templates/{id}
POST /api/reports/templates/{id}/run
GET  /api/reports/schedules
POST /api/reports/schedules
PATCH|DELETE /api/reports/schedules/{id}
POST /api/internal/reports/run-due   (INTERNAL_SCHEDULER_SECRET, not session-based)
```

All session-protected routes use the existing `requireAdminApiSession` (auth + same-origin
CSRF check) / `mapAuthError` pattern; none introduce a new auth mechanism.

## Libraries Selected

| Library | Version | License | Purpose | Why |
|---|---|---|---|---|
| `pdfkit` | 0.19.1 | MIT | PDF generation | Actively maintained (last publish 2026-06), pure Node, no headless browser/network dependency, `fontkit`-based Arabic shaping verified visually |
| `fontkit` | 2.0.4 (via pdfkit) | MIT | Font parsing/shaping | Implements Arabic letter-joining and RTL glyph ordering |
| `exceljs` | 4.4.0 | MIT | XLSX generation | Actively maintained, avoids the `xlsx`/SheetJS package's long-standing unpatched advisories |
| Amiri font | n/a (bundled TTF) | SIL OFL 1.1 | Arabic/Latin typeface | Full Unicode coverage in one file (digits + Arabic), unlike the subsetted `@fontsource/amiri` web-font package which produced missing-glyph boxes for numbers when embedded standalone in a PDF |

`@types/pdfkit@0.17.6` added as a dev dependency for TypeScript support.

**Dependency overrides required** (`package.json#overrides`) to keep `npm run
audit:runtime` at 0 high-severity findings: `exceljs.archiver` bumped to `^8.0.0` (the
`exceljs`-pinned `archiver@^5` pulled a vulnerable `archiver-utils`/`glob`/`minimatch`/
`brace-expansion` chain), `exceljs.uuid` to `^11.1.0`, and
`exceljs.unzipper.fstream.rimraf` to `^6.1.3` (the deprecated `fstream`→`rimraf@2.7.1`
dependency pulled the same vulnerable chain again; `unzipper`/`fstream` are only used by
`exceljs` for reading `.xlsx` templates, a code path this project never exercises, so
replacing their transitive `rimraf` with an API-incompatible-but-unused newer major is a safe,
standard mitigation). `npm audit --omit=dev --audit-level=high` reports **0 vulnerabilities**
with the final lockfile. `npm audit fix --force` was never used blindly — every override was
chosen and verified individually.

## Data Parity

`report-data-service.test.ts` asserts, for real complaint fixtures, that
`buildReportData(EXECUTIVE_SUMMARY).kpis` is `toEqual()` the object `getComplaintKpis()`
returns directly for the same filters, and that `DEPARTMENT_PERFORMANCE`'s group table is
`toEqual()` `distributions.byDepartment` from the same KPI call — i.e. the report layer is
provably a thin projection over the existing KPI/query services, not an independent
computation that could drift from the Dashboard/Analytics numbers over time.

## PDF / XLSX Test Results

- PDF: valid `%PDF-` buffer produced, Arabic text renders with correct letter-joining and RTL
  ordering (visually verified via `qlmanage` thumbnails during development), multi-page output
  confirmed for a 120-row table, document `/Title` present, chart/table failures degrade to a
  warning rather than failing the whole document, empty tables render a "no data" message
  instead of throwing.
- XLSX: workbook round-trips through `exceljs` with the expected sheet names, every sheet has
  `rightToLeft: true` + a frozen header row (`ySplit: 1`) + an `autoFilter`, numeric/percent/date
  cells are stored with real types (not strings), `=`/`+`/`-`/`@`-prefixed values round-trip as
  literal `'`-prefixed text (never as an Excel formula object), no `vbaProject.bin` or
  `externalLink` parts are present in the archive, and truncated tables carry a visible note.

## Performance Results (10,000 synthetic complaints)

Measured in `report-performance.test.ts` (mocked DB layer, so this isolates the report engine's
own aggregation/render cost from SQLite I/O):

| Operation | Time | Notes |
|---|---|---|
| `getComplaintKpis` over 10,000 complaints | ~640–700ms | Same call the Dashboard makes |
| `buildReportData` — `EXECUTIVE_SUMMARY` | ~630–650ms | KPIs + distributions + trend |
| `renderReportPdf` — `EXECUTIVE_SUMMARY` | ~7.5–8.0s | Dominated by embedding/subsetting two ~400KB full-coverage Amiri TTFs into a fresh `PDFDocument`, not by the (small) report content — see "Known Risks" |
| `buildReportData` — `COMPLAINT_DETAIL` (10,000 rows) | ~660–670ms | |
| `renderReportXlsx` — `COMPLAINT_DETAIL` (10,000 rows) | ~1.0–1.1s | |

## File Sizes (10,000-row / synthetic test data)

- Executive summary PDF: ~1.29 MB.
- Complaint-detail XLSX (10,000 rows, 4 sheets): ~577 KB.

Both are well under `REPORT_MAX_FILE_SIZE_MB` (25 MB) and comfortably downloadable.

## Audit Logging

All 13 specified actions are written through the existing shared `writeAuditLog()` helper with
bounded metadata (`reportRunId`/`templateId`/`reportType`/`format`/`rowCount`/`actor` only —
never report content, full free-text filters, or a `storageKey`).

## Test Suite

**309 tests passing across 31 test files** (`npm test`), including 12 new Phase 7 files:

| File | Tests | Covers |
|---|---|---|
| `report-definition-service.test.ts` | 14 | Contract validation: valid/invalid types, range limits, HTML-in-title rejection, column allowlist, maxRows capping |
| `report-data-service.test.ts` | 6 | KPI/group-table parity, row-limit rejection (run) vs. truncation warning (preview), no-PII columns, forced `isLate` |
| `report-pdf-service.test.ts` | 6 | Valid PDF output, title embedding, multi-page, size bound, empty-table handling, warning passthrough |
| `report-xlsx-service.test.ts` | 10 | Valid workbook, RTL/frozen/autofilter, formula-injection neutralization, numeric/date types, no macros/external links, no PII, truncation note |
| `report-storage.test.ts` | 7 | Random storage keys, sha256, file-size limit, round-trip read, path-traversal containment, safe no-op delete |
| `report-template-service.test.ts` | 6 | Period re-anchoring, HTML-in-name rejection, `reportType` lock after first run, not-found handling |
| `report-schedule-service.test.ts` | 10 | `computeNextRunAt` for daily/weekly/monthly incl. last-day-of-month, already-running skip, contended-claim skip |
| `report-export-service.test.ts` | 3 | Full run→artifact→COMPLETED success path incl. retention-day math, FAILED path with partial-artifact cleanup and stack-trace-free error, format-unsupported rejection |
| `report-cleanup-service.test.ts` | 6 | 90-day retention query bound, real deletion + audit log, dry-run (no deletion/audit), missing-file safety, never touches `ReportRun` |
| `report-performance.test.ts` | 2 | 10,000-complaint timing/size bounds (see above) |
| `phase-7-routes.test.ts` (API) | 11 | 401 without session, 422 unsupported format, 404 for deleted/expired/missing artifacts without leaking the storage key, scheduler-secret 401/503/success, template type-lock via `PATCH` |
| `reports-center.test.tsx` (UI) | 5 | Report type rendering, settings reveal, preview rendering, Templates/History empty states |

## Build / Verification Results

```
npm ci                                        ✅
DATABASE_URL="file:./dev.db" npm run db:validate    ✅
DATABASE_URL="file:./dev.db" npm run db:generate    ✅
DATABASE_URL="file:./dev.db" npx prisma migrate deploy   ✅ (5 migrations applied to a fresh dev.db)
DATABASE_URL="file:./dev.db" npm run db:seed        ✅
npm run typecheck                             ✅ (0 errors)
npm run lint                                  ✅ (0 errors)
npm test                                      ✅ (309/309 passing, 31 files)
DATABASE_URL="file:./dev.db" npm run build    ✅
npm run audit:runtime                         ✅ (0 high-severity vulnerabilities)
```

The full golden path was also exercised against a real running `npm run dev` instance (not just mocked unit tests): login → create/preview an executive-summary report → export PDF → export XLSX → save template → run template (both formats) → create a daily schedule → force it due and call `POST /api/internal/reports/run-due` → confirm idempotency (an immediate second call returns `no_due_schedule`, not a duplicate run) → download the PDF artifact → mark an artifact expired and run `npm run reports:cleanup` (dry-run, then real) → confirm the download now 404s and `REPORT_ARTIFACT_DELETED` was audit-logged. This surfaced three real bugs that the unit/integration test suite (which calls route handlers and services directly, bypassing Next.js's request pipeline) could not have caught:

1. **`pdfkit`/`fontkit` broke under Next.js's request pipeline** (`ENOENT ... Helvetica.afm`) because both packages read their own data files relative to their on-disk install location, and Next.js's default bundling rewrites that resolution. Fixed by adding `serverExternalPackages: ["pdfkit", "fontkit"]` to `next.config.ts`, which tells Next.js to `require()` them unbundled at runtime instead.
2. **`POST /api/internal/reports/run-due` was unreachable without a session cookie** — `src/proxy.ts` (this project's request-level auth gate, checked before any route handler runs) rejects any `/api/*` path not on its public allowlist when the `cip_session` cookie is absent, and the internal endpoint wasn't on it. Since this endpoint is explicitly designed to authenticate via `INTERNAL_SCHEDULER_SECRET` instead of a session, `/api/internal/` was added to `proxy.ts`'s public-path prefixes — the route handler's own (stronger, constant-time-compared secret) check is what actually protects it.
3. **PDF tables with 11 columns could balloon to 20+ pages of near-empty output.** Long Arabic column labels/values wrapped across multiple lines inside narrow (~45pt) columns; because those `doc.text()` calls specified a `width` but no `height`, pdfkit's own line-wrapper was free to insert extra pages mid-cell whenever wrapped content ran past the remaining page height — independently of this file's own row-level pagination logic, and multiplying badly. Fixed by giving every table/KPI-card `doc.text()` call an explicit `height` plus `lineBreak: false, ellipsis: true`, so an overlong value is truncated with `…` on one line instead of wrapping and triggering pdfkit's own pagination. Confirmed fix: the same executive-summary report went from 26 pages to 4 pages, with all committed tests (including the multi-page and file-size tests, which exercise this same code path) re-verified green afterward.

## Known Risks

- **PDF generation latency** (~7-8s per document) is dominated by `fontkit` parsing/subsetting
  the full-coverage Amiri TTFs fresh for every `PDFDocument` instance. Acceptable for a
  single-user, on-demand "generate report" action (the UI shows a loading state during export),
  but worth revisiting — e.g. a persistent font-subset cache across requests within the same
  Node process — if report volume or concurrency grows in a later phase.
- No full Unicode BiDi (UAX#9) reordering in the PDF renderer; acceptable for this system's
  actual content shape (right-aligned Arabic labels with embedded Western digits/percentages),
  verified visually, but a genuinely mixed-direction paragraph (e.g. an English sentence
  embedded mid-Arabic-sentence) could render in a visually unexpected order.
- `ReportTemplate.filters`/`options` are stored as unvalidated-at-rest JSON; validation happens
  on every write (`createReportTemplate`/`updateReportTemplate` call `parseReportRequest`) and
  on every run, but a manual database edit could bypass it — acceptable for a single-admin
  system with no external write path to the database.
- The internal scheduler is a single-shot "claim one due schedule per call" design; achieving
  higher throughput (many schedules due in the same minute) requires calling
  `POST /api/internal/reports/run-due` repeatedly (e.g. every minute) from cron rather than
  relying on a single invocation to drain a backlog — this is a deliberate simplicity trade-off
  for a single-user, low-volume system, not an oversight.

## Explicitly Excluded (by design, per the Phase 7 brief)

Email delivery, automatic report sending, AI summaries or a natural-language report builder, a
user-facing SQL editor, multiple users/roles/permissions, external/cloud storage, an external
queue, a cloud scheduler, and any database engine change. No AI provider was called; no email
was sent.

## Phase 8 Readiness

Phase 7 leaves the platform with: a normalized, migrated schema; single-user auth; a validated
Excel import pipeline with transactional confirmation/rollback; a central complaint query/KPI
engine; and now a full reporting/export/scheduling layer that is provably consistent with every
other screen's numbers. The only remaining planned phase is **Governed AI** (Phase 8 in
`docs/roadmap.md`): provider abstraction, prompt/version governance, PII controls, human
approval, traceability, and safe fallbacks. No architectural blockers were introduced in this
phase that would complicate that work — the report engine does not touch AI fields, and the
`OPENAI_API_KEY` placeholder remains exactly as before.

**Recommendation for Phase 8**: scope AI strictly to the existing `aiClassification`/
`aiSummary`/`aiSentiment`/`aiSeverityScore`/`aiReasoning`/`aiConfidence` fields already present
on `Complaint` (populated today only by CSV import, never generated) — implement a provider
abstraction behind a feature flag, require human approval before any AI-derived field is
persisted or surfaced, keep the same single-user/no-roles constraint, and reuse this phase's
audit-logging and Zod-contract-at-the-boundary conventions rather than introducing new ones.
