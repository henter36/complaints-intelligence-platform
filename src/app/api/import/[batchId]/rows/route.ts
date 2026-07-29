import { NextRequest, NextResponse } from "next/server";
import { ImportRowAction, ImportRowValidationStatus, type Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";

type RouteContext = {
  params: Promise<{ batchId: string }>;
};

const PAGE_SIZE = 50;

function parsePage(value: string | null): number {
  if (!value) return 1;
  if (!/^\d+$/.test(value)) return 1;
  return Math.max(1, Number(value));
}

function maskSensitivePreview(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  if (record.complainantIdentifier) record.complainantIdentifier = "***";
  if (record.complainantPhone) record.complainantPhone = "***";
  if (record.complainantName) record.complainantName = "***";
  return record;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await requireAdminApiSession(request);
    const { batchId } = await context.params;
    const url = new URL(request.url);
    const page = parsePage(url.searchParams.get("page"));
    const action = url.searchParams.get("action") as ImportRowAction | null;
    const validationStatus = url.searchParams.get("validationStatus") as ImportRowValidationStatus | null;

    const batch = await db.importBatch.findUnique({ where: { id: batchId }, select: { id: true } });
    if (!batch) {
      return NextResponse.json(
        { error: { code: "IMPORT_BATCH_NOT_FOUND", message: "دفعة الاستيراد غير موجودة" } },
        { status: 404 }
      );
    }

    const where: Prisma.ImportBatchRowWhereInput = {
      importBatchId: batchId,
      ...(action && action in ImportRowAction ? { action } : {}),
      ...(validationStatus && validationStatus in ImportRowValidationStatus ? { validationStatus } : {}),
    };

    const [rows, total] = await Promise.all([
      db.importBatchRow.findMany({
        where,
        select: {
          id: true,
          rowNumber: true,
          externalId: true,
          action: true,
          validationStatus: true,
          normalizedData: true,
          validationErrors: true,
          validationWarnings: true,
          matchedComplaintId: true,
          createdAt: true,
        },
        orderBy: { rowNumber: "asc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      db.importBatchRow.count({ where }),
    ]);

    return NextResponse.json({
      data: rows.map((row) => ({
        ...row,
        normalizedData: maskSensitivePreview(row.normalizedData),
      })),
      page,
      pageSize: PAGE_SIZE,
      total,
      totalPages: Math.ceil(total / PAGE_SIZE),
    });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;

    console.error("Import rows lookup failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json(
      { error: { code: "IMPORT_ROWS_LOOKUP_FAILED", message: "تعذر قراءة صفوف الاستيراد" } },
      { status: 500 }
    );
  }
}
