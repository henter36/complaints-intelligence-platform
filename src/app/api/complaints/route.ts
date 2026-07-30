import { NextRequest, NextResponse } from "next/server";
import { listComplaints, isComplaintQueryValidationError } from "@/server/complaints/complaint-query-service";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const url = new URL(req.url);
    const result = await listComplaints(url.searchParams);

    return NextResponse.json({
      items: result.items,
      pagination: result.pagination,
      appliedFilters: result.appliedFilters,
      data: result.items,
      total: result.pagination.total,
      page: result.pagination.page,
      pageSize: result.pagination.pageSize,
      totalPages: result.pagination.totalPages,
      hasNextPage: result.pagination.hasNextPage,
      hasPreviousPage: result.pagination.hasPreviousPage,
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
    console.error("Complaints API error:", error);
    return NextResponse.json(
      { error: { code: "COMPLAINT_QUERY_FAILED", message: "تعذر جلب قائمة الشكاوى" } },
      { status: 500 }
    );
  }
}
