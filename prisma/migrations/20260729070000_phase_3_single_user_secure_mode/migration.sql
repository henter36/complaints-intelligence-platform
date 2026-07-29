-- Phase 3: single-user secure mode

CREATE TABLE "AdminCredential" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "singletonKey" TEXT NOT NULL DEFAULT 'single-admin',
  "username" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "passwordChangedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "AdminSession" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tokenHash" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" DATETIME NOT NULL,
  "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" DATETIME,
  "ipHash" TEXT,
  "userAgentHash" TEXT
);

CREATE TABLE "LoginAttempt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "identifierHash" TEXT NOT NULL,
  "ipHash" TEXT,
  "succeeded" BOOLEAN NOT NULL DEFAULT false,
  "attemptedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "AdminCredential_username_key" ON "AdminCredential"("username");
CREATE UNIQUE INDEX "AdminCredential_singletonKey_key" ON "AdminCredential"("singletonKey");
CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");
CREATE INDEX "AdminSession_revokedAt_idx" ON "AdminSession"("revokedAt");
CREATE INDEX "LoginAttempt_identifierHash_idx" ON "LoginAttempt"("identifierHash");
CREATE INDEX "LoginAttempt_attemptedAt_idx" ON "LoginAttempt"("attemptedAt");
CREATE INDEX "LoginAttempt_identifierHash_attemptedAt_idx" ON "LoginAttempt"("identifierHash", "attemptedAt");
