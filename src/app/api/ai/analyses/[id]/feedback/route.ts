import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { db } from "@/lib/db";
import { writeAuditLog, AUDIT_ACTOR_SINGLE_ADMIN } from "@/server/audit/audit-log-service";

const FeedbackSchema = z.object({
  rating: z.enum(["helpful", "not_helpful"]),
  comment: z.string().max(500).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdminApiSession(req);
    const { id } = await params;

    const run = await db.aiAnalysisRun.findUnique({ where: { id } });
    if (!run) {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
    }

    const parsed = FeedbackSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "INVALID_REQUEST", issues: parsed.error.issues }, { status: 400 });
    }

    const feedback = await db.aiFeedback.create({
      data: {
        analysisRunId: id,
        rating: parsed.data.rating,
        comment: parsed.data.comment,
      },
    });

    await writeAuditLog(db, {
      action: "AI_ANALYSIS_FEEDBACK_RECORDED",
      entityType: "AiAnalysisRun",
      entityId: id,
      actor: AUDIT_ACTOR_SINGLE_ADMIN,
      metadata: { rating: parsed.data.rating },
    });

    return NextResponse.json({ id: feedback.id, success: true }, { status: 201 });
  } catch (error) {
    return mapAuthError(error) ?? NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
