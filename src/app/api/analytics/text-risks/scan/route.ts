import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import {
  startTextRiskScan,
  resumeTextRiskScan,
} from "@/server/analytics/text-risk/text-risk-analysis-service";

const ScanRequestSchema = z
  .object({
    importBatchId: z.string().optional(),
    fullScan: z.boolean().optional(),
    resumeRunId: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.resumeRunId && data.importBatchId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "resumeRunId cannot be combined with importBatchId",
      });
    }
    if (data.resumeRunId && data.fullScan) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "resumeRunId cannot be combined with fullScan",
      });
    }
    if (data.fullScan && data.importBatchId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "fullScan cannot be combined with importBatchId",
      });
    }
  });

export async function POST(req: NextRequest) {
  try {
    await requireAdminApiSession(req);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const parsed = ScanRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: "INVALID_BODY", message: "جسم الطلب غير صالح" } },
        { status: 400 }
      );
    }

    const { importBatchId, resumeRunId } = parsed.data;

    if (resumeRunId) {
      const summary = await resumeTextRiskScan(resumeRunId);
      return NextResponse.json(summary, { status: 202 });
    }

    // importBatchId scan, fullScan=true, or default (no args = full scan)
    const summary = await startTextRiskScan({ importBatchId });
    return NextResponse.json(summary, { status: 202 });
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;

    const message = error instanceof Error ? error.message : "UNKNOWN";
    if (message === "TEXT_RISK_SCAN_BATCH_NOT_CONFIRMED") {
      return NextResponse.json(
        { error: { code: "BATCH_NOT_CONFIRMED", message: "لا يمكن فحص دفعة غير مؤكدة" } },
        { status: 409 }
      );
    }
    if (message === "SCAN_RUN_NOT_FOUND") {
      return NextResponse.json(
        { error: { code: "RUN_NOT_FOUND", message: "جلسة الفحص غير موجودة" } },
        { status: 404 }
      );
    }
    if (message === "SCAN_RUN_NOT_RESUMABLE") {
      return NextResponse.json(
        { error: { code: "RUN_NOT_RESUMABLE", message: "لا يمكن استئناف هذه الجلسة" } },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: { code: "SCAN_FAILED", message: "تعذر بدء الفحص" } },
      { status: 500 }
    );
  }
}
