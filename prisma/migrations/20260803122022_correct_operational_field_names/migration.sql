/*
  Warnings:

  - You are about to drop the column `closedBy` on the `Complaint` table. All the data in the column will be lost.
  - You are about to drop the column `complaintCount` on the `Complaint` table. All the data in the column will be lost.
  - You are about to drop the column `lastModifiedAt` on the `Complaint` table. All the data in the column will be lost.
  - You are about to drop the column `lastUpdatedAt` on the `Complaint` table. All the data in the column will be lost.
  - You are about to drop the column `lastUpdatedBy` on the `Complaint` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Complaint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalId" TEXT,
    "sourceReference" TEXT,
    "complaintDate" DATETIME,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" DATETIME,
    "closedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "complainantName" TEXT,
    "complainantIdentifier" TEXT,
    "complainantPhone" TEXT,
    "region" TEXT,
    "facility" TEXT,
    "department" TEXT,
    "categoryId" TEXT,
    "classificationId" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "channel" TEXT,
    "resolution" TEXT,
    "actionTaken" TEXT,
    "actionDescription" TEXT,
    "sourceClosedBy" TEXT,
    "wingCode" TEXT,
    "sourceUpdatedAt" DATETIME,
    "sourceModifiedAt" DATETIME,
    "sourceUpdatedBy" TEXT,
    "sourceOrigin" TEXT,
    "sourceStatus" TEXT,
    "sourceDetail" TEXT,
    "sourceActionStatus" TEXT,
    "firstActionAt" DATETIME,
    "processingStartedAt" DATETIME,
    "delayReason" TEXT,
    "isRepeated" BOOLEAN NOT NULL DEFAULT false,
    "isValidated" BOOLEAN NOT NULL DEFAULT false,
    "beneficiarySatisfaction" INTEGER,
    "aiClassification" TEXT,
    "aiConfidence" REAL,
    "aiReasoning" TEXT,
    "aiSentiment" TEXT,
    "aiSeverityScore" REAL,
    "aiSummary" TEXT,
    "aiAnalyzedAt" DATETIME,
    "isPotentialDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "duplicateOfId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" DATETIME,
    "importBatchId" TEXT,
    CONSTRAINT "Complaint_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Complaint_classificationId_fkey" FOREIGN KEY ("classificationId") REFERENCES "Classification" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Complaint_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Complaint" ("actionDescription", "actionTaken", "aiAnalyzedAt", "aiClassification", "aiConfidence", "aiReasoning", "aiSentiment", "aiSeverityScore", "aiSummary", "beneficiarySatisfaction", "categoryId", "channel", "classificationId", "closedAt", "complainantIdentifier", "complainantName", "complainantPhone", "complaintDate", "createdAt", "delayReason", "deletedAt", "department", "description", "dueDate", "duplicateOfId", "externalId", "facility", "firstActionAt", "id", "importBatchId", "isDeleted", "isPotentialDuplicate", "isRepeated", "isValidated", "priority", "processingStartedAt", "receivedAt", "region", "resolution", "severity", "sourceReference", "status", "subject", "updatedAt", "version", "wingCode") SELECT "actionDescription", "actionTaken", "aiAnalyzedAt", "aiClassification", "aiConfidence", "aiReasoning", "aiSentiment", "aiSeverityScore", "aiSummary", "beneficiarySatisfaction", "categoryId", "channel", "classificationId", "closedAt", "complainantIdentifier", "complainantName", "complainantPhone", "complaintDate", "createdAt", "delayReason", "deletedAt", "department", "description", "dueDate", "duplicateOfId", "externalId", "facility", "firstActionAt", "id", "importBatchId", "isDeleted", "isPotentialDuplicate", "isRepeated", "isValidated", "priority", "processingStartedAt", "receivedAt", "region", "resolution", "severity", "sourceReference", "status", "subject", "updatedAt", "version", "wingCode" FROM "Complaint";
DROP TABLE "Complaint";
ALTER TABLE "new_Complaint" RENAME TO "Complaint";
CREATE UNIQUE INDEX "Complaint_externalId_key" ON "Complaint"("externalId");
CREATE INDEX "Complaint_sourceReference_idx" ON "Complaint"("sourceReference");
CREATE INDEX "Complaint_status_idx" ON "Complaint"("status");
CREATE INDEX "Complaint_dueDate_idx" ON "Complaint"("dueDate");
CREATE INDEX "Complaint_createdAt_idx" ON "Complaint"("createdAt");
CREATE INDEX "Complaint_isDeleted_idx" ON "Complaint"("isDeleted");
CREATE INDEX "Complaint_region_idx" ON "Complaint"("region");
CREATE INDEX "Complaint_department_idx" ON "Complaint"("department");
CREATE INDEX "Complaint_classificationId_idx" ON "Complaint"("classificationId");
CREATE INDEX "Complaint_sourceReference_complaintDate_idx" ON "Complaint"("sourceReference", "complaintDate");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
