# Facility operational status semantics

`Facility` is the administrative registry for prison names and operational status. `Complaint.facility` remains the historical display-name value used by imports and raw complaint exploration; closing a facility never deletes or rewrites complaints, import batches, or status history.

## Status and closure date

- `ACTIVE`: included in current operational analytics. `closedAt` is always `null`.
- `CLOSED`: excluded from current operational analytics and requires a valid `closedAt`.
- Reopening changes the row to `ACTIVE` and clears `closedAt`.
- Import synchronization creates previously unseen names as `ACTIVE`, is idempotent through the normalized-name unique key, and never changes an existing facility status.

## Current and historical analytics

Current Dashboard, Analytics, Operational Analytics, KPI distributions, and their drill-downs exclude `CLOSED` facilities before aggregation. Raw Complaints Explorer remains complete unless it is opened from an operational drill-down carrying the explicit current-scope flag.

Historical reports use event-time eligibility:

- a facility is eligible at instant `t` when it is `ACTIVE`, or when it is `CLOSED` and `t < closedAt`;
- a facility closed on or before `period.from` is outside that period;
- when closure occurs inside a period, received/closure events before `closedAt` remain eligible and events at or after it are excluded;
- stock metrics (`openAtEnd`, `lateAtEnd`) exclude the facility when `closedAt <= measuredAt`.

Therefore closing a facility today does not rewrite reports for periods in which it was operating.

## Zero-volume facilities

The eligible Facility Registry is left-joined with the report period snapshot. An eligible facility with no received complaints receives zero flow metrics but can still have historical `openAtEnd` or `lateAtEnd` backlog. It is eligible for “lowest facilities”. A closed, period-ineligible facility is not added merely because its values would be zero.

## Name and region backfill

Backfill trims/collapses whitespace and reuses the shared Arabic normalizer. Blank, `null`, and `غير محدد` names are ignored. A region is stored only when all canonical nonblank historical region values agree; conflicts leave `region = null` and produce a warning without blocking the registry.

Historical facility selection in the generic report filter UI is currently limited to the active-registry list. General historical reports remain temporally correct; raw complaints remain searchable by their historical facility name.
