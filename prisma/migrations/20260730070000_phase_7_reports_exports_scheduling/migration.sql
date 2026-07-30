-- CreateTable
CREATE TABLE "ReportSchedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportTemplateId" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "timeOfDay" TEXT NOT NULL,
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Riyadh',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" DATETIME NOT NULL,
    "lastRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ReportSchedule_reportTemplateId_fkey" FOREIGN KEY ("reportTemplateId") REFERENCES "ReportTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReportRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportTemplateId" TEXT,
    "reportType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL DEFAULT 'single-admin',
    "scheduledFor" DATETIME,
    "idempotencyKey" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "failedAt" DATETIME,
    "filtersSnapshot" JSONB NOT NULL,
    "optionsSnapshot" JSONB NOT NULL,
    "resultSummary" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReportRun_reportTemplateId_fkey" FOREIGN KEY ("reportTemplateId") REFERENCES "ReportTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReportArtifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportRunId" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "ReportArtifact_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "ReportRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ReportTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "reportType" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "options" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL DEFAULT 'single-admin',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastRunAt" DATETIME
);
INSERT INTO "new_ReportTemplate" ("createdAt", "createdBy", "id", "name", "updatedAt") SELECT "createdAt", coalesce("createdBy", 'single-admin') AS "createdBy", "id", "name", "updatedAt" FROM "ReportTemplate";
DROP TABLE "ReportTemplate";
ALTER TABLE "new_ReportTemplate" RENAME TO "ReportTemplate";
CREATE INDEX "ReportTemplate_isActive_idx" ON "ReportTemplate"("isActive");
CREATE INDEX "ReportTemplate_reportType_idx" ON "ReportTemplate"("reportType");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ReportSchedule_isEnabled_idx" ON "ReportSchedule"("isEnabled");

-- CreateIndex
CREATE INDEX "ReportSchedule_nextRunAt_idx" ON "ReportSchedule"("nextRunAt");

-- CreateIndex
CREATE INDEX "ReportSchedule_reportTemplateId_idx" ON "ReportSchedule"("reportTemplateId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportRun_idempotencyKey_key" ON "ReportRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ReportRun_status_idx" ON "ReportRun"("status");

-- CreateIndex
CREATE INDEX "ReportRun_createdAt_idx" ON "ReportRun"("createdAt");

-- CreateIndex
CREATE INDEX "ReportRun_reportTemplateId_idx" ON "ReportRun"("reportTemplateId");

-- CreateIndex
CREATE INDEX "ReportArtifact_reportRunId_idx" ON "ReportArtifact"("reportRunId");

-- CreateIndex
CREATE INDEX "ReportArtifact_expiresAt_idx" ON "ReportArtifact"("expiresAt");

-- CreateIndex
CREATE INDEX "ReportArtifact_deletedAt_idx" ON "ReportArtifact"("deletedAt");

