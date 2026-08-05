-- Governed classification taxonomy restructure operational tables.

CREATE TABLE "ClassificationTaxonomyRestructureRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "proposalHash" TEXT NOT NULL,
    "mappingHash" TEXT NOT NULL,
    "currentTaxonomyFingerprint" TEXT NOT NULL,
    "targetTaxonomyFingerprint" TEXT NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "renamedCount" INTEGER NOT NULL DEFAULT 0,
    "movedCount" INTEGER NOT NULL DEFAULT 0,
    "deactivatedCount" INTEGER NOT NULL DEFAULT 0,
    "keywordChangeCount" INTEGER NOT NULL DEFAULT 0,
    "legacyComplaintConsistencyUpdateCount" INTEGER NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "rollbackOfRunId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "ClassificationTaxonomyRestructureRun_status_idx" ON "ClassificationTaxonomyRestructureRun"("status");
CREATE INDEX "ClassificationTaxonomyRestructureRun_manifestHash_idx" ON "ClassificationTaxonomyRestructureRun"("manifestHash");
CREATE INDEX "ClassificationTaxonomyRestructureRun_proposalHash_idx" ON "ClassificationTaxonomyRestructureRun"("proposalHash");
CREATE INDEX "ClassificationTaxonomyRestructureRun_rollbackOfRunId_idx" ON "ClassificationTaxonomyRestructureRun"("rollbackOfRunId");

CREATE TABLE "ClassificationTaxonomyRestructureItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "entityType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityId" TEXT,
    "previousStateJson" JSONB,
    "nextStateJson" JSONB,
    "result" TEXT NOT NULL,
    "skipReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClassificationTaxonomyRestructureItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ClassificationTaxonomyRestructureRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ClassificationTaxonomyRestructureItem_runId_sequence_key" ON "ClassificationTaxonomyRestructureItem"("runId", "sequence");
CREATE INDEX "ClassificationTaxonomyRestructureItem_runId_idx" ON "ClassificationTaxonomyRestructureItem"("runId");
CREATE INDEX "ClassificationTaxonomyRestructureItem_entityType_idx" ON "ClassificationTaxonomyRestructureItem"("entityType");
CREATE INDEX "ClassificationTaxonomyRestructureItem_action_idx" ON "ClassificationTaxonomyRestructureItem"("action");
CREATE INDEX "ClassificationTaxonomyRestructureItem_result_idx" ON "ClassificationTaxonomyRestructureItem"("result");
