-- Phase 4 stores secure Excel upload metadata and persisted validation preview state.
ALTER TABLE "ImportBatch" ADD COLUMN "warningRows" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ImportBatch" ADD COLUMN "noChangeRows" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ImportBatch" ADD COLUMN "processingStartedAt" DATETIME;
ALTER TABLE "ImportBatch" ADD COLUMN "processingCompletedAt" DATETIME;
ALTER TABLE "ImportBatch" ADD COLUMN "failureCode" TEXT;
ALTER TABLE "ImportBatch" ADD COLUMN "storageKey" TEXT;
ALTER TABLE "ImportBatch" ADD COLUMN "selectedSheet" TEXT;
ALTER TABLE "ImportBatch" ADD COLUMN "columnMapping" JSONB;

CREATE INDEX "ImportBatch_storageKey_idx" ON "ImportBatch"("storageKey");
