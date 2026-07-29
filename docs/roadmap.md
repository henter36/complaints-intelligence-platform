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

## 7. Reports and Scheduling

Implement governed report templates, PDF/Excel generation, scheduled delivery, and recipient/audit controls.

## 8. Governed AI

Introduce provider abstraction, prompt/version governance, PII controls, human approval, traceability, and safe fallbacks.

## 9. Enterprise Authentication and Scopes

Implement enterprise authentication, session handling, roles, regional/department scopes, and API authorization checks when the product moves beyond single-user operation.

## 10. Final Hardening and Release

Run performance, accessibility, security, backup/restore, disaster recovery, deployment, monitoring, and release readiness reviews.
