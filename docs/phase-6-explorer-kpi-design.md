# Phase 6 Explorer And KPI Design

## Scope

Phase 6 turns the complaint explorer, dashboard, analytics APIs, and CSV list export into a shared operational surface for the current single-user product. It does not add PDF/XLSX reports, scheduling, AI execution, roles, permissions, or external integrations.

## Central Query Contract

Complaint list, dashboard, analytics, and CSV export use the central complaint query service. Supported filters are:

- `page`, `pageSize`
- `search`
- `externalId`, `sourceReference`
- `status`, `priority`, `severity`, `channel`
- `region`, `regionId`, `facility`, `facilityId`, `department`, `departmentId`
- `categoryId`, `classificationId`, `importBatchId`
- `from`, `to`, `dueFrom`, `dueTo`, `closedFrom`, `closedTo`
- `isLate`, `isOpen`, `isClosed`, `hasDueDate`, `hasClassification`
- `isRepeated`, `isValidated`, `aiAnalyzed`
- `sortBy`, `sortOrder`

All parameters are parsed through Zod. Invalid values return `400 INVALID_COMPLAINT_QUERY`. `pageSize` is capped at 100 for general list APIs. Sorting uses an allowlist and always adds `id` as a deterministic tie-breaker.

## Status Definitions

Open complaints:

- `NEW`
- `OPEN`
- `IN_PROGRESS`
- `AWAITING_RESPONSE`

Operationally closed complaints:

- `RESOLVED`
- `CLOSED`

Cancelled complaints:

- `CANCELLED`

`CANCELLED` is terminal but not counted as operationally closed. `RESOLVED` is counted as closed for SLA and closure metrics because operational work is complete, although it can still move to `CLOSED` or be reopened through a documented transition.

## Lateness

Current lateness:

- active complaint is not deleted,
- status is open,
- `dueDate` exists,
- `dueDate < now`.

Closed late:

- status is `RESOLVED` or `CLOSED`,
- `dueDate` exists,
- `closedAt > dueDate`.

Within due date:

- status is `RESOLVED` or `CLOSED`,
- `dueDate` exists,
- `closedAt <= dueDate`.

Complaints without `dueDate` are reported separately and excluded from due-date compliance denominator.

## KPI Definitions

- `totalComplaints`: all non-deleted complaints matching filters.
- `openComplaints`: statuses in the open set.
- `closedComplaints`: `RESOLVED` and `CLOSED`.
- `cancelledComplaints`: `CANCELLED`.
- `currentlyLateComplaints`: open complaints past due date.
- `closedLateComplaints`: closed complaints closed after due date.
- `closedWithinDueDate`: closed complaints closed on or before due date.
- `withoutDueDate`: complaints without due date.
- `unclassifiedComplaints`: complaints without `classificationId`.
- `highPriorityOpenComplaints`: open complaints with `HIGH` or `CRITICAL` priority.
- `averageResolutionDays`: average days from complaint date, or received date fallback, to `closedAt`.
- `medianResolutionDays`: median of the same resolution-day population.
- `averageOpenAgeDays`: average age of currently open complaints.
- `dueDateComplianceRate`: `closedWithinDueDate / closed complaints that have dueDate and closedAt`.
- `closureRate`: `closedComplaints / totalComplaints`.
- `reopenCount`: status-history rows where a terminal status moves back to an open status.

Rates return 0 when the denominator is 0. Previous-period percentage change is `null` when the previous value is 0 and the current value is non-zero to avoid reporting infinity.

## Drill-Down

Dashboard and analytics payloads use the same filter contract as the explorer, so UI drill-down links can map KPI cards or distribution rows to `GET /api/complaints` query strings such as `isLate=true`, `regionId=...`, or `classificationId=...`.

## CSV Export

`GET /api/complaints/export` uses the same query service and filter contract. It exports CSV UTF-8 with BOM, protects cells that start with `=`, `+`, `-`, or `@`, excludes complainant PII by default, and enforces a 10,000 row export limit.

## Privacy

Complaint list, dashboard, analytics, filters, and CSV export do not expose complainant name, identifier, or phone. Complaint detail is authenticated and masks identifier/phone before returning them. Audit metadata avoids PII and full complaint descriptions.

## Performance

The current implementation is designed for the local single-user SQLite prototype. Query APIs use Prisma `select`, soft-delete filters, deterministic ordering, and no obvious N+1 loops. A local 10,000-complaint synthetic measurement on SQLite returned approximately:

- Dashboard KPI service: 1558 ms.
- First complaint list page: 18 ms.
- CSV data retrieval and formatting: 481 ms for 10,000 rows.

Median and aggregations are calculated in memory for the current result scope; a production database phase should revisit this for much larger datasets.
