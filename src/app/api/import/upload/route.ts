import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { processUploadedImportFile } from "@/server/imports/excel-import-service";
import { toImportErrorResponse } from "@/server/imports/import-errors";

export async function POST(request: NextRequest) {
  try {
    const session = await requireAdminApiSession(request);
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      return NextResponse.json(
        { error: { code: "INVALID_CONTENT_TYPE", message: "يجب استخدام multipart/form-data" } },
        { status: 415 }
      );
    }

    const formData = await request.formData();
    const files = formData.getAll("file");
    if (files.length !== 1 || !(files[0] instanceof File)) {
      return NextResponse.json(
        { error: { code: "INVALID_IMPORT_FILE", message: "يجب رفع ملف Excel واحد فقط" } },
        { status: 400 }
      );
    }

    const allowedFields = new Set(["file", "periodType", "periodStart", "periodEnd"]);
    for (const key of formData.keys()) {
      if (!allowedFields.has(key)) {
        return NextResponse.json(
          { error: { code: "UNEXPECTED_IMPORT_FIELD", message: "طلب الرفع يحتوي حقولًا غير متوقعة" } },
          { status: 400 }
        );
      }
    }

    const result = await processUploadedImportFile({
      file: files[0],
      periodType: String(formData.get("periodType") ?? ""),
      periodStart: String(formData.get("periodStart") ?? ""),
      periodEnd: String(formData.get("periodEnd") ?? ""),
      actor: session.username,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;

    const importResponse = toImportErrorResponse(error);
    if (importResponse) {
      return NextResponse.json(importResponse.body, { status: importResponse.status });
    }

    console.error("Import upload failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json(
      { error: { code: "IMPORT_UPLOAD_FAILED", message: "فشل رفع ملف الاستيراد" } },
      { status: 500 }
    );
  }
}
