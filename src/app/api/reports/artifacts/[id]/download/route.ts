import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/audit/audit-log-service";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { readReportArtifact } from "@/server/reports/report-storage";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function notFound(): NextResponse {
  return NextResponse.json(
    { error: { code: "REPORT_ARTIFACT_NOT_FOUND", message: "ملف التقرير غير متاح" } },
    { status: 404 }
  );
}

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminApiSession(req);
    const { id } = await context.params;

    const artifact = await db.reportArtifact.findUnique({
      where: { id },
      select: {
        id: true,
        storageKey: true,
        fileName: true,
        mimeType: true,
        fileSize: true,
        expiresAt: true,
        deletedAt: true,
        format: true,
        reportRunId: true,
        reportRun: { select: { id: true, status: true } },
      },
    });

    if (!artifact || !artifact.reportRun) {
      return notFound();
    }

    if (artifact.deletedAt) {
      return notFound();
    }

    if (artifact.expiresAt.getTime() < Date.now()) {
      return notFound();
    }

    const buffer = await readReportArtifact(artifact.storageKey);

    await writeAuditLog(db, {
      action: "REPORT_ARTIFACT_DOWNLOADED",
      entityType: "ReportArtifact",
      entityId: artifact.id,
      actor: session.username,
      metadata: {
        reportRunId: artifact.reportRunId,
        format: artifact.format,
      },
    });

    const safeFileName = artifact.fileName.replaceAll('"', "");
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": artifact.mimeType,
        "Content-Disposition": `attachment; filename="${safeFileName}"`,
        "Content-Length": String(artifact.fileSize),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;

    console.error("Report artifact download API error:", error);
    return notFound();
  }
}
