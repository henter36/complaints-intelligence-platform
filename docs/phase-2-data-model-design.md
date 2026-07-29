# Phase 2 Data Model Design

## Current Entities

Phase 1 shipped a buildable prototype with `Complaint`, `ImportBatch`, `Classification`, `Region`, `Location`, `Department`, `User`, `ComplaintHistory`, `AuditLog`, and `ReportTemplate`.

The Phase 1 schema mixed prototype UI needs with future enterprise concepts. `User.role` encoded roles as free text, complaint status was free text, import batches could be marked approved without row-level source data, and audit records depended on a user table that is out of scope for the current single-user product.

## Current Problems

- Complaint identity relied on a single complaint number and did not document duplicate matching policy.
- Complaint statuses were free strings, making invalid states possible.
- `closedAt`/closure semantics were implicit and not guarded by a central service.
- Import metadata could be approved without persisted source rows.
- Import rows did not exist, so validation errors and raw source data could not be audited.
- Audit logs were mutable regular records and tied to a future user model.
- Classification data lacked category separation, soft delete, activation, display order, and English names.
- Prototype `User` roles conflicted with the single-user architecture decision.

## New Relationships

- `Category` has many `Classification` records.
- `Complaint` optionally belongs to a `Category` and `Classification`.
- `Complaint` optionally belongs to a confirmed `ImportBatch`.
- `ComplaintStatusHistory` belongs to one `Complaint` and can optionally reference an `ImportBatch`.
- `ImportBatch` has many `ImportBatchRow` records.
- `ImportBatchRow` can reference a matched complaint and/or a complaint created by confirmation.
- `AuditLog` stores append-only domain events with text `actor`.

## Constraints

- `Complaint.externalId` is unique when present.
- `ImportBatchRow.rowNumber` is unique inside its batch.
- `Classification.categoryId + nameAr` is unique.
- `Category.nameAr` is unique.
- Complaint status, priority, import batch status, row action, row validation status, and period type are Prisma enums.
- Personal data fields are optional.
- Soft delete is represented by `isDeleted` and `deletedAt`.
- Optimistic concurrency uses `Complaint.version`.

## Indexes

- `Complaint.externalId`: primary source identifier lookup.
- `Complaint.sourceReference`: alternate source lookup.
- `Complaint.sourceReference + complaintDate`: duplicate detection fallback.
- `Complaint.status`: dashboard and workflow filtering.
- `Complaint.dueDate`: SLA/late complaint filtering.
- `Complaint.createdAt`: recent complaint sorting.
- `Complaint.isDeleted`: soft-delete exclusion.
- `Complaint.region`, `Complaint.department`, `Complaint.classificationId`: current filters and aggregations.
- `ImportBatch.fileHash`: duplicate file detection.
- `ImportBatch.status`, `ImportBatch.createdAt`: import queue and history screens.
- `ImportBatchRow.importBatchId`: batch preview and validation rows.
- `ImportBatchRow.matchedComplaintId`: update/duplicate traceability.
- `ComplaintStatusHistory.complaintId`: complaint timeline.
- `AuditLog.entityType + entityId`: entity audit trail.

## Duplicate Policy

Duplicate identity is centralized in `ComplaintIdentityService`:

1. Use normalized `externalId` when present.
2. Use normalized `sourceReference` plus the UTC calendar date derived from `complaintDate` when `externalId` is absent.
3. Use a documented composite fingerprint only when both source identifiers are absent.

Duplicate identity keys normalize `complaintDate` to its UTC calendar date so fingerprints remain stable across hosts and deployment timezones. The composite fingerprint uses that UTC complaint date, source reference, region, facility, department, and subject. It intentionally does not use complainant name, phone, identifier, or complaint text alone.

## Import Batch Lifecycle

`UPLOADED -> PARSING -> VALIDATED -> READY_FOR_CONFIRMATION -> CONFIRMING -> CONFIRMED`

Failure can move a batch to `FAILED`. Only `CONFIRMED` batches can move to `ROLLED_BACK`. Failed batches cannot be confirmed, and confirmed batches cannot be confirmed again.

Phase 2 does not implement Excel upload or confirmation execution. `POST /api/import/approve` returns `501 NOT_IMPLEMENTED` rather than fake success.

## Import Row Lifecycle

Rows start as `PENDING`, then become `VALID`, `WARNING`, or `INVALID`. Each row stores immutable `rawData`, optional `normalizedData`, validation errors, warnings, action (`NEW`, `UPDATE`, `DUPLICATE`, `REJECT`, `NO_CHANGE`), and match/create references.

Every source row must be persisted in Phase 3 before confirmation. Duplicate rows do not create new complaints.

## Migration Strategy

This repository had no Prisma migration baseline before Phase 2. The migration `20260729053000_phase_2_complaint_import_data_model` creates the normalized Phase 2 schema from an empty database.

Existing prototype data is synthetic and not treated as production data. The supported local transition is `prisma migrate reset` or a fresh SQLite database followed by seed. A production migration preserving real legacy data is intentionally not claimed in Phase 2 because the old schema contained prototype-only user/role and import-approval concepts that are now excluded.
