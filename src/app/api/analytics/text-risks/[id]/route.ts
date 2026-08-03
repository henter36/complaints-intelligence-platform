import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { db } from "@/lib/db";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdminApiSession(req);
    const { id } = await params;

    const signal = await db.textRiskSignal.findUnique({
      where: { id },
      select: {
        id: true,
        signalType: true,
        ruleId: true,
        ruleVersion: true,
        title: true,
        description: true,
        severity: true,
        confidenceScore: true,
        certainty: true,
        isOngoing: true,
        evidenceSpans: true,
        reviewStatus: true,
        region: true,
        facility: true,
        department: true,
        createdAt: true,
        reviewedAt: true,
        reviewReason: true,
        detectedBy: true,
        complaint: {
          select: {
            id: true,
            subject: true,
            status: true,
            priority: true,
            region: true,
            facility: true,
            department: true,
            complaintDate: true,
            receivedAt: true,
            // Exclude PII fields: complainantName, complainantIdentifier, complainantPhone
          },
        },
      },
    });

    if (!signal) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "الإشارة غير موجودة" } },
        { status: 404 }
      );
    }

    return NextResponse.json(signal);
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: { code: "QUERY_FAILED", message: "تعذر جلب الإشارة" } },
      { status: 500 }
    );
  }
}
