# Phase 8: Governed AI Architecture

## Principles

1. **Disabled by default** — AI_ENABLED=false until explicitly configured.
2. **Read-only** — AI never modifies complaints, statuses, or any operational data.
3. **Optional** — System fully functional without AI.
4. **PII-free** — All personal data stripped before sending to provider.
5. **Structured** — Every response validated against Zod schemas.
6. **Logged** — All AI activity logged to AuditLog.
7. **Bounded** — Rate limits, timeouts, and input size limits enforced.

## Analysis Types

| Type | Purpose |
|---|---|
| EXECUTIVE_SUMMARY | KPI overview, key findings, risks |
| RECURRING_TOPICS | Common patterns and themes |
| POSSIBLE_ROOT_CAUSES | Probabilistic root cause analysis |
| ANOMALY_ANALYSIS | Unusual spikes and deviations |
| IMPROVEMENT_OPPORTUNITIES | Actionable improvement suggestions |

## Data Flow

```
User → API → AI Service
               ↓
       checkRateLimits()
               ↓
       db.complaint.findMany() [filtered, max 500]
               ↓
       sanitizeComplaintsForAi()  [PII removed]
               ↓
       buildPrompt() [versioned, role-bounded]
               ↓
       callOpenAI() [with AbortController timeout]
               ↓
       ANALYSIS_SCHEMAS[type].safeParse() [Zod validation]
               ↓
       db.AiAnalysisResult.create() [structured result only]
               ↓
       writeAuditLog() [no PII, no raw prompt]
```

## PII Sanitization

Fields removed before AI call:
- complainantName, complainantIdentifier, complainantPhone
- sourceReference (if contains PII)
- externalId (not sent)
- rawData (never sent)
- AuditLog records (never sent)
- ImportChangeSnapshot (never sent)

Regex patterns applied to text:
- Saudi national ID (10-digit, starts with 1/2)
- Phone numbers (Saudi formats)
- Email addresses
- URLs
- Long numeric sequences

## Rate Limits

- One concurrent run at a time (system-wide)
- Daily limit: AI_DAILY_RUN_LIMIT (default 20)
- Deduplication: same type + filters blocked within 5 minutes
- Input limit: AI_MAX_INPUT_COMPLAINTS (default 500)
- Character limit: AI_MAX_INPUT_CHARS (default 120,000)
- Timeout: AI_REQUEST_TIMEOUT_SECONDS (default 60)
- Current behavior: provider requests are not retried in v1.

### Planned retry policy

A future version may implement one bounded retry for transient provider errors such as temporary 429 and 5xx responses. Authentication, validation, and timeout failures will not be retried.

## Prompt Governance

Each prompt version is tracked in AiAnalysisRun.promptVersion.

All prompts enforce:
- Role limitation ("analyst/advisor only")
- No fabrication ("only use provided data")
- No decision-making ("human reviews all outputs")
- Probabilistic language requirement
- No PII disclosure
- No individual accusations
- Correlation ≠ causation reminder
- Structured JSON output only

## Data Retention

- Results expire after AI_RETENTION_DAYS (default 90)
- Soft delete (deletedAt) preserves run metadata
- AuditLog is never deleted
- `npm run ai:cleanup` handles expired results

## Database Models

- **AiAnalysisRun** — tracks every analysis request, status, timing, model, prompt version
- **AiAnalysisResult** — stores validated JSON result (soft-deletable)
- **AiFeedback** — records user ratings (helpful/not_helpful) separate from results
