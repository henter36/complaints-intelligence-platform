# Roadmap

## 1. Foundation Hardening - Completed

Establish npm, TypeScript, lint, tests, production build, CI, Prisma validation, security audit visibility, and honest documentation.

## 2. Data Model - Completed

Normalize complaint entities, import batches, batch rows, classifications, SLA dates, audit trails, duplicate detection, and migration strategy for the current single-user product.

## 3. Excel Import

Build the real Excel/CSV import pipeline: upload, parse, validate, map columns, detect duplicates, preview, store rows, and produce error reports.

## 4. Transactional Confirmation and Rollback

Apply validated import batches transactionally, record every change, support rollback, and keep audit/status history consistent.

## 5. Complaint Explorer and KPIs

Harden search, filters, KPI definitions, SLA calculations, quality metrics, pagination, sorting, and export-ready query contracts.

## 6. Reports and Scheduling

Implement governed report templates, PDF/Excel generation, scheduled delivery, and recipient/audit controls.

## 7. Governed AI

Introduce provider abstraction, prompt/version governance, PII controls, human approval, traceability, and safe fallbacks.

## 8. Authentication and Scopes

Implement enterprise authentication, session handling, roles, regional/department scopes, and API authorization checks when the product moves beyond single-user operation.

## 9. Final Hardening and Release

Run performance, accessibility, security, backup/restore, disaster recovery, deployment, monitoring, and release readiness reviews.
