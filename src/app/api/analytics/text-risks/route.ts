import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  ComplaintPriority,
  TextRiskCertainty,
  TextRiskReviewStatus,
  TextRiskSignalType,
} from "@prisma/client";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { listTextRiskSignals } from "@/server/analytics/text-risk/text-risk-analysis-service";

function isValidIsoDate(s: string): boolean {
  return !isNaN(Date.parse(s));
}

const ListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    signalType: z.nativeEnum(TextRiskSignalType).optional(),
    severity: z.nativeEnum(ComplaintPriority).optional(),
    reviewStatus: z.nativeEnum(TextRiskReviewStatus).optional(),
    certainty: z.nativeEnum(TextRiskCertainty).optional(),
    region: z.string().max(500).optional(),
    facility: z.string().max(500).optional(),
    department: z.string().max(500).optional(),
    from: z
      .string()
      .refine(isValidIsoDate, { message: "from must be a valid date" })
      .optional(),
    to: z
      .string()
      .refine(isValidIsoDate, { message: "to must be a valid date" })
      .optional(),
    search: z.string().max(500).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.from && data.to && Date.parse(data.from) > Date.parse(data.to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "from must be before or equal to to",
        path: ["from"],
      });
    }
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
