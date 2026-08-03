import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { listTextRiskSignals } from "@/server/analytics/text-risk/text-risk-analysis-service";

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  signalType: z.string().optional(),
  severity: z.string().optional(),
  reviewStatus: z.string().optional(),
  certainty: z.string().optional(),
  region: z.string().optional(),
  facility: z.string().optional(),
  department: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  search: z.string().optional(),
});

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);
    const url = new URL(req.url);
    const params = Object.fromEntries(url.searchParams.entries());
    const parsed = ListQuerySchema.safeParse(params);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: "INVALID_QUERY", message: "معاملات الاستعلام غير صالحة" } },
        { status: 400 }
      );
    }

    const result = await listTextRiskSignals(parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: { code: "QUERY_FAILED", message: "تعذر جلب الإشارات" } },
      { status: 500 }
    );
  }
}
