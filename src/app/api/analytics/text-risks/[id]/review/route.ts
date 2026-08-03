import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { TextRiskReviewStatus } from "@prisma/client";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { db } from "@/lib/db";
import { writeAuditLog, AUDIT_ACTOR_SINGLE_ADMIN } from "@/server/audit/audit-log-service";

const ALLOWED_REVIEW_STATUSES = [
  TextRiskReviewStatus.CONFIRMED,
  TextRiskReviewStatus.DISMISSED,
  TextRiskReviewStatus.DUPLICATE,
  TextRiskReviewStatus.NEEDS_MORE_DATA,
] as const;

const ReviewBodySchema = z.object({
  reviewStatus: z.enum([
    TextRiskReviewStatus.CONFIRMED,
    TextRiskReviewStatus.DISMISSED,
    TextRiskReviewStatus.DUPLICATE,
    TextRiskReviewStatus.NEEDS_MORE_DATA,
  ]),
  reviewReason: z.string().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdminApiSession(req);
    const { id } = await params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: { code: "INVALID_BODY", message: "جسم الطلب غير صالح" } },
        { status: 400 }
      );
    }

    const parsed = ReviewBodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: "INVALID_REVIEW_STATUS", message: "حالة المراجعة غير صالحة" } },
        { status: 400 }
      );
    }

    const { reviewStatus, reviewReason } = parsed.data;

    // DISMISSED requires a reason
    if (reviewStatus === TextRiskReviewStatus.DISMISSED && !reviewReason?.trim()) {
      return NextResponse.json(
        { error: { code: "DISMISS_REASON_REQUIRED", message: "سبب الرفض مطلوب عند رفض الإشارة" } },
        { status: 422 }
      );
    }

    const existing = await db.textRiskSignal.findUnique({
      where: { id },
      select: { id: true, reviewStatus: true },
    });

    if (!existing) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "الإشارة غير موجودة" } },
        { status: 404 }
      );
    }

    const updated = await db.textRiskSignal.update({
      where: { id },
      data: {
        reviewStatus,
        reviewedBy: AUDIT_ACTOR_SINGLE_ADMIN,
        reviewedAt: new Date(),
        reviewReason: reviewReason?.trim() ?? null,
      },
      select: {
        id: true,
        reviewStatus: true,
        reviewedAt: true,
        reviewReason: true,
      },
    });

    const auditAction = resolveAuditAction(reviewStatus);
    await writeAuditLog(db, {
      action: auditAction,
      entityType: "TextRiskSignal",
      entityId: id,
      actor: AUDIT_ACTOR_SINGLE_ADMIN,
      metadata: { reviewStatus, hasReason: Boolean(reviewReason?.trim()) },
    });

    return NextResponse.json(updated);
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: { code: "REVIEW_FAILED", message: "تعذر تحديث حالة المراجعة" } },
      { status: 500 }
    );
  }
}

function resolveAuditAction(status: (typeof ALLOWED_REVIEW_STATUSES)[number]): string {
  if (status === TextRiskReviewStatus.CONFIRMED) return "TEXT_RISK_SIGNAL_REVIEWED";
  if (status === TextRiskReviewStatus.DISMISSED) return "TEXT_RISK_SIGNAL_DISMISSED";
  if (status === TextRiskReviewStatus.DUPLICATE) return "TEXT_RISK_SIGNAL_MARKED_DUPLICATE";
  return "TEXT_RISK_SIGNAL_NEEDS_MORE_DATA";
}
