# Phase 5 Import Confirmation Design

## Scope

Phase 5 applies an already validated import batch. It does not parse Excel files, create reports, call AI, or introduce roles. The system remains single-user.

## State Transitions

Confirmation:

```text
READY_FOR_CONFIRMATION -> CONFIRMING -> CONFIRMED
```

Rollback:

```text
CONFIRMED -> ROLLING_BACK -> ROLLED_BACK
```

Only `READY_FOR_CONFIRMATION` batches can be confirmed. Only `CONFIRMED` batches can be rolled back.

## Transaction Design

Confirmation uses one interactive Prisma transaction:

1. Atomically changes the batch from `READY_FOR_CONFIRMATION` to `CONFIRMING`.
2. Revalidates row actions and validation statuses.
3. Applies `NEW` rows by creating complaints.
4. Applies `UPDATE` rows using the previewed complaint version.
5. Skips `NO_CHANGE` and `DUPLICATE`.
6. Writes status history, snapshots, row application markers, and audit logs.
7. Sets the batch to `CONFIRMED`.

If any step fails, the transaction rolls back and no complaint, snapshot, row marker, or confirmed status remains.

## Confirmation Policy

`REJECT` or `INVALID` rows block the whole batch. `DUPLICATE` and `NO_CHANGE` rows are preserved but do not mutate complaints.

`UPDATE` rows must still point to the same active complaint version captured during preview. If the complaint version changed, confirmation fails with `IMPORT_PREVIEW_STALE`.

## Merge Policy

Import may update operational complaint fields: source reference, complaint dates, due/closed dates, status, subject, description, region, facility, department, category, classification, priority/severity, channel, and resolution.

Import does not update complaint `id`, `createdAt`, `updatedAt`, `version`, soft-delete fields, audit fields, or `externalId`.

## Snapshot Design

`ImportChangeSnapshot` stores one immutable snapshot for each applied `NEW` or `UPDATE` row.

`CREATE` snapshots store no `beforeData`; rollback soft-deletes the created complaint. `UPDATE` snapshots store selected `beforeData` and `afterData`, plus `versionBefore` and `versionAfter`.

Snapshots are not exposed by public API responses.

## Rollback

Rollback is atomic. It checks every current complaint version against `versionAfter`. If any complaint changed after confirmation, rollback fails with `ROLLBACK_CONFLICT` and no partial restoration happens.

`CREATE` rollback soft-deletes the created complaint. `UPDATE` rollback restores the selected fields from `beforeData` and writes reverse status history when status changes.

## Audit

Audit events include confirmation start/completion, per-complaint create/update, rollback start/completion, and per-complaint reversal. Metadata contains batch, row, complaint, and action identifiers only; it excludes raw rows and personal data.

## Performance

The implementation targets the Phase 4 preview size. Confirmation and rollback run inside a transaction to preserve atomicity. For larger production databases, moving to PostgreSQL or SQL Server can improve concurrency while preserving the same service boundary.

## Risks

SQLite serializes writes, which is acceptable for the current single-user local deployment but limits concurrent throughput. Rollback intentionally refuses to proceed if later complaint edits exist.
