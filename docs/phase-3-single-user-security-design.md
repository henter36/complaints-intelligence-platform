# Phase 3 Single-User Security Design

## Decision

The platform runs in Single-User Secure Mode. It has one administrator credential, no self-registration, no roles, no permissions, and no multi-user management.

## Credential Model

`AdminCredential` stores the only administrator account. A unique `singletonKey` prevents more than one active administrator row. Passwords are stored as bcrypt hashes only.

Initialization:

```bash
npm run auth:hash-password
npm run auth:init-admin -- --env-file .env.admin
```

`auth:hash-password` reads from a hidden prompt when interactive, or protected stdin in automation. Store `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH` in a protected `.env.admin` file. `auth:init-admin -- --replace --env-file .env.admin` intentionally replaces the existing single credential and revokes sessions.

## Sessions

`AdminSession` stores a hash of a random 256-bit session token. The raw token is only sent as an HttpOnly cookie named `cip_session`.

Cookie policy:

- `HttpOnly`
- `SameSite=Lax`
- `Secure` in production
- `Path=/`
- Max age from `SESSION_TTL_HOURS`, default 8 hours

Sessions have absolute expiry. Expired and revoked sessions are rejected. `lastSeenAt` is updated at most every five minutes.

## Rate Limiting

`LoginAttempt` stores hashed identifiers and hashed IP values. The login route reserves a failed attempt inside a database transaction before running bcrypt verification, then marks that attempt as succeeded after a valid login. This prevents parallel requests from all passing a separate count-before-insert check. The route allows five failed attempts per 15 minutes before returning `429 TOO_MANY_REQUESTS`.

## CSRF

State-changing auth endpoints use POST and validate same-origin requests. Missing or malformed `Origin`/`Host` headers are rejected for unsafe methods. Cookie `SameSite=Lax` is also applied.

## Security Headers

Middleware applies:

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-Frame-Options: DENY`
- `Permissions-Policy`
- A constrained CSP with a per-request script nonce and no `unsafe-inline` in `script-src`

## Protected Surface

`/login`, `/api`, `/api/auth/login`, `/api/auth/logout`, Next static assets, and public files are public. Application pages and operational APIs require a valid admin session.

## Audit Events

Authentication events are appended to `AuditLog`:

- `AUTH_LOGIN_SUCCEEDED`
- `AUTH_LOGIN_FAILED`
- `AUTH_RATE_LIMITED`
- `AUTH_LOGOUT`
- `AUTH_PASSWORD_CHANGED`
- `AUTH_SESSION_REVOKED`

Passwords, session tokens, password hashes, raw IPs, and complaint text are not written to auth audit metadata.

## Limits And Future Expansion

This phase intentionally excludes roles, permissions, multiple users, MFA, OAuth, password reset email, Excel upload, reports export, and AI integration. A future multi-user mode can introduce a separate user model and authorization policy without changing the session-token storage pattern.
