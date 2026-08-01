import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import {
  listImportedDetailValues,
  type ImportedDetailLinkStatus,
} from "@/server/classifications/imported-detail-values-service";

const LINK_STATUSES = new Set<ImportedDetailLinkStatus>(["ALL", "UNLINKED", "CURRENT", "OTHER"]);

export async function GET(request: NextRequest) {
  try {
    await requireAdminApiSession(request);
    const params = request.nextUrl.searchParams;
    const requestedLinkStatus = (params.get("linkStatus") ?? "ALL").toUpperCase();
    const linkStatus = LINK_STATUSES.has(requestedLinkStatus as ImportedDetailLinkStatus)
      ? requestedLinkStatus as ImportedDetailLinkStatus
      : "ALL";
    const result = await listImportedDetailValues({
      search: params.get("search") ?? undefined,
      classificationId: params.get("classificationId") ?? undefined,
      linkStatus,
      page: Number(params.get("page") ?? 1),
      pageSize: Number(params.get("pageSize") ?? 50),
    });
    return NextResponse.json(result);
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    console.error("Imported detail values lookup failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json(
      { error: { code: "IMPORTED_DETAIL_VALUES_FAILED", message: "تعذر تحميل قيم تفصيل المستوردة" } },
      { status: 500 }
    );
  }
}
