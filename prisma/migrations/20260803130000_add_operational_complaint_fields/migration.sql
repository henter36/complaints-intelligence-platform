-- Add operational import fields to the Complaint table.
-- These fields capture source-system metadata imported from Excel.
ALTER TABLE "Complaint" ADD COLUMN "actionTaken" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "actionDescription" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "sourceClosedBy" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "wingCode" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "sourceUpdatedAt" DATETIME;
ALTER TABLE "Complaint" ADD COLUMN "sourceModifiedAt" DATETIME;
ALTER TABLE "Complaint" ADD COLUMN "sourceUpdatedBy" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "sourceOrigin" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "sourceStatus" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "sourceDetail" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "sourceActionStatus" TEXT;
