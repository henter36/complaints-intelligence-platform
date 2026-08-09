import { FacilityStatus, type Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/audit/audit-log-service";
import { normalizeFacilityRegion } from "@/server/facilities/facility-name";

type FacilityManagementClient = Pick<typeof db, "$transaction" | "facility">;

export type FacilityListFilters = {
  search?: string;
  status?: FacilityStatus;
  region?: string;
};

export type FacilityManagementRow = {
  id: string;
  name: string;
  region: string | null;
  status: FacilityStatus;
  closedAt: Date | null;
};

export class FacilityManagementError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = "FacilityManagementError";
  }
}

export function parseFacilityStatus(value: string | null | undefined): FacilityStatus | undefined {
  if (!value) return undefined;
  if (value === FacilityStatus.ACTIVE || value === FacilityStatus.CLOSED) return value;
  throw new FacilityManagementError(
    "INVALID_FACILITY_STATUS",
    "حالة السجن غير صالحة.",
    400
  );
}

export function parseFacilityUpdatePayload(value: unknown): {
  status: FacilityStatus;
  closedAt: Date | null;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FacilityManagementError(
      "INVALID_FACILITY_STATUS",
      "حالة السجن غير صالحة.",
      400
    );
  }
  const payload = value as Record<string, unknown>;
  const status = typeof payload.status === "string"
    ? parseFacilityStatus(payload.status)
    : undefined;
  if (!status) {
    throw new FacilityManagementError(
      "INVALID_FACILITY_STATUS",
      "حالة السجن غير صالحة.",
      400
    );
  }

  if (status === FacilityStatus.ACTIVE) {
    return { status, closedAt: null };
  }
  if (payload.closedAt === null || payload.closedAt === undefined || payload.closedAt === "") {
    throw new FacilityManagementError(
      "MISSING_FACILITY_CLOSED_AT",
      "تاريخ الإغلاق مطلوب عند تحويل السجن إلى مقفل.",
      400
    );
  }
  if (typeof payload.closedAt !== "string" && !(payload.closedAt instanceof Date)) {
    throw new FacilityManagementError(
      "INVALID_FACILITY_CLOSED_AT",
      "تاريخ الإغلاق غير صالح.",
      400
    );
  }
  const closedAt = new Date(payload.closedAt);
  if (!Number.isFinite(closedAt.getTime())) {
    throw new FacilityManagementError(
      "INVALID_FACILITY_CLOSED_AT",
      "تاريخ الإغلاق غير صالح.",
      400
    );
  }
  return { status, closedAt };
}

export async function listManagedFacilities(
  filters: FacilityListFilters = {},
  client: FacilityManagementClient = db
): Promise<FacilityManagementRow[]> {
  const search = filters.search?.trim();
  const region = normalizeFacilityRegion(filters.region);
  return client.facility.findMany({
    where: {
      ...(search ? { name: { contains: search } } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(region ? { region } : {}),
    },
    select: { id: true, name: true, region: true, status: true, closedAt: true },
    orderBy: { name: "asc" },
  });
}

export async function updateFacilityOperationalStatus(
  facilityId: string,
  payload: unknown,
  actor: string,
  client: FacilityManagementClient = db
): Promise<FacilityManagementRow> {
  const update = parseFacilityUpdatePayload(payload);
  return client.$transaction(async (tx) => {
    const current = await tx.facility.findUnique({
      where: { id: facilityId },
      select: { id: true, name: true, region: true, status: true, closedAt: true },
    });
    if (!current) {
      throw new FacilityManagementError(
        "FACILITY_NOT_FOUND",
        "السجن غير موجود.",
        404
      );
    }

    const facility = await tx.facility.update({
      where: { id: facilityId },
      data: update,
      select: { id: true, name: true, region: true, status: true, closedAt: true },
    });
    await writeAuditLog(tx, {
      action: "FACILITY_OPERATIONAL_STATUS_UPDATED",
      entityType: "Facility",
      entityId: facilityId,
      actor,
      metadata: {
        previousStatus: current.status,
        previousClosedAt: current.closedAt?.toISOString() ?? null,
        status: facility.status,
        closedAt: facility.closedAt?.toISOString() ?? null,
      } satisfies Prisma.InputJsonObject,
    });
    return facility;
  });
}

export function facilityManagementErrorResponse(error: unknown): {
  status: number;
  body: { error: { code: string; message: string } };
} | null {
  return error instanceof FacilityManagementError
    ? {
        status: error.statusCode,
        body: { error: { code: error.code, message: error.message } },
      }
    : null;
}
