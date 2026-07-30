import { NextRequest, NextResponse } from "next/server";
import { ComplaintStatus, type Complaint } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import {
  getComplaintServiceErrorStatus,
  updateComplaintStatus,
} from "@/server/complaints/complaint-service";
import {
  isClosedComplaintStatus,
  isReopenTransition,
} from "@/server/complaints/status";

type RouteContext = {
  params: Promise<{ id: string }>;
};

const statusSchema = z.object({
  toStatus: z.enum(ComplaintStatus),
  reason: z.string().trim().max(1000).nullable().optional(),
  expectedVersion: z.number().int().positive(),
});

type StatusRequestInput = z.infer<typeof statusSchema>;
type ExistingStatus = { status: ComplaintStatus };

function jsonError(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function resolveComplaintId(context: RouteContext): Promise<string> {
  const { id } = await context.params;
  return id;
}

async function parseStatusRequest(req: NextRequest): Promise<StatusRequestInput> {
  return statusSchema.parse(await req.json());
}

async function readExistingStatus(complaintId: string): Promise<ExistingStatus> {
  const existing = await db.complaint.findFirst({
    where: { id: complaintId, isDeleted: false },
    select: { status: true },
  });

  if (!existing) {
    throw new ComplaintStatusRouteError("COMPLAINT_NOT_FOUND", "الشكوى غير موجودة", 404);
  }

  return existing;
}

function validateStatusPayload(input: StatusRequestInput, existing: ExistingStatus): string {
  const reason = input.reason?.trim() ?? "";
  const requiresReason = isClosedComplaintStatus(input.toStatus)
    || input.toStatus === ComplaintStatus.CANCELLED
    || isReopenTransition(existing.status, input.toStatus);

  if (requiresReason && !reason) {
    throw new ComplaintStatusRouteError("INVALID_STATUS_TRANSITION", "سبب تغيير الحالة مطلوب", 422);
  }

  return reason;
}

function buildStatusSuccessResponse(item: Complaint): { item: Complaint } {
  return { item };
}

class ComplaintStatusRouteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ComplaintStatusRouteError";
  }
}

function mapStatusServiceError(error: unknown): NextResponse | null {
  const serviceStatus = getComplaintServiceErrorStatus(error);
  if (!serviceStatus) {
    return null;
  }

  const code = error instanceof Error && "code" in error
    ? String(error.code)
    : "INVALID_STATUS_TRANSITION";
  const message = error instanceof Error ? error.message : "تعذر تغيير الحالة";
  const routeCode = code === "COMPLAINT_VALIDATION_ERROR" ? "INVALID_STATUS_TRANSITION" : code;
  const routeStatus = serviceStatus === 400 ? 422 : serviceStatus;

  return jsonError(routeCode, message, routeStatus);
}

function mapStatusRouteError(error: unknown): NextResponse {
  const authResponse = mapAuthError(error);
  if (authResponse) return authResponse;

  if (error instanceof ComplaintStatusRouteError) {
    return jsonError(error.code, error.message, error.status);
  }

  if (error instanceof z.ZodError) {
    return jsonError("INVALID_STATUS_TRANSITION", "مدخلات تغيير الحالة غير صالحة", 400);
  }

  const serviceResponse = mapStatusServiceError(error);
  if (serviceResponse) return serviceResponse;

  console.error("Complaint status API error:", error);
  return jsonError("COMPLAINT_STATUS_CHANGE_FAILED", "تعذر تغيير حالة الشكوى", 500);
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(req);
    const complaintId = await resolveComplaintId(context);
    const body = await parseStatusRequest(req);
    const existing = await readExistingStatus(complaintId);
    const reason = validateStatusPayload(body, existing);
    const changedAt = new Date();
    const complaint = await updateComplaintStatus(db, complaintId, body.toStatus, {
      expectedVersion: body.expectedVersion,
      actor: session.username,
      reason,
      changedAt,
      closedAt: isClosedComplaintStatus(body.toStatus) || body.toStatus === ComplaintStatus.CANCELLED ? changedAt : null,
    });

    return NextResponse.json(buildStatusSuccessResponse(complaint));
  } catch (error) {
    return mapStatusRouteError(error);
  }
}
