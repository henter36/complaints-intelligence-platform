-- Governed historical correction runs are intentionally separate from the
-- historical backfill tables, whose contract only covers unclassified rows.
CREATE TABLE "ClassificationAuditRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "taxonomyFingerprint" TEXT NOT NULL,
    "databaseFingerprint" TEXT NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "totalComplaintCountBefore" INTEGER NOT NULL,
    "totalComplaintCountAfter" INTEGER,
    "activeComplaintCountBefore" INTEGER NOT NULL,
    "activeComplaintCountAfter" INTEGER,
    "plannedCount" INTEGER NOT NULL DEFAULT 0,
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "ambiguousCount" INTEGER NOT NULL DEFAULT 0,
    "insufficientEvidenceCount" INTEGER NOT NULL DEFAULT 0,
    "invalidReferenceCount" INTEGER NOT NULL DEFAULT 0,
    "batchSize" INTEGER NOT NULL DEFAULT 200,
    "actor" TEXT NOT NULL,
    "backupName" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "rollbackOfRunId" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "ClassificationAuditRun_status_idx" ON "ClassificationAuditRun"("status");
CREATE INDEX "ClassificationAuditRun_manifestHash_idx" ON "ClassificationAuditRun"("manifestHash");
CREATE INDEX "ClassificationAuditRun_rollbackOfRunId_idx" ON "ClassificationAuditRun"("rollbackOfRunId");
CREATE INDEX "ClassificationAuditRun_startedAt_idx" ON "ClassificationAuditRun"("startedAt");

CREATE TABLE "ClassificationAuditItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "complaintId" TEXT NOT NULL,
    "expectedVersion" INTEGER NOT NULL,
    "appliedVersion" INTEGER,
    "previousClassificationId" TEXT,
    "previousCategoryId" TEXT,
    "targetClassificationId" TEXT NOT NULL,
    "targetCategoryId" TEXT NOT NULL,
    "previousAssignmentSource" TEXT,
    "previousAssignedAt" DATETIME,
    "previousAssignedBy" TEXT,
    "previousTaxonomyFingerprint" TEXT,
    "previousAssignmentRunId" TEXT,
    "complaintStateHash" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "result" TEXT NOT NULL,
    "skipReason" TEXT,
    "appliedAt" DATETIME,
    "rolledBackAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClassificationAuditItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ClassificationAuditRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ClassificationAuditItem_runId_complaintId_key" ON "ClassificationAuditItem"("runId", "complaintId");
CREATE INDEX "ClassificationAuditItem_runId_idx" ON "ClassificationAuditItem"("runId");
CREATE INDEX "ClassificationAuditItem_complaintId_idx" ON "ClassificationAuditItem"("complaintId");
CREATE INDEX "ClassificationAuditItem_result_idx" ON "ClassificationAuditItem"("result");
CREATE INDEX "ClassificationAuditItem_targetClassificationId_idx" ON "ClassificationAuditItem"("targetClassificationId");
