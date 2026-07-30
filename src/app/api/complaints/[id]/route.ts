import { NextRequest, NextResponse } from "next/server";
import { ComplaintPriority, type Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/audit/audit-log-service";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { buildComplaintTiming } from "@/server/complaints/complaint-timing";

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

async function assertClassificationRelation(categoryId?: string | null, classificationId?: string | null): Promise<void> {
  if (!classificationId) return;
  if (!categoryId) {
    throw new Error("INVALID_CLASSIFICATION_RELATION");
  }
  const classification = await db.classification.findFirst({
    where: { id: classificationId, isDeleted: false, isActive: true },
    select: { categoryId: true },
  });
  if (!classification) {
    throw new Error("CLASSIFICATION_NOT_FOUND");
  }
  if (categoryId && classification.categoryId !== categoryId) {
    throw new Error("INVALID_CLASSIFICATION_RELATION");
  }
}

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(req);
    const { id } = await context.params;
    const complaint = await db.complaint.findFirst({
      where: { id, isDeleted: false },
      select: {
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
      },
    });
    if (!complaint) return jsonError("COMPLAINT_NOT_FOUND", "الشكوى غير موجودة", 404);

    await writeAuditLog(db, {
      action: "COMPLAINT_VIEWED_SENSITIVE_DETAILS",
      entityType: "Complaint",
      entityId: complaint.id,
      actor: session.username,
      metadata: { hasComplainantFields: Boolean(complaint.complainantName || complaint.complainantIdentifier || complaint.complainantPhone) },
    });

    const timing = buildComplaintTiming(complaint);
    return NextResponse.json({
      item: {
        ...complaint,
        complainantIdentifier: mask(complaint.complainantIdentifier),
        complainantPhone: mask(complaint.complainantPhone),
        timing,
      },
    });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    console.error("Complaint detail API error:", error);
    return jsonError("COMPLAINT_DETAIL_FAILED", "تعذر جلب تفاصيل الشكوى", 500);
  }
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(req);
    const { id } = await context.params;
    const body = updateSchema.parse(await req.json());
    const existing = await db.complaint.findFirst({
      where: { id, isDeleted: false },
      select: { id: true, categoryId: true, classificationId: true },
    });
    if (!existing) {
      return jsonError("COMPLAINT_NOT_FOUND", "الشكوى غير موجودة", 404);
    }

    const effectiveCategoryId = body.categoryId !== undefined ? body.categoryId : existing.categoryId;
    const effectiveClassificationId = body.classificationId !== undefined ? body.classificationId : existing.classificationId;
    await assertClassificationRelation(effectiveCategoryId, effectiveClassificationId);

    const data: Prisma.ComplaintUncheckedUpdateManyInput = {
      sourceReference: body.sourceReference,
      complaintDate: parseDate(body.complaintDate),
      receivedAt: body.receivedAt ? new Date(body.receivedAt) : undefined,
      dueDate: parseDate(body.dueDate),
      subject: body.subject,
      description: body.description,
      region: body.region,
      facility: body.facility,
      department: body.department,
      categoryId: body.categoryId,
      classificationId: body.classificationId,
      priority: body.priority,
      channel: body.channel,
      resolution: body.resolution,
      complainantName: body.complainantName,
      complainantIdentifier: body.complainantIdentifier,
      complainantPhone: body.complainantPhone,
      version: { increment: 1 },
    };

    const result = await db.complaint.updateMany({
      where: { id, version: body.expectedVersion, isDeleted: false },
      data,
    });
    if (result.count !== 1) {
      const exists = await db.complaint.findFirst({ where: { id, isDeleted: false }, select: { id: true } });
      return exists
        ? jsonError("COMPLAINT_VERSION_CONFLICT", "تم تعديل الشكوى من عملية أخرى", 409)
        : jsonError("COMPLAINT_NOT_FOUND", "الشكوى غير موجودة", 404);
    }

    await writeAuditLog(db, {
      action: "COMPLAINT_UPDATED",
      entityType: "Complaint",
      entityId: id,
      actor: session.username,
      metadata: { fields: Object.keys(body).filter((key) => key !== "expectedVersion" && !key.startsWith("complainant")) },
    });

    const complaint = await db.complaint.findFirst({ where: { id, isDeleted: false } });
    return NextResponse.json({ item: complaint });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    if (error instanceof z.ZodError) return jsonError("INVALID_COMPLAINT_UPDATE", "مدخلات تعديل الشكوى غير صالحة", 400);
    if (error instanceof Error && error.message === "INVALID_CLASSIFICATION_RELATION") {
      return jsonError("INVALID_CLASSIFICATION_RELATION", "التصنيف لا يتبع الفئة المحددة", 422);
    }
    if (error instanceof Error && error.message === "CLASSIFICATION_NOT_FOUND") {
      return jsonError("INVALID_CLASSIFICATION_RELATION", "التصنيف غير موجود أو غير فعال", 422);
    }
    console.error("Complaint update API error:", error);
    return jsonError("COMPLAINT_UPDATE_FAILED", "تعذر تعديل الشكوى", 500);
  }
}
