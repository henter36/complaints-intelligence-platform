# Foundation Hardening Report

## Package Manager Decision

- npm is the only supported package manager.
- `package-lock.json` is the authoritative lockfile.
- Bun scripts and `bun.lock` were removed.

## Removed Files

- `.zscripts/`: generation-platform runtime scripts, not used by npm/Next production build.
- `examples/websocket/`: unrelated WebSocket example that broke TypeScript.
- `mini-services/`: empty generation sidecar placeholder.
- `download/`: generation download note, not product documentation.
- `db/`: Bun/Z.ai database instructions for a different runtime.
- `tests/`: shell tests for removed generation runtime scripts.
- `Caddyfile`: unused deployment artifact.
- `worklog.md`: generation worklog with obsolete claims and external SDK notes.
- `bun.lock`: conflicting package-manager lockfile.

## TypeScript Fixes

- Removed `typescript.ignoreBuildErrors` from `next.config.ts`.
- Added `npm run typecheck`.
- Fixed nullable `dueDate` handling through `src/lib/complaint-metrics.ts`.
- Added typed Prisma where clauses in dashboard, analytics, and complaints routes.
- Fixed `prisma/seed.ts` `never[]` inference with Prisma model types.
- Removed a stale `customSuffix` prop usage in Analytics.
- Removed TypeScript-breaking example WebSocket files.

## Prisma

- `npx prisma validate`: passes.
- `npx prisma generate`: passes.
- Seed uses synthetic Arabic healthcare complaint data only.
- `db:push` no longer uses `--accept-data-loss`.
- SQLite remains a local prototype database.

## Tests

- Vitest and React Testing Library added.
- Unit tests cover Arabic formatting and complaint timing calculations.
- API tests cover `/api/dashboard` success and database failure.
- Frontend smoke tests cover home/sidebar navigation and dashboard loading skeleton.
- Current count: 13 tests across 5 test files.

## Build And Lint

- `npm run typecheck`: passes.
- `npm run lint`: passes.
- `npm test`: passes.
- `npm run build`: passes outside sandbox. Sandbox build failed only because Turbopack attempted an internal bind operation that the sandbox blocks.

## Security Audit

Before Phase 1 cleanup:

- 18 vulnerabilities: 14 high, 4 moderate.
- Runtime concerns included `xlsx`, `z-ai-web-dev-sdk`, `@mdxeditor/editor`, `react-syntax-highlighter`, `sharp`, and Next/PostCSS.

After Phase 1 cleanup:

- Removed `xlsx`, `z-ai-web-dev-sdk`, `@mdxeditor/editor`, and `react-syntax-highlighter`.
- Added overrides for `sharp` and `postcss`.
- `npm run audit:runtime`: passes with 0 runtime vulnerabilities.
- `npm audit --audit-level=high`: still reports 12 high findings in development tooling through `brace-expansion`/`minimatch` chains used by ESLint and Vitest coverage tooling.

Remaining high exception:

- Package path: `eslint`, `eslint-config-next`, `@vitest/coverage-v8` -> `minimatch`/`glob`/`test-exclude` -> `brace-expansion`.
- Classification: development tooling, not application runtime.
- Attempted remediation: `eslint@10.8.0` was tested and rejected because it breaks `eslint-config-next@16.2.12`.
- Next action: update ESLint/Next lint tooling and Vitest coverage provider when compatible versions remove the advisory without breaking lint.

## Environment

- Added `src/lib/env.ts`.
- Production now fails early if `DATABASE_URL` is missing.
- Local development defaults to `file:./dev.db` when no `DATABASE_URL` is provided by the app runtime.
- `.env.example` contains only placeholders.

## AI Scope

- Removed Z.ai SDK dependency.
- `POST /api/ai/analyze` and `POST /api/ai/summary` return explicit `501` responses.
- Governed AI remains out of scope for Phase 1.

## Constraints

- No full Excel import engine was implemented.
- No schema redesign was performed.
- No enterprise authentication or authorization was added.
- No export/report scheduling was added.

## Recommended Next Phase

Phase 2 should focus on the complaint data model, production database decision, migrations, import batch row structure, and domain validation contracts before building Excel import.
