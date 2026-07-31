# Roadmap

## 1. Foundation Hardening - Completed

Establish npm, TypeScript, lint, tests, production build, CI, Prisma validation, security audit visibility, and honest documentation.

## 2. Data Model - Completed

Normalize complaint entities, import batches, batch rows, classifications, SLA dates, audit trails, duplicate detection, and migration strategy for the current single-user product.

## 3. Single-User Secure Mode - Completed

Add one administrator credential, login, logout, password change, secure cookies, database-backed sessions, login rate limiting, CSRF/origin checks, security headers, and operational API protection without roles or multi-user permissions.

## 4. Excel Import - Completed

Build the real `.xlsx` import validation pipeline: upload, parse, validate, map columns, detect duplicates, preview, store rows, and produce error reports. The phase intentionally stops before confirmation.

## 5. Transactional Confirmation and Rollback - Completed

Apply validated import batches transactionally, record every change, support rollback, and keep audit/status history consistent.

## 6. Complaint Explorer and KPIs - Completed

Harden search, filters, KPI definitions, SLA calculations, quality metrics, pagination, sorting, and export-ready query contracts.

## 7. Reports and Scheduling - Completed

Implemented six governed report types (executive summary, department performance, region/facility performance, classification analysis, complaint detail, overdue complaints) backed by a central report engine that reuses `ComplaintKpiService`/`ComplaintQueryService` for parity with the Dashboard/Analytics/Explorer. Added preview, PDF export (pdfkit + Amiri Arabic font, RTL, page numbers), XLSX export (exceljs, formula-injection safe, no macros/external links), saved report templates, internal daily/weekly/monthly scheduling (Asia/Riyadh, idempotent, secret-protected `run-due` endpoint), artifact storage/download, and a 90-day retention cleanup script. See `docs/phase-7-reporting-design.md` and `docs/phase-7-completion-report.md`.

## 8. Governed AI and Release Hardening - Completed

Added optional governed AI analysis (disabled by default, `AI_ENABLED=false`): 5 analysis types (executive summary, recurring topics, root causes, anomaly analysis, improvement opportunities), OpenAI provider adapter, PII sanitization, Zod-validated structured output, versioned prompts, rate limiting (concurrent lock + daily limit + 5-minute dedup), and full audit trail. Removed all 501 stubs. Added CSP headers, centralized logger (no PII), health check endpoints (`/api/health/live`, `/api/health/ready`), backup/restore scripts with SHA-256 checksums, database integrity check (10 checks), release manifest, and release check (11 validations). 372 tests passing, TypeScript clean, ESLint clean, build succeeds. See `docs/phase-8-governed-ai-design.md` and `docs/phase-8-completion-report.md`.

## 9. Enterprise Authentication and Scopes (Post-v1.0)

Implement enterprise authentication, session handling, roles, regional/department scopes, and API authorization checks when the product moves beyond single-user operation.

## 10. Future Enhancements (Post-v1.0)

- Email delivery of scheduled reports
- MFA for administrator login
- nonce-based CSP (blocked by Next.js App Router limitations)
- Playwright E2E automation
- External logging/monitoring integration
