# Phase 8 Security Review

**Date:** 2026-07-31

## Authentication & Session

- ✅ Single-admin model with bcrypt password hashing
- ✅ Secure HTTP-only session cookie
- ✅ Session expiry (configurable, default 8h)
- ✅ Login brute force protection (rate limiting)
- ✅ Password change requires current password
- ✅ No multi-user attack surface

## Content Security Policy

Headers added to all routes:
- `Content-Security-Policy` with default-src 'self'
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-DNS-Prefetch-Control: off`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`

**Known limitation:** `unsafe-inline` required for Next.js inline scripts/styles. Nonce-based CSP planned post-release.

## File Security

- Import storage: access controlled, not web-accessible
- Report artifacts: served via authenticated API with signed storage key lookup
- No path traversal: backup scripts validate paths against manifest
- Symlinks skipped in backup/copy operations
- File type validated by MIME, not extension alone

## AI Security

- AI key never logged, never returned via API
- AI key validated at startup when AI_ENABLED=true
- Placeholder keys rejected
- PII stripped before any AI request
- Structured output validated (Zod) before storage
- Rate limiting prevents cost abuse
- No prompt injection (input data is structured JSON, not user-controlled prompts)
- AI results rendered as structured sections, not raw Markdown/HTML
- No dangerouslySetInnerHTML in AI result display

## API Security

- All mutation APIs require authenticated session
- No CSRF token explicitly (uses same-origin cookie, HTTP-only, SameSite=Lax)
- 401 for unauthenticated, 403 for unauthorized
- Stack traces suppressed in API responses
- Error messages do not expose internal paths or secrets

## Input Validation

- All request bodies validated with Zod before processing
- Excel imports: file size, row count, column count, sheet count limits
- Import path validation against storage root

## No-PII Logging

- Logger sanitizes keys matching `/key|secret|password|token|hash|cookie|authorization/i`
- AI results not logged in full
- Complaint text not logged
- No stack traces in API responses (server logs only)

## Secrets Management

- .env not tracked by git
- .env.admin (admin credentials) not tracked
- Database not tracked
- Backups not tracked
- release-manifest.json not tracked (generated at build time)

## Identified Issues & Mitigations

| Issue | Risk | Mitigation |
|---|---|---|
| unsafe-inline in CSP | Medium | Required by Next.js; scope limited to self; post-release nonce-based CSP |
| SQLite single-file database | Low | Backup before upgrades; WAL mode for consistency |
| No network segmentation | Low | Single-server, local use only |
