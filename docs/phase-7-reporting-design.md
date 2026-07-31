# Phase 7 — Reports, Exports, and Scheduling: Design

## Goal

Turn the Reports Center from a client-only, mock-data prototype into a real, single-user
reporting system: choose a governed report type and period/filters, preview it, export to
PDF/XLSX, save it as a reusable template, schedule it to run automatically, browse run
history, and download or clean up generated files — all with numbers that are guaranteed to
match the Dashboard, Analytics, and Complaint Explorer screens for the same filters.

No email delivery, no external/cloud scheduler, no AI, and no free-form report builder are
in scope for this phase (see "Explicitly Out Of Scope" below).

## Starting Point (Phase 6 Audit)

- `src/components/screens/reports-center.tsx` was a ~2,900-line, fully client-side prototype.
  It fetched raw complaint pages itself (`src/lib/report-complaints.ts`) and recomputed
  volume/performance metrics *in the browser* using stale field names (`regionId`,
  `locationId`, lowercase status strings like `"closed"`/`"rejected"`) that no longer matched
  the Phase 6 schema (`region`/`department`/`facility` are plain strings; status values are
  `NEW`/`OPEN`/`IN_PROGRESS`/`AWAITING_RESPONSE`/`RESOLVED`/`CLOSED`/`CANCELLED`). "Export" and
  "Schedule" were `setTimeout`-based fakes; templates/schedules only lived in React state.
  Both the component and its helper were deleted; the helper's only test
  (`reports-center.test.tsx`, despite its name, tested `fetchAllComplaintsForReport`, not the
  UI) was deleted with it.
- `GET /api/complaints/export` already existed and established the patterns this phase reuses
  verbatim: `requireAdminApiSession` (auth + same-origin CSRF check) →
  `ComplaintQueryService.listComplaints` → CSV with a `﻿` BOM and per-cell formula-injection
  guarding (`/^[=+\-@]/` → prepend `'`) → `writeAuditLog`.
- `ComplaintQueryService` (`src/server/complaints/complaint-query-service.ts`) and
  `ComplaintKpiService` (`src/server/complaints/complaint-kpi-service.ts`) already centralize
  every filter and metric formula (soft-delete exclusion, status buckets, "late"/"on-time"
  definitions from `complaint-timing.ts`, previous-period comparison, per-group breakdowns).
  These became the report engine's only source of numbers — nothing in Phase 7 recomputes a
  rate or a status bucket independently.
- `ReportTemplate` existed only as a placeholder model (`type: String`, `config: Json`) with no
  runs, schedules, or artifacts.
- No PDF/XLSX library was installed. No local storage layer existed for anything other than
  import uploads (`src/server/imports/file-storage.ts`, which the new `report-storage.ts`
  mirrors: random UUID filenames, `path.basename()` + prefix-check traversal guard, sha256,
  `0o700`/`0o600` permissions).

## Report Types

Defined centrally in `src/server/reports/report-definition-service.ts`
(`REPORT_DEFINITIONS`), each with `title`, `description`, `supportedFilters`, `sections`,
`defaultColumns`, `maxRows`, `supportsPdf`, `supportsXlsx`:

| Type | maxRows | PDF | XLSX | Notes |
|---|---|---|---|---|
| `EXECUTIVE_SUMMARY` | 500 | ✓ | ✓ | KPIs, previous-period comparison, top regions/departments/classifications, channel mix, top overdue complaints |
| `DEPARTMENT_PERFORMANCE` | 1,000 | ✓ | ✓ | Per-department breakdown via `distributions.byDepartment` |
| `REGION_FACILITY_PERFORMANCE` | 1,000 | ✓ | ✓ | Per-region *and* per-facility breakdowns |
| `CLASSIFICATION_ANALYSIS` | 1,000 | ✓ | ✓ | Per-classification breakdown + trend vs. the previous period of equal length |
| `COMPLAINT_DETAIL` | 10,000 | ✗ | ✓ | Row-level table, no PII columns; PDF is disabled because 10k rows don't paginate usefully in print layout |
| `OVERDUE_COMPLAINTS` | 5,000 | ✓ | ✓ | Forces `isLate=true` regardless of caller filters |

A free-form report builder, user-authored SQL, and arbitrary custom columns beyond each
report's `defaultColumns` allowlist are intentionally not supported.

## Request Contract

`src/server/reports/report-definition-service.ts` exports a Zod contract:

```json
{
  "type": "EXECUTIVE_SUMMARY",
  "title": "التقرير التنفيذي للشكاوى",
  "filters": { "from": "2026-07-01", "to": "2026-07-31", "region": null, "department": null, "status": null },
  "options": { "includeComparison": true, "includeCharts": true, "includeDetailedRows": true, "maxRows": 5000 }
}
```

Rules enforced by `parseReportRequest`:

- `filters.from`/`filters.to` are required (`requiresPeriod: true` for every current report
  type) and `from <= to`.
- The period cannot exceed `REPORT_MAX_RANGE_DAYS` (366 days).
- `type` must be one of the six known enum values (unknown types are rejected by Zod).
- `title`, if provided, is capped at 200 characters and rejected outright if it contains `<`
  or `>` (blocks `<script>`/HTML injection at the contract boundary, before any renderer sees it).
- `options.maxRows` is schema-capped at 10,000 and then further clamped to that report type's
  own `maxRows` ceiling — a caller can never request more rows than the report type allows.
- `options.columns`, when present (used by `COMPLAINT_DETAIL`), must be a subset of that
  report's `defaultColumns`; anything else is rejected.
- The whole payload is parsed with Zod `.strict()` — unknown top-level fields are rejected.

## Central Report Engine

```
report-definition-service.ts   → report types, Zod contract, buildComplaintQueryParams()
report-data-service.ts         → buildReportData(request, "preview"|"run", now) => ReportData
report-pdf-service.ts          → renderReportPdf(ReportData) => { buffer, warnings }
report-xlsx-service.ts         → renderReportXlsx(ReportData) => { buffer, warnings }
report-export-service.ts       → runReport(...) orchestrates data → render → store → ReportRun/ReportArtifact
report-template-service.ts     → ReportTemplate CRUD + resolveTemplateRunFilters() + runReportTemplate()
report-schedule-service.ts     → computeNextRunAt(), runDueSchedule() (claim-then-run, idempotent)
report-cleanup-service.ts      → runReportsCleanup() (90-day retention)
report-storage.ts              → local artifact storage (random keys, traversal-safe, sha256)
report-time.ts                 → Asia/Riyadh-aware date/timezone helpers (no hardcoded UTC+3 offset)
```

**Data parity.** `report-data-service.ts` never recomputes a metric. Every report type calls
`getComplaintKpis(params, now)` for KPIs/distributions/trend and/or
`listComplaints(params, { limit })` for row-level tables — the same two functions `GET
/api/dashboard`, `GET /api/analytics`, and the Complaint Explorer already call. The only two
additions to the shared KPI service were **additive**, not new formulas:
`ComplaintGroupMetrics` gained `highPriorityOpen`/`unclassified` fields (values it already
computed internally per group, just not returned before), and `getPreviousPeriodRange()` was
extracted from the KPI service's existing previous-period math so
`CLASSIFICATION_ANALYSIS`'s trend column reuses it instead of re-deriving the date shift.
`report-data-service.test.ts` asserts `report.kpis` from `buildReportData(...)` is
`toEqual()` the same object `getComplaintKpis(...)` returns directly for identical filters.

**Row limits.** `mode: "preview"` caps table rows at 100 and returns a `warnings[]` message
when truncated (never throws). `mode: "run"` (used for exports) throws
`ReportRowLimitExceededError` when the *total matched count* exceeds the report type's
`maxRows` — the API layer maps this to `422`.

## PDF

**Library**: `pdfkit@0.19.1` (MIT, actively maintained, pulls in `fontkit@2.0.4` for font
shaping) — pure Node.js, no headless browser, no network access at render time.

**Font**: Amiri (SIL Open Font License 1.1), obtained as the full, non-subsetted
`Amiri-Regular.ttf`/`Amiri-Bold.ttf` from the `google/fonts` OFL mirror and bundled locally
under `src/server/reports/assets/fonts/` (with `OFL-LICENSE.txt`). This was a deliberate
choice over `@fontsource/amiri`: that npm package ships **unicode-range-split** web font
subsets (`amiri-arabic-*.woff` has Arabic letters only, `amiri-latin-*.woff` has digits/Latin
only) meant for browsers that merge subsets via CSS `@font-face` — embedded standalone in a
PDF, the Arabic-only subset renders Western digits and `%`/`-`/`(`/`)` as missing-glyph boxes,
which is unacceptable for a report full of dates and percentages. The full TTF has every glyph
in one file. `fontkit`'s Arabic shaper handles letter joining and basic RTL glyph ordering
automatically once the font is registered; this was verified visually (rendered to PNG via
`qlmanage`) before relying on it in tests. Full mixed-script Unicode BiDi reordering (UAX#9)
is not implemented — acceptable for right-aligned Arabic labels with embedded Western numbers,
which is the actual content shape of every report in this system.

**Layout** (`report-pdf-service.ts`): A4, `bufferPages: true` so a second pass can stamp
`"<title> — تم إنشاؤه بواسطة نظام ذكاء الشكاوى — صفحة X من Y"` centered at the bottom of every
page once the true page count is known. Header block: local `public/logo.svg` rasterized to
PNG via `sharp` (already a project dependency) at render time, title, report description,
period, **Riyadh-time** generation timestamp (`formatRiyadhDateTime`), applied filters.
Tables are drawn with manual pagination (`ensureSpace()` checks remaining vertical space before
each row and calls `doc.addPage()` + re-draws the header row when needed) and manual
right-to-left column ordering (first logical column is placed at the rightmost x-position,
since pdfkit does not do this automatically for tables the way it does for RTL text runs). Every
cell/label `doc.text()` call passes an explicit `height` plus `lineBreak: false, ellipsis: true`
— without a bounded height, pdfkit's own line-wrapper is free to insert extra pages mid-cell
whenever a long value wraps past the remaining page height, which was observed in practice
inflating an 11-column breakdown table to 20+ near-empty pages before this was added; an
overlong value is now truncated with `…` on one line instead (the full, untruncated value is
always still available in the XLSX export of the same report). A render-time chart or table
failure is caught per-section and downgrades to a `warnings[]` entry rather than failing the
whole document. No PII columns are ever passed to the PDF layer (the data service excludes them
at the source).

**Next.js integration**: `pdfkit`/`fontkit` read their own data files (standard font metrics,
etc.) relative to their on-disk install location; Next.js's default webpack/Turbopack bundling
for API routes rewrites that resolution and breaks it (`ENOENT ... Helvetica.afm`). `next.config.ts`
sets `serverExternalPackages: ["pdfkit", "fontkit"]` so both run as plain, un-bundled Node
`require()`s at runtime — this was only caught by testing against a real `next dev` server, not
by the (bundler-bypassing) unit test suite, and is exactly the kind of thing that class of test
cannot catch.

## XLSX

**Library**: `exceljs@4.4.0` (MIT, actively maintained) instead of the `xlsx` (SheetJS)
package, which has long-documented unpatched prototype-pollution/ReDoS advisories in the
version range compatible with this project. `npm run audit:runtime` reports **0 high-severity
vulnerabilities** with the final dependency set (see "Dependency Overrides" below).

Per report: a "الملخص" (summary) sheet, a "المؤشرات" (KPIs, current/previous/% change columns),
and one sheet per table section. Every sheet: `views: [{ rightToLeft: true, state: "frozen",
ySplit: 1 }]` (frozen header row, and because the sheet view is RTL, exceljs's natural
left-to-right column order already renders as right-to-left on screen — no manual column
reversal needed, unlike the PDF), `autoFilter` over the header row, real `Date` objects with
`numFmt: "yyyy-mm-dd"` for date columns, real `number` values with percent/number `numFmt` for
metrics (never formatted-string numbers). No macros (exceljs writes `.xlsx`, never `.xlsm`),
no external links, no formulas beyond what exceljs itself needs internally.

**Formula-injection protection**: any free-text cell value starting with `=`, `+`, `-`, or `@`
is prefixed with `'` (`sanitizeText()`), the same convention the existing CSV export already
uses — verified by round-tripping a generated workbook through `exceljs` and asserting the
literal `'=SUM(...)` string survives, and that no cell is ever assigned as `{ formula: ... }`.

## Storage And Artifacts

`report-storage.ts` (mirrors `src/server/imports/file-storage.ts`): files live under
`REPORT_STORAGE_PATH` (default `./storage/reports`, outside `public/`, already covered by the
generic `storage/` `.gitignore` entry), named `${randomUUID()}.pdf`/`.xlsx` — never the report
title or any user input. `path.basename()` is applied before every read/delete, and the
resolved path is checked to still start with the resolved storage root — the same
belt-and-suspenders traversal guard the import storage layer uses. `sha256` is computed and
stored on `ReportArtifact`; `REPORT_MAX_FILE_SIZE_MB` (default 25) is enforced before writing.
Metadata (`ReportArtifact` row: format, fileName, mimeType, fileSize, sha256, `expiresAt`) is
the only thing ever returned to API clients — `storageKey` is never serialized in a response.

`GET /api/reports/artifacts/{id}/download` requires a session, rejects (`404`, not a
distinguishing error) artifacts that are `deletedAt`-set or past `expiresAt`, and writes
`REPORT_ARTIFACT_DOWNLOADED` to the audit log.

## Templates And Scheduling

`ReportTemplate` stores a concrete `filters` (including `from`/`to`) and `options` JSON blob.
Because a schedule must produce a *fresh* period on every run rather than replaying the same
frozen dates forever, `resolveTemplateRunFilters()` re-anchors the template's stored date span
to end "today" in Riyadh time while preserving its length in days (a saved "last 30 days"
template always reports the latest 30 days when run from a schedule or "Run now"). Non-time
filters (region/department/etc.) pass through unchanged. `reportType` is locked once a template
has at least one `ReportRun` (`PATCH` returns `409 REPORT_TEMPLATE_TYPE_LOCKED`); it can be
changed freely before the first run.

`ReportSchedule.computeNextRunAt()` (`report-schedule-service.ts`) works entirely off
`report-time.ts`'s generic, non-hardcoded timezone helpers (`getZonedDateParts`,
`zonedWallTimeToUtc` — both derive the UTC offset live via `Intl.DateTimeFormat`, they do not
assume a fixed `+03:00`, even though that happens to always be true for `Asia/Riyadh` since
Saudi Arabia does not observe DST):

- **DAILY**: next occurrence of `timeOfDay` today, or tomorrow if that time already passed.
- **WEEKLY**: next occurrence of `dayOfWeek` (0=Sunday..6=Saturday) at `timeOfDay`.
- **MONTHLY**: `dayOfMonth` in the current month at `timeOfDay`; if that day does not exist in
  a given month (e.g. requesting the 31st in February), **the last day of that month is used
  instead** — this is the documented policy (rather than skipping the month or rejecting the
  schedule).

`POST /api/internal/reports/run-due` (`report-schedule-service.ts`'s `runDueSchedule()`):

1. Finds at most one schedule where `isEnabled` and `nextRunAt <= now` (ordered by `nextRunAt`).
2. Skips it if a `ReportRun` for the same template is already `RUNNING` (prevents overlap).
3. Atomically claims it: `updateMany({ where: { id, nextRunAt: <value just read> }, data: {
   nextRunAt: <next occurrence> } })` — if the conditional update affects 0 rows, another
   process already claimed this slot, so this call is a safe no-op. This is the whole
   concurrency story; no separate lock table is needed because the claim and the "what's the
   next slot" advance happen in the same conditional write.
4. Runs the template with `idempotencyKey = "${scheduleId}:${scheduledForISO}"`, which is a
   `@unique` column on `ReportRun` — even in the (already-prevented) event of a race, the
   database itself would reject a second row for the same scheduled slot.
5. Advances `nextRunAt` regardless of whether the run succeeds or fails — a failed scheduled
   run is recorded (`REPORT_RUN_FAILED`, `REPORT_SCHEDULE_EXECUTED` with `failed: true`) and
   is not retried automatically before its next natural slot, matching "record the failure,
   don't auto-retry without bound."

The endpoint is protected by `INTERNAL_SCHEDULER_SECRET` compared with
`crypto.timingSafeEqual` (a same-length dummy comparison runs even when the lengths differ, so
timing does not leak the secret's length either) sent via the `x-scheduler-secret` header —
**not** the admin session cookie, so a local OS cron job never needs interactive credentials.
Because the project's request-level auth gate (`src/proxy.ts`) rejects any `/api/*` path
without a session cookie by default, `/api/internal/` was explicitly added to its public-path
allowlist — the route handler's own secret check, not the proxy, is what actually protects this
endpoint. `npm run reports:run-due` is a thin script that POSTs to this endpoint once
(`INTERNAL_SCHEDULER_SECRET` and optional `APP_BASE_URL` must be set in its environment); it is
meant to be invoked by an OS-level cron, not a Next.js-internal timer.

## Retention And Cleanup

`npm run reports:cleanup` (`--dry-run` supported) calls `runReportsCleanup()`
(`report-cleanup-service.ts`): selects `ReportArtifact` rows where `deletedAt IS NULL AND
expiresAt < now`, deletes the on-disk file (best-effort — a missing file is not an error),
stamps `deletedAt`, and writes one `REPORT_ARTIFACT_DELETED` audit log entry per real deletion.
It never deletes a `ReportRun` or `AuditLog` row, and the query itself guarantees nothing is
ever removed before its `expiresAt`. Default retention is `REPORT_RETENTION_DAYS=90`.

## Privacy

- `COMPLAINT_DETAIL`'s column allowlist (`defaultColumns`) excludes `complainantName`,
  `complainantIdentifier`, and `complainantPhone` by construction — `ComplaintListItem` (from
  `ComplaintQueryService`) never even selects those columns from the database for this code
  path, so there is no PII to accidentally leak in the first place.
- No report ever logs its own content, full filter values with free-text search, or a
  `storageKey` to the audit log or console. Audit metadata is limited to
  `reportRunId`/`templateId`/`reportType`/`format`/`rowCount`/`actor`.
- Nothing in this phase calls any external service (no AI, no cloud storage, no PDF-conversion
  API) — PDF/XLSX generation is fully local and offline.

## Audit Actions

`REPORT_PREVIEWED`, `REPORT_RUN_STARTED`, `REPORT_RUN_COMPLETED`, `REPORT_RUN_FAILED`,
`REPORT_ARTIFACT_DOWNLOADED`, `REPORT_TEMPLATE_CREATED`, `REPORT_TEMPLATE_UPDATED`,
`REPORT_TEMPLATE_DISABLED`, `REPORT_SCHEDULE_CREATED`, `REPORT_SCHEDULE_UPDATED`,
`REPORT_SCHEDULE_DISABLED`, `REPORT_SCHEDULE_EXECUTED`, `REPORT_ARTIFACT_DELETED` — all written
through the existing shared `writeAuditLog()` helper, following this codebase's established
`SCREAMING_SNAKE_CASE` action-string convention (there is no enum of action strings anywhere
else in the codebase either; this phase does not introduce one).

## Explicitly Out Of Scope (this phase)

Email delivery, automatic report sending, AI summaries, a natural-language report builder, a
user-facing SQL editor, multiple users/roles/permissions, external/cloud storage, an external
queue, a cloud scheduler, database engine changes, and free-form HTML report templates. The
system remains single-user throughout.
