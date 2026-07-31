import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { db } from "@/lib/db";
import { writeAuditLog, AUDIT_ACTOR_SINGLE_ADMIN } from "@/server/audit/audit-log-service";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdminApiSession(req);
    const { id } = await params;

    const run = await db.aiAnalysisRun.findUnique({
      where: { id },
      include: {
        result: { select: { id: true, resultJson: true, createdAt: true, deletedAt: true } },
        feedbacks: { select: { id: true, rating: true, comment: true, createdAt: true } },
      },
    });

    if (!run) {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }

    await writeAuditLog(db, {
      action: "AI_ANALYSIS_VIEWED",
      entityType: "AiAnalysisRun",
      entityId: id,
      actor: AUDIT_ACTOR_SINGLE_ADMIN,
    });

    const result = run.result && !run.result.deletedAt ? run.result.resultJson : null;

    return NextResponse.json({
      id: run.id,
      analysisType: run.analysisType,
      status: run.status,
      model: run.model,
      provider: run.provider,
      promptVersion: run.promptVersion,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      failedAt: run.failedAt,
      errorCode: run.errorCode,
      createdAt: run.createdAt,
      expiresAt: run.expiresAt,
      filtersSnapshot: run.filtersSnapshot,
      inputSummary: run.inputSummary,
      result,
      feedbacks: run.feedbacks,
    });
  } catch (error) {
    return mapAuthError(error) ?? NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdminApiSession(req);
    const { id } = await params;

    const run = await db.aiAnalysisRun.findUnique({ where: { id }, include: { result: true } });
    if (!run) {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }

    // Soft-delete result
    if (run.result) {
      await db.aiAnalysisResult.update({
        where: { id: run.result.id },
        data: { deletedAt: new Date() },
      });
    }

    await writeAuditLog(db, {
      action: "AI_ANALYSIS_DELETED",
      entityType: "AiAnalysisRun",
      entityId: id,
      actor: AUDIT_ACTOR_SINGLE_ADMIN,
      metadata: { analysisType: run.analysisType },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return mapAuthError(error) ?? NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
