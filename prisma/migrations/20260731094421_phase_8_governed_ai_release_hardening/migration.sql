-- CreateTable
CREATE TABLE "AiAnalysisRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL DEFAULT 'single-admin',
    "filtersSnapshot" JSONB NOT NULL,
    "inputSummary" JSONB NOT NULL,
    "model" TEXT,
    "provider" TEXT,
    "promptVersion" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "failedAt" DATETIME,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME
);

-- CreateTable
CREATE TABLE "AiAnalysisResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisRunId" TEXT NOT NULL,
    "resultJson" JSONB NOT NULL,
    "resultText" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    CONSTRAINT "AiAnalysisResult_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AiAnalysisRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiFeedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisRunId" TEXT NOT NULL,
    "rating" TEXT NOT NULL,
    "comment" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiFeedback_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AiAnalysisRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AiAnalysisRun_status_idx" ON "AiAnalysisRun"("status");

-- CreateIndex
CREATE INDEX "AiAnalysisRun_analysisType_idx" ON "AiAnalysisRun"("analysisType");

-- CreateIndex
CREATE INDEX "AiAnalysisRun_createdAt_idx" ON "AiAnalysisRun"("createdAt");

-- CreateIndex
CREATE INDEX "AiAnalysisRun_expiresAt_idx" ON "AiAnalysisRun"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiAnalysisResult_analysisRunId_key" ON "AiAnalysisResult"("analysisRunId");

-- CreateIndex
CREATE INDEX "AiAnalysisResult_deletedAt_idx" ON "AiAnalysisResult"("deletedAt");

-- CreateIndex
CREATE INDEX "AiFeedback_analysisRunId_idx" ON "AiFeedback"("analysisRunId");
