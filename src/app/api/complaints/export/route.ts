import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/audit/audit-log-service";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import {
  COMPLAINT_EXPORT_LIMIT,
  isComplaintQueryValidationError,
  listComplaints,
} from "@/server/complaints/complaint-query-service";

const HEADERS = [
  "رقم الشكوى",
  "المرجع",
  "تاريخ الورود",
  "الحالة",
  "الموضوع",
  "المنطقة",
  "الموقع",
  "الإدارة",
  "التصنيف",
  "الأولوية",
  "القناة",
  "الاستحقاق",
  "الإغلاق",
  "التأخر",
];

function csvCell(value: unknown): string {
  const text = toCsvCellText(value);
  const protectedText = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${protectedText.replaceAll("\"", "\"\"")}"`;
}

function toCsvCellText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number"
    || typeof value === "boolean"
    || typeof value === "bigint"
  ) {
    const primitiveValue = value;
    return String(primitiveValue);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return "";
}

function filename(): string {
  return `complaints-${new Date().toISOString().slice(0, 10)}.csv`;
}

export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApiSession(req);
    const url = new URL(req.url);
    url.searchParams.set("page", "1");
    url.searchParams.set("pageSize", "100");
    const result = await listComplaints(url.searchParams, { limit: COMPLAINT_EXPORT_LIMIT });

    if (result.pagination.total > COMPLAINT_EXPORT_LIMIT) {
      await writeAuditLog(db, {
        action: "COMPLAINT_EXPORT_REJECTED",
        entityType: "Complaint",
        actor: session.username,
        metadata: { total: result.pagination.total, limit: COMPLAINT_EXPORT_LIMIT },
      });
      return NextResponse.json(
        { error: { code: "EXPORT_LIMIT_EXCEEDED", message: "عدد نتائج التصدير يتجاوز الحد المسموح" } },
        { status: 422 }
      );
    }

    const rows = result.items.map((item) => [
      item.complaintNumber,
      item.sourceReference,
      item.receivedDate,
      item.status,
      item.subject,
      item.regionName,
      item.facility,
      item.departmentName,
      item.classification?.name ?? "",
      item.priority,
      item.channel,
      item.dueDate,
      item.closedAt,
      item.latenessDays ?? "",
    ]);
    const csv = `\uFEFF${[HEADERS, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;

    await writeAuditLog(db, {
      action: "COMPLAINT_EXPORT_COMPLETED",
      entityType: "Complaint",
      actor: session.username,
      metadata: { total: result.items.length },
    });

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename()}"`,
      },
    });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    if (isComplaintQueryValidationError(error)) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: 400 }
      );
    }
    console.error("Complaint export API error:", error);
    return NextResponse.json(
      { error: { code: "COMPLAINT_EXPORT_FAILED", message: "تعذر تصدير الشكاوى" } },
      { status: 500 }
    );
  }
}
