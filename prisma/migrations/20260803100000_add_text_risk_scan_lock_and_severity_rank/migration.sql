-- Add activeLockKey to TextRiskScanRun for DB-level scan serialization
ALTER TABLE "TextRiskScanRun" ADD COLUMN "activeLockKey" TEXT;
CREATE UNIQUE INDEX "TextRiskScanRun_activeLockKey_key" ON "TextRiskScanRun"("activeLockKey");

-- Add severityRank to TextRiskSignal for correct numeric sort order
ALTER TABLE "TextRiskSignal" ADD COLUMN "severityRank" INTEGER NOT NULL DEFAULT 0;
UPDATE "TextRiskSignal" SET "severityRank" = CASE
  WHEN "severity" = 'CRITICAL' THEN 4
  WHEN "severity" = 'HIGH'     THEN 3
  WHEN "severity" = 'MEDIUM'   THEN 2
  ELSE 1
END;

-- Composite index for severity-ordered pagination
CREATE INDEX "TextRiskSignal_severityRank_createdAt_idx" ON "TextRiskSignal"("severityRank", "createdAt");
