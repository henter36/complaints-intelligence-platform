# Roadmap

## 1. Foundation Hardening

Establish npm, TypeScript, lint, tests, production build, CI, Prisma validation, security audit visibility, and honest documentation.

## 2. Data Model

Review and normalize complaint entities, import batches, batch rows, classifications, regions, departments, SLA dates, audit trails, and migration strategy.

## 3. Authentication and Scopes

Implement enterprise authentication, session handling, roles, regional/department scopes, and API authorization checks.

## 4. Excel Import

Build the real Excel/CSV import pipeline: upload, parse, validate, map columns, detect duplicates, preview, store rows, and produce error reports.

## 5. Transactional Approval and Rollback

Apply validated import batches transactionally, record every change, support rollback, and enforce approval permissions.

## 6. Complaint Explorer and KPIs

Harden search, filters, KPI definitions, SLA calculations, quality metrics, pagination, sorting, and export-ready query contracts.

## 7. Reports and Scheduling

Implement governed report templates, PDF/Excel generation, scheduled delivery, and recipient/audit controls.

## 8. Governed AI

Introduce provider abstraction, prompt/version governance, PII controls, human approval, traceability, and safe fallbacks.

## 9. Final Hardening and Release

Run performance, accessibility, security, backup/restore, disaster recovery, deployment, monitoring, and release readiness reviews.
