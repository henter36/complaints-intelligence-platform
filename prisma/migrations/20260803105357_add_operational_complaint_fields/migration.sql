-- AlterTable
ALTER TABLE "Complaint" ADD COLUMN "actionDescription" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "actionTaken" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "closedBy" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "complaintCount" INTEGER;
ALTER TABLE "Complaint" ADD COLUMN "lastModifiedAt" DATETIME;
ALTER TABLE "Complaint" ADD COLUMN "lastUpdatedAt" DATETIME;
ALTER TABLE "Complaint" ADD COLUMN "lastUpdatedBy" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "wingCode" TEXT;
