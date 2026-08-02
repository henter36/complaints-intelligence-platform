# Issue #24 — Starter handoff

This branch starts from `feat/arabic-complaints-report-redesign` so it can reuse the report comparison work introduced by PR #21.

## Added foundation

- `src/lib/analytics/comparison-evaluation.ts`
  - Central comparison result for `غير متاح`, `جديد`, `لا تغير`, `ارتفاع`, and `انخفاض`.
  - Prevents the incorrect `previous = 0 => 100%` fallback.
- `src/lib/analytics/analytical-finding.ts`
  - Strict Zod contract for traceable analytical findings.
  - Includes severity, confidence, detection source, evidence, limitations, detector version, and drilldown filters.
- Unit tests for both foundations.

## Required next integration

1. Replace local comparison logic in `src/components/screens/analytics.tsx` with `evaluateComparison`.
2. Reuse the same helper in report preview/PDF/XLSX where equivalent logic still exists; do not create another mapper.
3. Fix `/api/analytics` so `regionPriorityBreakdown` returns actual priority counts per region instead of `{ region, total }` only.
4. Introduce a server-side `analytics-findings-service` that returns `AnalyticalFinding[]` from quantitative data.
5. Replace the current anomaly rule `count > average * 1.5` with a baseline comparison against the entity's own history. Keep average/median/deviation as supporting metrics only.
6. Add URL-safe drilldown filters from every finding to `complaints-explorer`.
7. Add focused tests first, then full typecheck/lint/test/build.

## Guardrails

- Do not redesign the analytics page in this PR; this branch is the correctness foundation for issue #24.
- Do not add Prisma migrations for text-risk entities yet; those belong to issues #25 and #26.
- Do not use AI/model output for quantitative findings.
- Do not classify high volume alone as a problem.
- Do not force-push.
