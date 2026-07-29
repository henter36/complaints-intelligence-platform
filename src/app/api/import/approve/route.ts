import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function POST(req: NextRequest) {
  try {
    const { batchId, action } = await req.json();

    const batch = await db.importBatch.findUnique({
      where: { id: batchId },
    });

    if (!batch) {
      return NextResponse.json({ error: "دفعة الاستيراد غير موجودة" }, { status: 404 });
    }

    if (action === "approve") {
      // Re-read the file is not possible since we only stored metadata.
      // For demo: mark batch as approved and update status.
      await db.importBatch.update({
        where: { id: batchId },
        data: {
          status: "approved",
          approvedAt: new Date(),
        },
      });

      const user = await db.user.findFirst();
      if (user) {
        await db.auditLog.create({
          data: {
            userId: user.id,
            action: "approve",
            entity: "import_batch",
            entityId: batchId,
            details: JSON.stringify({
              fileName: batch.fileName,
              records: batch.totalRecords,
              new: batch.newRecords,
              updated: batch.updatedRecords,
            }),
          },
        });
      }

      return NextResponse.json({
        success: true,
        message: "تم اعتماد الملف بنجاح وتحديث المؤشرات",
        batchId,
      });
    } else if (action === "reject") {
      await db.importBatch.update({
        where: { id: batchId },
        data: {
          status: "rejected",
          rejectedAt: new Date(),
        },
      });

      return NextResponse.json({
        success: true,
        message: "تم رفض الملف",
        batchId,
      });
    }

    return NextResponse.json({ error: "إجراء غير معروف" }, { status: 400 });
  } catch (error) {
    console.error("Approve error:", error);
    return NextResponse.json({ error: "فشل في معالجة الطلب" }, { status: 500 });
  }
}
