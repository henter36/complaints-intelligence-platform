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

-- Backfill the registry conservatively from historical complaint values. The
-- normalization mirrors the application's established Arabic normalization for
-- the common formatting variants that SQLite can express without extensions.
WITH normalized_complaints AS (
    SELECT
        replace(replace(replace(trim("facility"), '  ', ' '), '  ', ' '), '  ', ' ') AS "displayName",
        replace(
            replace(
                replace(
                    replace(
                        replace(
                            replace(
                                replace(
                                    replace(replace(replace(trim("facility"), '  ', ' '), '  ', ' '), '  ', ' '),
                                    'إ', 'ا'
                                ),
                                'أ', 'ا'
                            ),
                            'آ', 'ا'
                        ),
                        'ى', 'ي'
                    ),
                    'ة', 'ه'
                ),
                'ـ', ''
            ),
            'َ', ''
        ) AS "normalizedName",
        NULLIF(replace(replace(replace(trim("region"), '  ', ' '), '  ', ' '), '  ', ' '), '') AS "cleanRegion"
    FROM "Complaint"
    WHERE "facility" IS NOT NULL
      AND trim("facility") <> ''
      AND trim("facility") <> 'غير محدد'
)
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
FROM normalized_complaints
WHERE length("normalizedName") > 0
GROUP BY "normalizedName";

-- CreateIndex
CREATE UNIQUE INDEX "Facility_name_key" ON "Facility"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Facility_normalizedName_key" ON "Facility"("normalizedName");

-- CreateIndex
CREATE INDEX "Facility_status_idx" ON "Facility"("status");

-- CreateIndex
CREATE INDEX "Facility_region_idx" ON "Facility"("region");
