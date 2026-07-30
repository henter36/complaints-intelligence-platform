import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const url = new URL(req.url);
    const requestedLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), 100)
      : 50;

    const runs = await db.reportRun.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        reportTemplate: { select: { id: true, name: true } },
        artifacts: {
          where: { deletedAt: null },
          select: { id: true, format: true, fileName: true, fileSize: true, createdAt: true, expiresAt: true },
        },
      },
    });

    return NextResponse.json({ runs });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    console.error("List report runs API error:", error);
    return NextResponse.json(
      { error: { code: "REPORT_RUNS_LIST_FAILED", message: "تعذر جلب سجل التشغيلات" } },
      { status: 500 }
    );
  }
}
