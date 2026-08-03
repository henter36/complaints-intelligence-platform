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

async function readRequestBody(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function executeValidScanRequest(
  data: z.infer<typeof ScanRequestSchema>
): Promise<NextResponse> {
  if (data.resumeRunId) {
    const summary = await resumeTextRiskScan(data.resumeRunId);
    return NextResponse.json(summary, { status: 202 });
  }
  const summary = await startTextRiskScan({ importBatchId: data.importBatchId });
  return NextResponse.json(summary, { status: 202 });
}

function mapScanDomainError(error: unknown): NextResponse | null {
  const code = error instanceof Error ? error.message : null;
  switch (code) {
    case "TEXT_RISK_SCAN_BATCH_NOT_CONFIRMED":
      return NextResponse.json(
        { error: { code: "BATCH_NOT_CONFIRMED", message: "لا يمكن فحص دفعة غير مؤكدة" } },
        { status: 409 }
      );
    case "SCAN_RUN_NOT_FOUND":
      return NextResponse.json(
        { error: { code: "RUN_NOT_FOUND", message: "جلسة الفحص غير موجودة" } },
        { status: 404 }
      );
    case "SCAN_RUN_NOT_RESUMABLE":
      return NextResponse.json(
        { error: { code: "RUN_NOT_RESUMABLE", message: "لا يمكن استئناف هذه الجلسة" } },
        { status: 409 }
      );
    case "TEXT_RISK_SCAN_ALREADY_RUNNING":
      return NextResponse.json(
        { error: { code: "TEXT_RISK_SCAN_ALREADY_RUNNING", message: "توجد عملية تحليل مخاطر نصية قيد التشغيل" } },
        { status: 409 }
      );
    default:
      return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdminApiSession(req);

    const body = await readRequestBody(req);
    const parsed = ScanRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: "INVALID_BODY", message: "جسم الطلب غير صالح" } },
        { status: 400 }
      );
    }

    return await executeValidScanRequest(parsed.data);
  } catch (error) {
    const authResponse = mapAuthError(error);
    if (authResponse) return authResponse;

    const domainResponse = mapScanDomainError(error);
    if (domainResponse) return domainResponse;

    return NextResponse.json(
      { error: { code: "SCAN_FAILED", message: "تعذر بدء الفحص" } },
      { status: 500 }
    );
  }
}
