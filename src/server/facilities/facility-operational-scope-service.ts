import { FacilityStatus, type Prisma, type PrismaClient } from "@prisma/client";

import { db } from "@/lib/db";
import { normalizeFacilityName } from "@/server/facilities/facility-name";

type FacilityScopeClient = Pick<PrismaClient, "facility">;

export type OperationalFacility = {
  id: string;
  name: string;
  normalizedName: string;
  region: string | null;
  status: FacilityStatus;
  closedAt: Date | null;
};

export type FacilityOperationalRegistry = {
  facilities: OperationalFacility[];
  byNormalizedName: ReadonlyMap<string, OperationalFacility>;
};

export type OperationalPeriod = {
  from: Date;
  toExclusive: Date;
};

export function createFacilityOperationalRegistry(
  facilities: ReadonlyArray<OperationalFacility>
): FacilityOperationalRegistry {
  return {
    facilities: [...facilities],
    byNormalizedName: new Map(facilities.map((facility) => [facility.normalizedName, facility])),
  };
}

export async function loadFacilityOperationalRegistry(
  client: FacilityScopeClient = db
): Promise<FacilityOperationalRegistry> {
  // Supports rolling deployment and partial test clients generated before the
  // registry model existed. A real delegate with a missing table still throws.
  if (!client.facility) return createFacilityOperationalRegistry([]);
  const facilities = await client.facility.findMany({
    select: {
      id: true,
      name: true,
      normalizedName: true,
      region: true,
      status: true,
      closedAt: true,
    },
    orderBy: { name: "asc" },
  });
  return createFacilityOperationalRegistry(facilities);
}

export function findOperationalFacility(
  registry: FacilityOperationalRegistry,
  facilityName: string | null | undefined
): OperationalFacility | null {
  const key = normalizeFacilityName(facilityName);
  return key ? registry.byNormalizedName.get(key) ?? null : null;
}

/** Unknown/unregistered historical names remain eligible for migration parity. */
export function isFacilityCurrentlyEligible(
  registry: FacilityOperationalRegistry,
  facilityName: string | null | undefined
): boolean {
  const facility = findOperationalFacility(registry, facilityName);
  return !facility || facility.status === FacilityStatus.ACTIVE;
}

export function isFacilityEligibleAt(
  registry: FacilityOperationalRegistry,
  facilityName: string | null | undefined,
  measuredAt: Date
): boolean {
  const facility = findOperationalFacility(registry, facilityName);
  if (!facility || facility.status === FacilityStatus.ACTIVE) return true;
  // A legacy CLOSED row with no cutoff is excluded from current analytics by
  // isFacilityCurrentlyEligible(), but must not erase history at every instant.
  return facility.closedAt === null || measuredAt < facility.closedAt;
}

export function isFacilityEligibleForPeriod(
  registry: FacilityOperationalRegistry,
  facilityName: string | null | undefined,
  period: OperationalPeriod
): boolean {
  return isFacilityEligibleAt(registry, facilityName, period.from);
}

export function isFacilityEventEligible(
  registry: FacilityOperationalRegistry,
  facilityName: string | null | undefined,
  eventAt: Date
): boolean {
  return isFacilityEligibleAt(registry, facilityName, eventAt);
}

export function canonicalFacilityName(
  registry: FacilityOperationalRegistry,
  facilityName: string | null | undefined
): string | null {
  const facility = findOperationalFacility(registry, facilityName);
  return facility?.name ?? facilityName?.trim() ?? null;
}

export function eligibleRegistryFacilitiesForPeriod(
  registry: FacilityOperationalRegistry,
  period: OperationalPeriod
): OperationalFacility[] {
  return registry.facilities.filter((facility) =>
    isFacilityEligibleForPeriod(registry, facility.name, period)
  );
}

/**
 * Produces the central current-operational Prisma scope over the indexed
 * canonical key. Unknown/null keys remain eligible for migration parity.
 */
export async function buildCurrentOperationalFacilityWhere(
  client: FacilityScopeClient = db
): Promise<Prisma.ComplaintWhereInput> {
  if (!client.facility) return {};
  const closedFacilities = await client.facility.findMany({
    where: { status: FacilityStatus.CLOSED },
    select: { normalizedName: true },
  });
  if (closedFacilities.length === 0) return {};
  const closedKeys = closedFacilities.map((facility) => facility.normalizedName);

  return {
    OR: [
      { facilityNormalizedName: null },
      { facilityNormalizedName: { notIn: closedKeys } },
    ],
  };
}

export async function buildHistoricalOperationalFacilityWhere(
  client: FacilityScopeClient = db
): Promise<Prisma.ComplaintWhereInput> {
  if (!client.facility) return {};
  const closedFacilities = await client.facility.findMany({
    where: { status: FacilityStatus.CLOSED, closedAt: { not: null } },
    select: { normalizedName: true, closedAt: true },
  });
  if (closedFacilities.length === 0) return {};
  const keysByCutoff = new Map<number, string[]>();
  for (const facility of closedFacilities) {
    if (!facility.closedAt) continue;
    const cutoff = facility.closedAt.getTime();
    keysByCutoff.set(cutoff, [
      ...(keysByCutoff.get(cutoff) ?? []),
      facility.normalizedName,
    ]);
  }
  const closedKeys = closedFacilities.map((facility) => facility.normalizedName);

  return {
    OR: [
      { facilityNormalizedName: null },
      { facilityNormalizedName: { notIn: closedKeys } },
      ...[...keysByCutoff.entries()].map(([cutoff, keys]) => ({
        AND: [
          { facilityNormalizedName: { in: keys } },
          {
            OR: [
              { complaintDate: { lt: new Date(cutoff) } },
              { complaintDate: null, receivedAt: { lt: new Date(cutoff) } },
            ],
          },
        ],
      })),
    ],
  };
}

export async function buildHistoricalFacilityClosureEventWhere(
  client: FacilityScopeClient = db
): Promise<Prisma.ComplaintStatusHistoryWhereInput> {
  if (!client.facility) return {};
  const closedFacilities = await client.facility.findMany({
    where: { status: FacilityStatus.CLOSED, closedAt: { not: null } },
    select: { normalizedName: true, closedAt: true },
  });
  if (closedFacilities.length === 0) return {};
  const keysByCutoff = new Map<number, string[]>();
  for (const facility of closedFacilities) {
    if (!facility.closedAt) continue;
    const cutoff = facility.closedAt.getTime();
    keysByCutoff.set(cutoff, [
      ...(keysByCutoff.get(cutoff) ?? []),
      facility.normalizedName,
    ]);
  }
  const closedKeys = closedFacilities.map((facility) => facility.normalizedName);

  return {
    OR: [
      { complaint: { is: { facilityNormalizedName: null } } },
      { complaint: { is: { facilityNormalizedName: { notIn: closedKeys } } } },
      ...[...keysByCutoff.entries()].map(([cutoff, keys]) => ({
        AND: [
          { changedAt: { lt: new Date(cutoff) } },
          { complaint: { is: { facilityNormalizedName: { in: keys } } } },
        ],
      })),
    ],
  };
}

export function combineComplaintWhere(
  base: Prisma.ComplaintWhereInput,
  facilityScope: Prisma.ComplaintWhereInput
): Prisma.ComplaintWhereInput {
  return Object.keys(facilityScope).length === 0
    ? base
    : { AND: [base, facilityScope] };
}
