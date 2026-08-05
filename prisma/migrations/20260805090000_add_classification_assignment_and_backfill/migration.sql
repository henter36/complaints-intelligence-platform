-- Add classification assignment metadata and historical backfill operational tables.

-- Complaint assignment provenance (optional for existing rows).
ALTER TABLE "Complaint" ADD COLUMN "classificationAssignmentSource" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "classificationAssignedAt" DATETIME;
ALTER TABLE "Complaint" ADD COLUMN "classificationAssignedBy" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "classificationTaxonomyFingerprint" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "classificationAssignmentRunId" TEXT;

CREATE INDEX "Complaint_classificationAssignmentSource_idx" ON "Complaint"("classificationAssignmentSource");
CREATE INDEX "Complaint_classificationAssignmentRunId_idx" ON "Complaint"("classificationAssignmentRunId");

-- Mark historically classified rows without provenance as LEGACY_UNKNOWN.
-- Unclassified rows keep NULL assignment source and remain backfill-eligible.
UPDATE "Complaint"
SET "classificationAssignmentSource" = 'LEGACY_UNKNOWN'
WHERE "classificationId" IS NOT NULL
  AND "classificationAssignmentSource" IS NULL;

CREATE TABLE "ClassificationBackfillRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "periodFrom" DATETIME NOT NULL,
    "periodToExclusive" DATETIME NOT NULL,
    "taxonomyFingerprint" TEXT NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "eligibleCount" INTEGER NOT NULL DEFAULT 0,
    "plannedCount" INTEGER NOT NULL DEFAULT 0,
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "batchSize" INTEGER NOT NULL DEFAULT 500,
    "actor" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "rollbackOfRunId" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "ClassificationBackfillRun_status_idx" ON "ClassificationBackfillRun"("status");
CREATE INDEX "ClassificationBackfillRun_manifestHash_idx" ON "ClassificationBackfillRun"("manifestHash");
CREATE INDEX "ClassificationBackfillRun_rollbackOfRunId_idx" ON "ClassificationBackfillRun"("rollbackOfRunId");
CREATE INDEX "ClassificationBackfillRun_startedAt_idx" ON "ClassificationBackfillRun"("startedAt");

CREATE TABLE "ClassificationBackfillItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "complaintId" TEXT NOT NULL,
    "expectedVersion" INTEGER NOT NULL,
    "appliedVersion" INTEGER,
    "previousClassificationId" TEXT,
    "targetClassificationId" TEXT NOT NULL,
    "targetClassificationNameSnapshot" TEXT NOT NULL,
    "previousAssignmentSource" TEXT,
    "targetAssignmentSource" TEXT NOT NULL,
    "previousAssignedAt" DATETIME,
    "previousAssignedBy" TEXT,
    "previousTaxonomyFingerprint" TEXT,
    "previousAssignmentRunId" TEXT,
    "sourceDetailHash" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "skipReason" TEXT,
    "appliedAt" DATETIME,
    "rolledBackAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClassificationBackfillItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ClassificationBackfillRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ClassificationBackfillItem_runId_complaintId_key" ON "ClassificationBackfillItem"("runId", "complaintId");
CREATE INDEX "ClassificationBackfillItem_runId_idx" ON "ClassificationBackfillItem"("runId");
CREATE INDEX "ClassificationBackfillItem_complaintId_idx" ON "ClassificationBackfillItem"("complaintId");
CREATE INDEX "ClassificationBackfillItem_result_idx" ON "ClassificationBackfillItem"("result");
CREATE INDEX "ClassificationBackfillItem_targetClassificationId_idx" ON "ClassificationBackfillItem"("targetClassificationId");
