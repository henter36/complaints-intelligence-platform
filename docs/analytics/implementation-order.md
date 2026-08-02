# Analytics implementation order

1. **#24 — Correctness foundation**
   - Shared comparisons and KPI semantics.
   - AnalyticalFinding contract.
   - Priority breakdown correctness.
   - Quantitative findings service.

2. **#25 — Deterministic critical text-risk rules**
   - Full confirmed-population processing.
   - Negation, suspicion, time, evidence spans, versioning.

3. **#26 — Structured semantic extraction**
   - Event, service, place, count, time, persistence, certainty.

4. **#30 — Confidence and data quality**
   - Confidence scoring before exposing advanced findings as decision support.

5. **#27 — Emerging-topic clustering**
   - Clustering and historical novelty/spread detection.

6. **#28 — Analytics page rebuild**
   - Diagnostic overview, findings, investigation, drilldown.

7. **#29 — Human review and follow-up governance**
   - Confirm/dismiss/merge, create observation/follow-up, audit trail.

Do not begin clustering or major UI redesign before #24 and #25 are stable. Doing so would encode incorrect comparison and evidence semantics into later layers.
