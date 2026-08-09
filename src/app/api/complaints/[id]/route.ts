import { NextRequest, NextResponse } from "next/server";
import { ComplaintPriority, type Complaint, type Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/audit/audit-log-service";
import {
  buildClassificationAssignmentMetadata,
  buildManualClearClassificationMetadata,
  CLASSIFICATION_ASSIGNMENT_SOURCES,
} from "@/server/classifications/classification-assignment";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { buildComplaintTiming } from "@/server/complaints/complaint-timing";
import { normalizeFacilityName } from "@/server/facilities/facility-name";

type RouteContext = {
  params: Promise<{ id: string }>;
};

const nullableString = z.string().trim().max(500).nullable().optional();
const dateInput = z.string().datetime().nullable().optional();
const updateSchema = z.object({
  expectedVersion: z.number().int().positive(),
  sourceReference: nullableString,
  complaintDate: dateInput,
  receivedAt: z.string().datetime().optional(),
  dueDate: dateInput,
  subject: z.string().trim().min(1).max(300).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  region: nullableString,
  facility: nullableString,
  department: nullableString,
  categoryId: z.string().trim().nullable().optional(),
  classificationId: z.string().trim().nullable().optional(),
  priority: z.enum(ComplaintPriority).optional(),
  channel: nullableString,
  resolution: z.string().trim().max(5000).nullable().optional(),
  complainantName: nullableString,
  complainantIdentifier: nullableString,
  complainantPhone: nullableString,
}).strict();

const COMPLAINT_DETAIL_SELECT = {
  id: true,
  externalId: true,
  sourceReference: true,
  complaintDate: true,
  receivedAt: true,
  dueDate: true,
  closedAt: true,
  status: true,
  subject: true,
  description: true,
  complainantName: true,
  complainantIdentifier: true,
  complainantPhone: true,
  region: true,
  facility: true,
  department: true,
  categoryId: true,
  classificationId: true,
  priority: true,
  severity: true,
  channel: true,
  resolution: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  importBatch: {
    select: {
      id: true,
      originalFileName: true,
      status: true,
      confirmedAt: true,
    },
  },
  category: { select: { id: true, nameAr: true } },
  classification: { select: { id: true, nameAr: true, color: true } },
  statusHistory: {
    orderBy: { changedAt: "desc" },
    select: {
      id: true,
      fromStatus: true,
      toStatus: true,
      changedAt: true,
      changedBy: true,
      reason: true,
      importBatchId: true,
    },
  },
} satisfies Prisma.ComplaintSelect;

type ComplaintPatchPayload = z.infer<typeof updateSchema>;
type ComplaintDetailProjection = Prisma.ComplaintGetPayload<{ select: typeof COMPLAINT_DETAIL_SELECT }>;
type ActiveComplaintProjection = Pick<Complaint, "id" | "categoryId" | "classificationId">;

type ClassificationRelationCheck = {
  linkedCategoryId: string;
};

class ComplaintRouteError extends Error {
  constructor(
    readonly code:
      | "COMPLAINT_NOT_FOUND"
      | "COMPLAINT_VERSION_CONFLICT"
      | "CLASSIFICATION_NOT_FOUND"
      | "INVALID_CLASSIFICATION_RELATION",
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ComplaintRouteError";
  }
}

function mask(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

function parseDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return new Date(value);
}

function jsonError(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function resolveComplaintId(context: RouteContext): Promise<string> {
  const { id } = await context.params;
  return id;
}

async function parseComplaintPatchRequest(request: NextRequest): Promise<ComplaintPatchPayload> {
  return updateSchema.parse(await request.json());
}

function validateComplaintPatchPayload(_payload: ComplaintPatchPayload): void {
  // Zod performs structural and scalar validation. This hook keeps route flow explicit.
}

async function loadActiveComplaintOrThrow(id: string): Promise<ActiveComplaintProjection> {
  const complaint = await db.complaint.findFirst({
    where: { id, isDeleted: false },
    select: { id: true, categoryId: true, classificationId: true },
  });

  if (!complaint) {
    throw new ComplaintRouteError("COMPLAINT_NOT_FOUND", "الشكوى غير موجودة", 404);
  }

  return complaint;
}

async function loadComplaintDetailOrThrow(id: string): Promise<ComplaintDetailProjection> {
  const complaint = await db.complaint.findFirst({
    where: { id, isDeleted: false },
    select: COMPLAINT_DETAIL_SELECT,
  });

  if (!complaint) {
    throw new ComplaintRouteError("COMPLAINT_NOT_FOUND", "الشكوى غير موجودة", 404);
  }

  return complaint;
}

function resolveEffectiveCategoryId(
  current: ActiveComplaintProjection,
  payload: ComplaintPatchPayload
): string | null {
  if (payload.categoryId !== undefined) {
    return payload.categoryId;
  }
  return current.categoryId;
}

/**
 * Validates category/classification consistency once and returns the linked category
 * for use during update. Does not run updateMany.
 */
async function validateEffectiveClassificationRelation(
  current: ActiveComplaintProjection,
  payload: ComplaintPatchPayload
): Promise<ClassificationRelationCheck | null> {
  const effectiveClassificationId =
    payload.classificationId !== undefined
      ? payload.classificationId
      : current.classificationId;

  if (!effectiveClassificationId) {
    return null;
  }

  const classification = await db.classification.findFirst({
    where: { id: effectiveClassificationId, isDeleted: false, isActive: true },
    select: { categoryId: true },
  });
  if (!classification) {
    throw new ComplaintRouteError("CLASSIFICATION_NOT_FOUND", "التصنيف غير موجود أو غير فعال", 422);
  }

  const effectiveCategoryId = resolveEffectiveCategoryId(current, payload);
  if (!effectiveCategoryId || classification.categoryId !== effectiveCategoryId) {
    throw new ComplaintRouteError(
      "INVALID_CLASSIFICATION_RELATION",
      "التصنيف لا يتبع الفئة المحددة",
      422
    );
  }

  return { linkedCategoryId: classification.categoryId };
}

function buildComplaintUpdateData(
  payload: ComplaintPatchPayload,
  actor: string,
  linkedCategoryId?: string | null
): Prisma.ComplaintUncheckedUpdateManyInput {
  const data: Prisma.ComplaintUncheckedUpdateManyInput = {
    sourceReference: payload.sourceReference,
    complaintDate: parseDate(payload.complaintDate),
    receivedAt: payload.receivedAt ? new Date(payload.receivedAt) : undefined,
    dueDate: parseDate(payload.dueDate),
    subject: payload.subject,
    description: payload.description,
    region: payload.region,
    facility: payload.facility,
    facilityNormalizedName: payload.facility === undefined
      ? undefined
      : normalizeFacilityName(payload.facility),
    department: payload.department,
    categoryId: payload.categoryId,
    classificationId: payload.classificationId,
    priority: payload.priority,
    channel: payload.channel,
    resolution: payload.resolution,
    complainantName: payload.complainantName,
    complainantIdentifier: payload.complainantIdentifier,
    complainantPhone: payload.complainantPhone,
    version: { increment: 1 },
  };

  if (payload.classificationId !== undefined) {
    if (payload.classificationId === null) {
      Object.assign(data, buildManualClearClassificationMetadata({ assignedBy: actor }));
    } else {
      data.categoryId = linkedCategoryId ?? payload.categoryId;
      Object.assign(
        data,
        buildClassificationAssignmentMetadata({
          source: CLASSIFICATION_ASSIGNMENT_SOURCES.MANUAL,
          assignedBy: actor,
        })
      );
    }
  }

  return data;
}

function toComplaintDetailResponse(complaint: ComplaintDetailProjection) {
  return {
    id: complaint.id,
    externalId: complaint.externalId,
    sourceReference: complaint.sourceReference,
    complaintDate: complaint.complaintDate,
    receivedAt: complaint.receivedAt,
    dueDate: complaint.dueDate,
    closedAt: complaint.closedAt,
    status: complaint.status,
    subject: complaint.subject,
    description: complaint.description,
    complainantName: complaint.complainantName,
    complainantIdentifier: mask(complaint.complainantIdentifier),
    complainantPhone: mask(complaint.complainantPhone),
    region: complaint.region,
    facility: complaint.facility,
    department: complaint.department,
    categoryId: complaint.categoryId,
    classificationId: complaint.classificationId,
    priority: complaint.priority,
    severity: complaint.severity,
    channel: complaint.channel,
    resolution: complaint.resolution,
    version: complaint.version,
    createdAt: complaint.createdAt,
    updatedAt: complaint.updatedAt,
    importBatch: complaint.importBatch,
    category: complaint.category,
    classification: complaint.classification,
    statusHistory: complaint.statusHistory,
    timing: buildComplaintTiming(complaint),
  };
}

async function updateComplaint(
  current: ActiveComplaintProjection,
  payload: ComplaintPatchPayload,
  actor: string,
  linkedCategoryId?: string | null
): Promise<ComplaintDetailProjection> {
  const result = await db.complaint.updateMany({
    where: { id: current.id, version: payload.expectedVersion, isDeleted: false },
    data: buildComplaintUpdateData(payload, actor, linkedCategoryId),
  });

  if (result.count !== 1) {
    const exists = await db.complaint.findFirst({ where: { id: current.id, isDeleted: false }, select: { id: true } });
    if (!exists) {
      throw new ComplaintRouteError("COMPLAINT_NOT_FOUND", "الشكوى غير موجودة", 404);
    }

    throw new ComplaintRouteError("COMPLAINT_VERSION_CONFLICT", "تم تعديل الشكوى من عملية أخرى", 409);
  }

  return loadComplaintDetailOrThrow(current.id);
}

function mapComplaintRouteError(error: unknown, fallbackCode: string, fallbackMessage: string): NextResponse {
  const authResponse = mapAuthError(error);
  if (authResponse) return authResponse;
  if (error instanceof ComplaintRouteError) return jsonError(error.code, error.message, error.status);
  if (error instanceof z.ZodError) return jsonError("INVALID_COMPLAINT_UPDATE", "مدخلات تعديل الشكوى غير صالحة", 400);

  console.error(`${fallbackCode}:`, error);
  return jsonError(fallbackCode, fallbackMessage, 500);
}

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(req);
    const id = await resolveComplaintId(context);
    const complaint = await loadComplaintDetailOrThrow(id);

    await writeAuditLog(db, {
      action: "COMPLAINT_VIEWED_SENSITIVE_DETAILS",
      entityType: "Complaint",
      entityId: complaint.id,
      actor: session.username,
      metadata: { hasComplainantFields: Boolean(complaint.complainantName || complaint.complainantIdentifier || complaint.complainantPhone) },
    });

    return NextResponse.json({ item: toComplaintDetailResponse(complaint) });
  } catch (error) {
    return mapComplaintRouteError(error, "COMPLAINT_DETAIL_FAILED", "تعذر جلب تفاصيل الشكوى");
  }
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(req);
    const id = await resolveComplaintId(context);
    const current = await loadActiveComplaintOrThrow(id);
    const payload = await parseComplaintPatchRequest(req);
    validateComplaintPatchPayload(payload);
    const relation = await validateEffectiveClassificationRelation(current, payload);
    const updated = await updateComplaint(
      current,
      payload,
      session.username,
      relation?.linkedCategoryId
    );

    await writeAuditLog(db, {
      action: "COMPLAINT_UPDATED",
      entityType: "Complaint",
      entityId: id,
      actor: session.username,
      metadata: { fields: Object.keys(payload).filter((key) => key !== "expectedVersion" && !key.startsWith("complainant")) },
    });

    return NextResponse.json({ item: toComplaintDetailResponse(updated) });
  } catch (error) {
    return mapComplaintRouteError(error, "COMPLAINT_UPDATE_FAILED", "تعذر تعديل الشكوى");
  }
}
