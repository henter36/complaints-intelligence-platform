import {
  FacilityStatus,
  FacilitySyncStatus,
  ImportBatchStatus,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";

import { db } from "@/lib/db";
import {
  normalizeFacilityDisplayName,
  normalizeFacilityName,
  normalizeFacilityRegion,
} from "@/server/facilities/facility-name";

type FacilityRegistryClient = Pick<PrismaClient, "complaint" | "facility" | "importBatchRow">;
type FacilitySyncClient = FacilityRegistryClient & Pick<PrismaClient, "importBatch">;

export class FacilityRegistrySyncError extends Error {
  constructor(
    readonly code: "IMPORT_BATCH_NOT_FOUND" | "IMPORT_BATCH_NOT_CONFIRMED" | "FACILITY_SYNC_FAILED",
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "FacilityRegistrySyncError";
  }
}

export type FacilitySyncResult = {
  batchId: string;
  status: typeof FacilitySyncStatus.COMPLETED;
  syncedFacilities: number;
  attempts: number;
  syncedAt: string;
};

export type FacilityRegistryWarning = {
  code: "FACILITY_REGION_CONFLICT";
  facilityName: string;
  regions: string[];
};

export type FacilityBackfillResult = {
  discovered: number;
  createdOrMatched: number;
  warnings: FacilityRegistryWarning[];
};

type FacilityCandidate = {
  displayCounts: Map<string, number>;
  regionCounts: Map<string, number>;
};

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function mostFrequentValue(counts: Map<string, number>): string {
  return [...counts.entries()]
    .sort(([leftValue, leftCount], [rightValue, rightCount]) =>
      rightCount - leftCount || leftValue.localeCompare(rightValue, "ar")
    )[0]![0];
}

function collectCandidates(
  rows: ReadonlyArray<{ facility: unknown; region: unknown }>
): Map<string, FacilityCandidate> {
  const candidates = new Map<string, FacilityCandidate>();
  for (const row of rows) {
    const name = normalizeFacilityDisplayName(row.facility);
    const normalizedName = normalizeFacilityName(row.facility);
    if (!name || !normalizedName) continue;

    const candidate = candidates.get(normalizedName) ?? {
      displayCounts: new Map<string, number>(),
      regionCounts: new Map<string, number>(),
    };
    increment(candidate.displayCounts, name);
    const region = normalizeFacilityRegion(row.region);
    if (region) increment(candidate.regionCounts, region);
    candidates.set(normalizedName, candidate);
  }
  return candidates;
}

async function upsertCandidate(
  client: FacilityRegistryClient,
  normalizedName: string,
  candidate: FacilityCandidate
): Promise<void> {
  const name = mostFrequentValue(candidate.displayCounts);
  const region = candidate.regionCounts.size === 1
    ? [...candidate.regionCounts.keys()][0]!
    : null;

  await client.facility.upsert({
    where: { normalizedName },
    create: {
      name,
      normalizedName,
      region,
      status: FacilityStatus.ACTIVE,
    },
    // Registry status is authoritative. Import/backfill never reopens a facility
    // and never guesses a region after conflicting historical evidence.
    update: {},
  });
}

export async function backfillFacilityRegistry(
  client: FacilityRegistryClient = db
): Promise<FacilityBackfillResult> {
  const rows = await client.complaint.findMany({
    select: { facility: true, region: true },
  });
  const candidates = collectCandidates(rows);
  const warnings: FacilityRegistryWarning[] = [];

  for (const [normalizedName, candidate] of candidates) {
    if (candidate.regionCounts.size > 1) {
      warnings.push({
        code: "FACILITY_REGION_CONFLICT",
        facilityName: mostFrequentValue(candidate.displayCounts),
        regions: [...candidate.regionCounts.keys()].sort((left, right) => left.localeCompare(right, "ar")),
      });
    }
    await upsertCandidate(client, normalizedName, candidate);
  }

  return {
    discovered: candidates.size,
    createdOrMatched: candidates.size,
    warnings,
  };
}

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Idempotent registry upsert used by the durable post-confirmation retry flow.
 * This function mutates only Facility rows; its caller owns persisted attempt
 * state and deliberately keeps the complaint import transaction independent.
 */
export async function syncFacilitiesFromImportBatch(
  importBatchId: string,
  client: FacilityRegistryClient = db
): Promise<number> {
  const rows = await client.importBatchRow.findMany({
    where: { importBatchId },
    select: { normalizedData: true },
  });
  const candidates = collectCandidates(
    rows.flatMap((row) => {
      const normalizedData = jsonObject(row.normalizedData);
      return normalizedData
        ? [{ facility: normalizedData.facility, region: normalizedData.region }]
        : [];
    })
  );

  for (const [normalizedName, candidate] of candidates) {
    await upsertCandidate(client, normalizedName, candidate);
  }
  return candidates.size;
}

function boundedSyncError(error: unknown): string {
  const message = error instanceof Error ? error.message : "UNKNOWN";
  return message.replaceAll(/\s+/g, " ").trim().slice(0, 500) || "UNKNOWN";
}

/**
 * Runs (or reruns) registry synchronization for an already-confirmed import.
 * The persisted PENDING/FAILED/COMPLETED state is independent of ImportBatch.status,
 * and the underlying canonical upserts make repeated calls safe.
 */
export async function retryFacilitySyncForConfirmedBatch(
  batchId: string,
  client: FacilitySyncClient = db
): Promise<FacilitySyncResult> {
  const batch = await client.importBatch.findUnique({
    where: { id: batchId },
    select: {
      id: true,
      status: true,
      facilitySyncStatus: true,
      facilitySyncAttempts: true,
      facilitySyncedAt: true,
    },
  });
  if (!batch) {
    throw new FacilityRegistrySyncError("IMPORT_BATCH_NOT_FOUND", "دفعة الاستيراد غير موجودة", 404);
  }
  if (batch.status !== ImportBatchStatus.CONFIRMED) {
    throw new FacilityRegistrySyncError(
      "IMPORT_BATCH_NOT_CONFIRMED",
      "لا يمكن مزامنة السجون قبل تأكيد دفعة الاستيراد",
      409
    );
  }
  if (
    batch.facilitySyncStatus === FacilitySyncStatus.COMPLETED
    && batch.facilitySyncedAt !== null
  ) {
    return {
      batchId,
      status: FacilitySyncStatus.COMPLETED,
      syncedFacilities: 0,
      attempts: batch.facilitySyncAttempts,
      syncedAt: batch.facilitySyncedAt.toISOString(),
    };
  }

  const pending = await client.importBatch.update({
    where: { id: batchId },
    data: {
      facilitySyncStatus: FacilitySyncStatus.PENDING,
      facilitySyncAttempts: { increment: 1 },
      facilitySyncError: null,
      facilitySyncedAt: null,
    },
    select: { facilitySyncAttempts: true },
  });

  try {
    const syncedFacilities = await syncFacilitiesFromImportBatch(batchId, client);
    const syncedAt = new Date();
    await client.importBatch.update({
      where: { id: batchId },
      data: {
        facilitySyncStatus: FacilitySyncStatus.COMPLETED,
        facilitySyncError: null,
        facilitySyncedAt: syncedAt,
      },
    });
    return {
      batchId,
      status: FacilitySyncStatus.COMPLETED,
      syncedFacilities,
      attempts: pending.facilitySyncAttempts,
      syncedAt: syncedAt.toISOString(),
    };
  } catch (error) {
    await client.importBatch.update({
      where: { id: batchId },
      data: {
        facilitySyncStatus: FacilitySyncStatus.FAILED,
        facilitySyncError: boundedSyncError(error),
        facilitySyncedAt: null,
      },
    });
    throw new FacilityRegistrySyncError(
      "FACILITY_SYNC_FAILED",
      "تعذرت مزامنة السجون ويمكن إعادة المحاولة",
      500
    );
  }
}
