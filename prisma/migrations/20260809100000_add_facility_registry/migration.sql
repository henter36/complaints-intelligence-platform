-- Add a database-filterable canonical identity while preserving the historical
-- display value in Complaint.facility.
ALTER TABLE "Complaint" ADD COLUMN "facilityNormalizedName" TEXT;

-- Persist the post-confirmation registry synchronization intent so a failed
-- best-effort attempt can be retried without reopening the import workflow.
ALTER TABLE "ImportBatch" ADD COLUMN "facilitySyncStatus" TEXT;
ALTER TABLE "ImportBatch" ADD COLUMN "facilitySyncAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ImportBatch" ADD COLUMN "facilitySyncError" TEXT;
ALTER TABLE "ImportBatch" ADD COLUMN "facilitySyncedAt" DATETIME;

-- CreateTable
CREATE TABLE "Facility" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "region" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "closedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Backfill canonical keys with the same semantics as normalizeFacilityName():
-- normalize CR/LF and horizontal whitespace, collapse repeated spaces, remove
-- Arabic diacritics/tatweel, normalize Alef/Ya/Ta Marbuta variants, and fold
-- ASCII case. A temporary table lets the exact same calculated key feed both
-- Complaint and Facility without duplicating expressions.
CREATE TEMP TABLE "__FacilityCanonicalBackfill" (
    "complaintId" TEXT NOT NULL PRIMARY KEY,
    "displayName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "cleanRegion" TEXT
);

WITH RECURSIVE whitespace_normalized AS (
    SELECT
        "id" AS "complaintId",
        trim(
            replace(replace(replace(replace(replace("facility", char(9), ' '), char(10), ' '), char(11), ' '), char(12), ' '), char(13), ' ')
        ) AS "displayName",
        NULLIF(trim(replace(replace(replace(replace(replace("region", char(9), ' '), char(10), ' '), char(11), ' '), char(12), ' '), char(13), ' ')), '') AS "cleanRegion"
    FROM "Complaint"
    WHERE "facility" IS NOT NULL

    UNION ALL

    SELECT
        "complaintId",
        replace("displayName", '  ', ' '),
        CASE WHEN "cleanRegion" IS NULL THEN NULL ELSE replace("cleanRegion", '  ', ' ') END
    FROM whitespace_normalized
    WHERE instr("displayName", '  ') > 0
       OR instr(coalesce("cleanRegion", ''), '  ') > 0
), collapsed AS (
    SELECT "complaintId", "displayName", "cleanRegion"
    FROM whitespace_normalized
    WHERE instr("displayName", '  ') = 0
      AND instr(coalesce("cleanRegion", ''), '  ') = 0
), normalized_complaints AS (
    SELECT
        "complaintId",
        "displayName",
        lower(
          replace(replace(replace(replace(replace(replace(replace(replace(
          replace(replace(replace(replace(replace(replace(replace(replace(
          replace(replace(replace(replace(replace(replace(replace(replace(
          replace(replace(replace(replace("displayName",
            char(1611), ''), char(1612), ''), char(1613), ''), char(1614), ''),
            char(1615), ''), char(1616), ''), char(1617), ''), char(1618), ''),
            char(1619), ''), char(1620), ''), char(1621), ''), char(1622), ''),
            char(1623), ''), char(1624), ''), char(1625), ''), char(1626), ''),
            char(1627), ''), char(1628), ''), char(1629), ''), char(1630), ''),
            char(1631), ''), char(1648), ''), 'ـ', ''), 'إ', 'ا'), 'أ', 'ا'),
            'آ', 'ا'), 'ى', 'ي'), 'ة', 'ه')
        ) AS "normalizedName",
        "cleanRegion"
    FROM collapsed
)
INSERT INTO "__FacilityCanonicalBackfill" ("complaintId", "displayName", "normalizedName", "cleanRegion")
SELECT "complaintId", "displayName", "normalizedName", "cleanRegion"
FROM normalized_complaints
WHERE length("normalizedName") > 0
  AND "normalizedName" <> 'غير محدد';

UPDATE "Complaint"
SET "facilityNormalizedName" = (
    SELECT "normalizedName"
    FROM "__FacilityCanonicalBackfill"
    WHERE "complaintId" = "Complaint"."id"
);

INSERT INTO "Facility" (
    "id",
    "name",
    "normalizedName",
    "region",
    "status",
    "closedAt",
    "createdAt",
    "updatedAt"
)
SELECT
    'facility_' || lower(hex(randomblob(12))),
    min("displayName"),
    "normalizedName",
    CASE
        WHEN count(DISTINCT "cleanRegion") = 1 THEN max("cleanRegion")
        ELSE NULL
    END,
    'ACTIVE',
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "__FacilityCanonicalBackfill"
GROUP BY "normalizedName";

DROP TABLE "__FacilityCanonicalBackfill";

-- The registry backfill covers all complaints belonging to already-confirmed
-- batches, so those legacy batches start in a completed synchronization state.
UPDATE "ImportBatch"
SET "facilitySyncStatus" = 'COMPLETED',
    "facilitySyncedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'CONFIRMED';

-- CreateIndex
CREATE UNIQUE INDEX "Facility_name_key" ON "Facility"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Facility_normalizedName_key" ON "Facility"("normalizedName");

-- CreateIndex
CREATE INDEX "Facility_status_idx" ON "Facility"("status");

-- CreateIndex
CREATE INDEX "Facility_region_idx" ON "Facility"("region");

-- CreateIndex
CREATE INDEX "Complaint_facilityNormalizedName_idx" ON "Complaint"("facilityNormalizedName");
