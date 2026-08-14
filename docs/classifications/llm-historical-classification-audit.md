# LLM Historical Classification Audit — Phase 1

## Scope and no-apply guarantee

This phase builds a governed, read-only semantic audit. It can prepare a draft semantic catalog, prepare a human review set, evaluate a classifier and independent verifier, and run a gated pilot. It has no mutation path for `Complaint`, `Category`, or `Classification`; it never updates `classificationId`, `categoryId`, `version`, assignment metadata, keywords, or taxonomy names. Applying historical changes remains a separate future phase and PR.

All live artifacts are written below `.local/llm-classification/`, which is Git-ignored. Repository code contains only contracts, tests, documentation, and a placeholder catalog template without live taxonomy IDs or complaint text.

## Architecture

The workflow is deliberately separate from the deterministic historical classification audit:

1. `classification-semantic-catalog.ts` loads active, non-deleted categories and classifications once, computes the existing taxonomy fingerprint, and prepares a draft catalog.
2. `llm-classification-gold-set.ts` selects a deterministic stratified sample for human labeling and separates the real-ID mapping into a private local file.
3. `llm-classification-service.ts` sanitizes the minimal complaint projection, retrieves a broad candidate set locally, and invokes the semantic classifier.
4. `llm-classification-verifier.ts` independently checks every proposed change without receiving the classifier rationale.
5. `llm-classification-evaluation.ts` measures only human-reviewed labels and enforces the pilot gate.
6. `llm-classification-pilot.ts` performs a bounded, resumable, cached, read-only dry run after the gate succeeds. A 10–20 item smoke mode may be used to validate provider wiring, but it is not an accuracy evaluation or pilot approval.

The existing OpenAI provider owns the SDK client. Classification adds a stateless Responses API adapter with strict JSON Schema Structured Outputs, `store: false`, a bounded timeout, bounded transient retries, and no tools, conversations, assistants, files, vector stores, web search, or background mode. `AI_CLASSIFICATION_MODEL` is optional and falls back to `AI_MODEL`.

## Privacy and PII sanitization

Only `sourceDetail`, `subject`, and `description` enter the classification boundary. The central `ai-data-sanitization-service.ts` removes national IDs, phone numbers, email addresses, URLs, secrets/tokens, card numbers, long identifiers, and Arabic names following recognized labels. Facility, region, complainant fields, external IDs, and real complaint IDs are not part of the provider contract.

Each request receives an opaque local identifier such as `C000001`. The private mapping to a database ID never appears in prompts. Normal logs contain only aggregate counts or safe error codes; raw prompts, complaint text, API responses, reasons, credentials, and token values are not logged.

## Semantic catalog

Run:

```bash
npm run classifications:semantic-catalog
```

The output is `.local/llm-classification/semantic-catalog-draft.json`. Every entry is marked `DRAFT_REQUIRES_REVIEW`. When AI is disabled, the command builds a taxonomy-only scaffold using existing descriptions and keywords and marks entries `PENDING_LLM_ENRICHMENT`; it does not call a provider or invent definitions. When governed AI is enabled, sanitized examples are selected deterministically and used to generate draft definitions, included/excluded concepts, and confusable active IDs. Generated content is still a draft and must be reviewed before adoption.

The committed `semantic-catalog-template.json` is a schema-shaped placeholder only. Copying generated content into the repository requires a separate explicit human review.

## Gold Set and leakage prevention

Run:

```bash
npm run classifications:gold-set -- --size=400
```

The selector covers classifications, categories, source-detail presence, description lengths, and incomplete assignments using deterministic stratification. The review file contains sanitized text, current assignment as context (not truth), candidate choices, `humanExpectedClassificationId: null`, and `humanReviewStatus: PENDING`. Codex, the current assignment, and the model must not fill the human label.

The real-ID mapping is stored separately in `.local/llm-classification/private-gold-map.json` with restrictive local permissions. A stable 70/30 `DEVELOPMENT`/`HOLDOUT` split is assigned before labeling. Holdout labels must not be used for prompt or catalog calibration.

## Classifier, verifier, and candidate retrieval

The model is the semantic classifier. Keywords, normalized terms, names, current assignment, and confusable classifications help retrieve candidates and provide evidence, but no keyword forces a decision. Weak retrieval widens to the full active catalog to protect candidate recall.

The classifier returns only `KEEP`, `CHANGE`, or `REVIEW`, active taxonomy IDs, an evidence level, bounded reason codes, and a rationale of at most 300 characters. Complaint content and candidate taxonomy appear before the section labeled “current system assignment — may be wrong” to reduce anchoring.

A classifier `CHANGE` always triggers a second independent verifier pass. `CHANGE_CONFIRMED` requires `APPROVE_CHANGE`, exact agreement on the proposed classification ID, and a still-valid category/classification pair. Rejection, disagreement, or ambiguity becomes `REVIEW`; invalid IDs or pairs become `INVALID_OUTPUT`; provider failures become `API_FAILED`.

## Evaluation and acceptance gate

After humans provide labels in a reviewed copy:

```bash
npm run classifications:llm-eval -- \
  --gold-set=.local/llm-classification/gold-set-reviewed.json
```

With no reviewed labels, the command stops with `GOLD_SET_NOT_YET_LABELED` and reports no accuracy. Evaluation calculates overall accuracy, KEEP and CHANGE precision/recall/F1, macro F1, per-category and per-classification accuracy, confusion matrix, abstention and REVIEW rates, candidate recall, classifier/verifier disagreement, current-assignment agreement, and anchoring errors.

`PILOT_APPROVED` requires all of the following on the untouched holdout: at least 90 reviewed items, at least 20 genuinely changed assignments, `CHANGE_CONFIRMED` precision of at least 98%, and no target classification with a repeated severe precision failure. Model-to-model agreement is reported only as agreement, never as accuracy.

## Pilot, reliability, resume, and cost controls

The full pilot is blocked unless an evaluation artifact says `PILOT_APPROVED`:

```bash
npm run classifications:llm-pilot -- \
  --limit=1000 \
  --evaluation=.local/llm-classification/evaluation-latest.json
```

A provider smoke test is explicitly separate:

```bash
npm run classifications:llm-pilot -- --smoke --limit=10
```

Selection is deterministic and stratified rather than the first rows. Concurrency and retries are bounded; only rate limits, 5xx errors, network failures, and timeouts are retried with exponential backoff. Authentication, request, and schema failures are not retried.

State is saved with `PENDING`, `COMPLETED`, and `FAILED` after every concurrency-sized batch. The cache key hashes sanitized content, candidate IDs, model, prompt version, taxonomy fingerprint, and semantic catalog fingerprint. It is never keyed by complaint ID alone. A changed prompt, model, catalog, taxonomy, candidate set, or sanitized text invalidates the cache.

Before calls, the artifact estimates complaint count, input characters/tokens, request upper bound, and candidate size. Results aggregate classifier/verifier token usage and request counts. Public pilot output contains only run metadata, outcome counts, and transition counts. Sanitized review text and short reasons are confined to the ignored private review artifact.

## Known limitations and next phase

Draft definitions are not policy, current historical assignments are not ground truth, deterministic candidate retrieval can still miss concepts, and LLM outputs can vary by model release. The 98% gate reduces but does not eliminate risk. Phase 1 intentionally produces no correction manifest that can be applied.

The next phase may design a separately reviewed apply workflow only after humans approve the semantic catalog, label a sufficiently representative Gold Set, the untouched holdout passes the gate, and pilot transitions receive operational review.
