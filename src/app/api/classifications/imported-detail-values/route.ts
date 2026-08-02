import { NextRequest, NextResponse } from "next/server";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { logger } from "@/server/logger";
import {
  listImportedDetailValues,
  type ImportedDetailLinkStatus,
} from "@/server/classifications/imported-detail-values-service";

const LINK_STATUSES = new Set<ImportedDetailLinkStatus>(["ALL", "UNLINKED", "CURRENT", "OTHER"]);
const LINK_STATUS_ALIASES: Record<string, ImportedDetailLinkStatus> = {
  ALL: "ALL",
  UNLINKED: "UNLINKED",
  CURRENT: "CURRENT",
  "LINKED-CURRENT": "CURRENT",
  OTHER: "OTHER",
  "LINKED-OTHER": "OTHER",
};

export function parseImportedDetailLinkStatus(value: string | null): ImportedDetailLinkStatus {
  if (!value) return "ALL";
  const normalized = value.trim().toUpperCase();
  return LINK_STATUSES.has(normalized as ImportedDetailLinkStatus)
    ? normalized as ImportedDetailLinkStatus
    : LINK_STATUS_ALIASES[normalized] ?? "ALL";
}

export async function GET(request: NextRequest) {
  try {
    await requireAdminApiSession(request);
    const params = request.nextUrl.searchParams;
    const linkStatus = parseImportedDetailLinkStatus(params.get("linkStatus"));
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
    logger.error("Imported detail values lookup failed", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json(
      { error: { code: "IMPORTED_DETAIL_VALUES_FAILED", message: "تعذر تحميل قيم تفصيل المستوردة" } },
      { status: 500 }
    );
  }
}
