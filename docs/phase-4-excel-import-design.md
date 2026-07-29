# Phase 4 Excel Import Design

## Scope

Phase 4 implements secure `.xlsx` upload, parsing, validation, duplicate detection, preview persistence, and error-report download. It stops at `ImportBatchStatus.READY_FOR_CONFIRMATION`.

Out of scope: creating or updating `Complaint`, import confirmation, rollback, Excel/PDF reports, AI classification, roles, permissions, and external storage.

## Library Choice

The import engine uses:

- `jszip` `^3.10.1` for ZIP container inspection and XML part access.
- `fast-xml-parser` `^5.10.1` for OOXML XML parsing.

`xlsx` was not reintroduced. `exceljs` was evaluated and rejected because it introduced high runtime audit findings through archive dependencies. The selected approach reads the OOXML workbook parts directly, does not evaluate formulas, does not run macros, and rejects external links and VBA content.

## File Limits

Defaults are configurable through environment variables:

- `IMPORT_MAX_FILE_SIZE_MB=10`
- `IMPORT_MAX_ROWS=10000`
- `IMPORT_MAX_COLUMNS=100`
- `IMPORT_MAX_SHEETS=5`
- `IMPORT_STORAGE_PATH=./storage/imports`
- `IMPORT_RETENTION_DAYS=30`

Only `.xlsx` is accepted. `.xls` and `.csv` are rejected in this phase.

## Security Validation

The upload path validates:

- Extension.
- MIME type.
- ZIP magic bytes.
- Valid OOXML ZIP structure.
- Required `[Content_Types].xml` and `xl/workbook.xml`.
- Internal ZIP paths to block Zip Slip.
- ZIP entry count and uncompressed-size limits to reduce Zip Bomb risk.
- Macro and external-link parts.
- Sheet, row, and column limits.

Files are stored outside `public/` with randomized internal names. `storage/` is ignored by Git. SHA-256 is calculated from file content and used for duplicate-file detection.

## Batch Lifecycle

Allowed Phase 4 transition:

```text
UPLOADED -> PARSING -> VALIDATED -> READY_FOR_CONFIRMATION
```

Failures from `UPLOADED` or `PARSING` move to `FAILED` with a safe failure code and short user-facing note. Stack traces and raw row data are not written to user-visible fields.

## Sheet Selection

The engine prefers a visible sheet named `الشكاوى` or `Complaints`. If neither exists, it selects the single visible sheet that contains data. If multiple visible sheets contain data, the workbook is rejected as ambiguous.

## Columns And Mapping

Column definitions live in `src/server/imports/complaint-column-schema.ts`. Arabic and English synonyms are matched deterministically after whitespace and Arabic letter normalization. Fuzzy matching is intentionally not used.

Minimum mapped fields:

- `externalId` or `sourceReference`.
- `complaintDate` or `receivedAt`.
- `subject` or `description`.

Manual mapping can be saved through `POST /api/import/{batchId}/mapping`; full manual reprocessing remains constrained to preview rows and does not confirm imports.

## Normalization

Raw cell values are preserved in `ImportBatchRow.rawData`. Normalized values are stored separately in `normalizedData`.

Normalization includes:

- Trim and whitespace cleanup.
- Safe text conversion for numeric-like identifiers.
- Excel serial dates.
- ISO and deterministic Gregorian dates.
- Arabic/English status and priority labels.
- Formula-like values beginning with `=`, `+`, `-`, or `@` are rejected for imported fields.

## Validation

Row validation checks required identity/date/text fields, future complaint dates, closed status invariants, subject and description length, active categories/classifications, and category/classification consistency. Errors produce `REJECT`; warnings can keep the row valid.

## Duplicate Detection

The engine uses the centralized `ComplaintIdentityService`:

1. `externalId`.
2. `sourceReference` plus UTC complaint date.
3. Stable fingerprint when source identifiers are absent.

It detects duplicate identities within the uploaded file and multiple rows targeting the same existing complaint. Existing matching complaints are classified as `UPDATE` or `NO_CHANGE`; new valid identities are `NEW`.

## Privacy

Preview row APIs do not return full `rawData` by default. Complainant name, identifier, and phone are masked in row preview responses. Audit logs do not store file contents, raw rows, passwords, session tokens, or personal identifiers.

## Performance

The current target is up to 10,000 rows. Rows are written in chunks of 500 inside transactions where practical. The workbook is processed synchronously because the file limits are bounded and no external queue is introduced in this phase.
