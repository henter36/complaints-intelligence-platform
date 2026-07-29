-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "description" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Classification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "categoryId" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT '#64748b',
    "keywords" JSONB,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Classification_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Complaint" (
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

-- CreateTable
CREATE TABLE "ComplaintStatusHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "complaintId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL DEFAULT 'system',
    "reason" TEXT,
    "importBatchId" TEXT,
    CONSTRAINT "ComplaintStatusHistory_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "Complaint" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ComplaintStatusHistory_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fileName" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "mimeType" TEXT,
    "periodType" TEXT NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "newRows" INTEGER NOT NULL DEFAULT 0,
    "updatedRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "rejectedRows" INTEGER NOT NULL DEFAULT 0,
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validatedAt" DATETIME,
    "confirmedAt" DATETIME,
    "rolledBackAt" DATETIME,
    "createdBy" TEXT NOT NULL DEFAULT 'single-admin',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ImportBatchRow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "importBatchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "rawData" JSONB NOT NULL,
    "normalizedData" JSONB,
    "externalId" TEXT,
    "action" TEXT NOT NULL DEFAULT 'NEW',
    "validationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "validationErrors" JSONB,
    "validationWarnings" JSONB,
    "matchedComplaintId" TEXT,
    "createdComplaintId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ImportBatchRow_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ImportBatchRow_matchedComplaintId_fkey" FOREIGN KEY ("matchedComplaintId") REFERENCES "Complaint" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ImportBatchRow_createdComplaintId_fkey" FOREIGN KEY ("createdComplaintId") REFERENCES "Complaint" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB
);

-- CreateTable
CREATE TABLE "ReportTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Category_nameAr_key" ON "Category"("nameAr");

-- CreateIndex
CREATE INDEX "Category_isActive_isDeleted_idx" ON "Category"("isActive", "isDeleted");

-- CreateIndex
CREATE INDEX "Category_displayOrder_idx" ON "Category"("displayOrder");

-- CreateIndex
CREATE INDEX "Classification_categoryId_idx" ON "Classification"("categoryId");

-- CreateIndex
CREATE INDEX "Classification_isActive_isDeleted_idx" ON "Classification"("isActive", "isDeleted");

-- CreateIndex
CREATE INDEX "Classification_displayOrder_idx" ON "Classification"("displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Classification_categoryId_nameAr_key" ON "Classification"("categoryId", "nameAr");

-- CreateIndex
CREATE UNIQUE INDEX "Complaint_externalId_key" ON "Complaint"("externalId");

-- CreateIndex
CREATE INDEX "Complaint_sourceReference_idx" ON "Complaint"("sourceReference");

-- CreateIndex
CREATE INDEX "Complaint_status_idx" ON "Complaint"("status");

-- CreateIndex
CREATE INDEX "Complaint_dueDate_idx" ON "Complaint"("dueDate");

-- CreateIndex
CREATE INDEX "Complaint_createdAt_idx" ON "Complaint"("createdAt");

-- CreateIndex
CREATE INDEX "Complaint_isDeleted_idx" ON "Complaint"("isDeleted");

-- CreateIndex
CREATE INDEX "Complaint_region_idx" ON "Complaint"("region");

-- CreateIndex
CREATE INDEX "Complaint_department_idx" ON "Complaint"("department");

-- CreateIndex
CREATE INDEX "Complaint_classificationId_idx" ON "Complaint"("classificationId");

-- CreateIndex
CREATE INDEX "Complaint_sourceReference_complaintDate_idx" ON "Complaint"("sourceReference", "complaintDate");

-- CreateIndex
CREATE INDEX "ComplaintStatusHistory_complaintId_idx" ON "ComplaintStatusHistory"("complaintId");

-- CreateIndex
CREATE INDEX "ComplaintStatusHistory_importBatchId_idx" ON "ComplaintStatusHistory"("importBatchId");

-- CreateIndex
CREATE INDEX "ImportBatch_fileHash_idx" ON "ImportBatch"("fileHash");

-- CreateIndex
CREATE INDEX "ImportBatch_status_idx" ON "ImportBatch"("status");

-- CreateIndex
CREATE INDEX "ImportBatch_createdAt_idx" ON "ImportBatch"("createdAt");

-- CreateIndex
CREATE INDEX "ImportBatchRow_importBatchId_idx" ON "ImportBatchRow"("importBatchId");

-- CreateIndex
CREATE INDEX "ImportBatchRow_matchedComplaintId_idx" ON "ImportBatchRow"("matchedComplaintId");

-- CreateIndex
CREATE INDEX "ImportBatchRow_createdComplaintId_idx" ON "ImportBatchRow"("createdComplaintId");

-- CreateIndex
CREATE INDEX "ImportBatchRow_externalId_idx" ON "ImportBatchRow"("externalId");

-- CreateIndex
CREATE INDEX "ImportBatchRow_action_idx" ON "ImportBatchRow"("action");

-- CreateIndex
CREATE INDEX "ImportBatchRow_validationStatus_idx" ON "ImportBatchRow"("validationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "ImportBatchRow_importBatchId_rowNumber_key" ON "ImportBatchRow"("importBatchId", "rowNumber");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_occurredAt_idx" ON "AuditLog"("occurredAt");
