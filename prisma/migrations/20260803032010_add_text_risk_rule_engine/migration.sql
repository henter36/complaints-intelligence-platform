-- CreateTable
CREATE TABLE "TextRiskSignal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "complaintId" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "confidenceScore" REAL NOT NULL,
    "certainty" TEXT NOT NULL,
    "isOngoing" BOOLEAN,
    "evidenceSpans" JSONB NOT NULL,
    "normalizedEvidenceHash" TEXT NOT NULL,
    "sourceTextHash" TEXT NOT NULL,
    "detectedBy" TEXT NOT NULL DEFAULT 'RULE',
    "reviewStatus" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "region" TEXT,
    "facility" TEXT,
    "department" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" DATETIME,
    "reviewReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TextRiskSignal_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "Complaint" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TextRiskScanRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "ruleVersion" TEXT NOT NULL,
    "importBatchId" TEXT,
    "totalComplaints" INTEGER NOT NULL DEFAULT 0,
    "processedComplaints" INTEGER NOT NULL DEFAULT 0,
    "matchedSignals" INTEGER NOT NULL DEFAULT 0,
    "lastComplaintId" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "failedAt" DATETIME,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "TextRiskSignal_complaintId_idx" ON "TextRiskSignal"("complaintId");

-- CreateIndex
CREATE INDEX "TextRiskSignal_signalType_idx" ON "TextRiskSignal"("signalType");

-- CreateIndex
CREATE INDEX "TextRiskSignal_severity_idx" ON "TextRiskSignal"("severity");

-- CreateIndex
CREATE INDEX "TextRiskSignal_reviewStatus_idx" ON "TextRiskSignal"("reviewStatus");

-- CreateIndex
CREATE INDEX "TextRiskSignal_ruleVersion_idx" ON "TextRiskSignal"("ruleVersion");

-- CreateIndex
CREATE INDEX "TextRiskSignal_createdAt_idx" ON "TextRiskSignal"("createdAt");

-- CreateIndex
CREATE INDEX "TextRiskSignal_region_idx" ON "TextRiskSignal"("region");

-- CreateIndex
CREATE INDEX "TextRiskSignal_facility_idx" ON "TextRiskSignal"("facility");

-- CreateIndex
CREATE INDEX "TextRiskSignal_department_idx" ON "TextRiskSignal"("department");

-- CreateIndex
CREATE UNIQUE INDEX "TextRiskSignal_complaintId_ruleId_ruleVersion_normalizedEvidenceHash_key" ON "TextRiskSignal"("complaintId", "ruleId", "ruleVersion", "normalizedEvidenceHash");

-- CreateIndex
CREATE INDEX "TextRiskScanRun_status_idx" ON "TextRiskScanRun"("status");

-- CreateIndex
CREATE INDEX "TextRiskScanRun_importBatchId_idx" ON "TextRiskScanRun"("importBatchId");

-- CreateIndex
CREATE INDEX "TextRiskScanRun_ruleVersion_idx" ON "TextRiskScanRun"("ruleVersion");

-- CreateIndex
CREATE INDEX "TextRiskScanRun_createdAt_idx" ON "TextRiskScanRun"("createdAt");
