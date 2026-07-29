-- Phase 5 adds transactional import confirmation, rollback snapshots, and row application markers.
ALTER TABLE "ImportBatch" ADD COLUMN "confirmationFailureCode" TEXT;
ALTER TABLE "ImportBatch" ADD COLUMN "rollbackFailureCode" TEXT;
ALTER TABLE "ImportBatch" ADD COLUMN "rollbackReason" TEXT;
ALTER TABLE "ImportBatch" ADD COLUMN "appliedCreatedRows" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ImportBatch" ADD COLUMN "appliedUpdatedRows" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ImportBatchRow" ADD COLUMN "matchedComplaintVersion" INTEGER;
ALTER TABLE "ImportBatchRow" ADD COLUMN "appliedAt" DATETIME;
ALTER TABLE "ImportBatchRow" ADD COLUMN "rolledBackAt" DATETIME;

CREATE TABLE "ImportChangeSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "importBatchId" TEXT NOT NULL,
  "importBatchRowId" TEXT NOT NULL,
  "complaintId" TEXT NOT NULL,
  "changeType" TEXT NOT NULL,
  "beforeData" JSONB,
  "afterData" JSONB NOT NULL,
  "versionBefore" INTEGER,
  "versionAfter" INTEGER NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImportChangeSnapshot_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ImportChangeSnapshot_importBatchRowId_fkey" FOREIGN KEY ("importBatchRowId") REFERENCES "ImportBatchRow" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ImportChangeSnapshot_importBatchRowId_key" ON "ImportChangeSnapshot"("importBatchRowId");
CREATE INDEX "ImportChangeSnapshot_importBatchId_idx" ON "ImportChangeSnapshot"("importBatchId");
CREATE INDEX "ImportChangeSnapshot_complaintId_idx" ON "ImportChangeSnapshot"("complaintId");
CREATE INDEX "ImportChangeSnapshot_changeType_idx" ON "ImportChangeSnapshot"("changeType");
CREATE INDEX "ImportBatchRow_appliedAt_idx" ON "ImportBatchRow"("appliedAt");
