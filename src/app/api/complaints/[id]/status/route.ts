import { NextRequest, NextResponse } from "next/server";
import { ComplaintStatus } from "@prisma/client";
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

function jsonError(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(req);
    const { id } = await context.params;
    const body = statusSchema.parse(await req.json());
    const existing = await db.complaint.findFirst({
      where: { id, isDeleted: false },
      select: { status: true },
    });
    if (!existing) return jsonError("COMPLAINT_NOT_FOUND", "الشكوى غير موجودة", 404);

    const reason = body.reason?.trim() ?? "";
    if ((isClosedComplaintStatus(body.toStatus) || body.toStatus === ComplaintStatus.CANCELLED || isReopenTransition(existing.status, body.toStatus)) && !reason) {
      return jsonError("INVALID_STATUS_TRANSITION", "سبب تغيير الحالة مطلوب", 422);
    }

    const changedAt = new Date();
    const complaint = await updateComplaintStatus(db, id, body.toStatus, {
      expectedVersion: body.expectedVersion,
      actor: session.username,
      reason,
      changedAt,
      closedAt: isClosedComplaintStatus(body.toStatus) || body.toStatus === ComplaintStatus.CANCELLED ? changedAt : null,
    });

    return NextResponse.json({ item: complaint });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    if (error instanceof z.ZodError) return jsonError("INVALID_STATUS_TRANSITION", "مدخلات تغيير الحالة غير صالحة", 400);

    const status = getComplaintServiceErrorStatus(error);
    if (status) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "INVALID_STATUS_TRANSITION";
      return jsonError(code === "COMPLAINT_VALIDATION_ERROR" ? "INVALID_STATUS_TRANSITION" : code, error instanceof Error ? error.message : "تعذر تغيير الحالة", status === 400 ? 422 : status);
    }

    console.error("Complaint status API error:", error);
    return jsonError("COMPLAINT_STATUS_CHANGE_FAILED", "تعذر تغيير حالة الشكوى", 500);
  }
}
