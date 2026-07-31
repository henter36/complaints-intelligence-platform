import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { mapAuthError, requireAdminApiSession } from "@/server/auth/auth-guard";
import { env } from "@/lib/env";
import { db } from "@/lib/db";
import { writeAuditLog, AUDIT_ACTOR_SINGLE_ADMIN } from "@/server/audit/audit-log-service";
import {
  runAiAnalysis,
  AiDisabledError,
  AiRateLimitError,
  AiRunConflictError,
  AiValidationError,
} from "@/server/ai/ai-service";
import { AiProviderError } from "@/server/ai/openai-provider";

const CreateAnalysisSchema = z.object({
  analysisType: z.enum([
    "EXECUTIVE_SUMMARY",
    "RECURRING_TOPICS",
    "POSSIBLE_ROOT_CAUSES",
    "ANOMALY_ANALYSIS",
    "IMPROVEMENT_OPPORTUNITIES",
  ]),
  filters: z.object({
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
    department: z.string().max(200).optional(),
    region: z.string().max(200).optional(),
    classification: z.string().max(200).optional(),
    status: z.string().max(50).optional(),
  }).optional().default({}),
});

// Strict positive integer parser: rejects decimals, negatives, leading zeros,
// non-numeric characters, and values outside the allowed [1, maximum] range.
function parsePositiveInteger(
  value: string | null,
  fallback: number,
  maximum: number
): number {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`Invalid pagination parameter: expected positive integer, got "${value}"`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new RangeError(`Pagination parameter out of range: ${parsed} (allowed 1–${maximum})`);
  }
  return parsed;
}

function mapAiError(error: unknown): NextResponse | null {
  if (error instanceof AiDisabledError) {
    return NextResponse.json({ error: "AI_DISABLED" }, { status: 503 });
  }
  if (error instanceof AiRunConflictError) {
    return NextResponse.json({ error: "AI_RUN_CONFLICT", message: "Another analysis is running." }, { status: 409 });
  }
  if (error instanceof AiRateLimitError) {
    return NextResponse.json({ error: "AI_RATE_LIMITED", message: error.reason }, { status: 429 });
  }
  if (error instanceof AiValidationError) {
    return NextResponse.json({ error: "AI_VALIDATION_ERROR", message: error.detail }, { status: 502 });
  }
  if (error instanceof AiProviderError) {
    if (error.code === "TIMEOUT") {
      return NextResponse.json({ error: "AI_TIMEOUT" }, { status: 504 });
    }
    return NextResponse.json({ error: "AI_PROVIDER_ERROR", code: error.code }, { status: 502 });
  }
  return null;
}

type ParseResult =
  | { ok: false; response: NextResponse }
  | { ok: true; data: z.infer<typeof CreateAnalysisSchema> };

async function parseAnalysisRequest(req: NextRequest): Promise<ParseResult> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { ok: false, response: NextResponse.json({ error: "INVALID_JSON" }, { status: 400 }) };
  }
  const parsed = CreateAnalysisSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, response: NextResponse.json({ error: "INVALID_REQUEST", issues: parsed.error.issues }, { status: 400 }) };
  }
  return { ok: true, data: parsed.data };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await requireAdminApiSession(req);

    if (!env.aiEnabled) {
      return NextResponse.json({ error: "AI_DISABLED", message: "AI analysis is disabled." }, { status: 503 });
    }

    const parsed = await parseAnalysisRequest(req);
    if (!parsed.ok) return parsed.response;

    const { analysisType, filters } = parsed.data;
    const runId = await runAiAnalysis(analysisType, filters);

    return NextResponse.json({ runId, status: "COMPLETED" }, { status: 201 });
  } catch (error) {
    const authResp = mapAuthError(error);
    if (authResp) return authResp;

    const aiResp = mapAiError(error);
    if (aiResp) return aiResp;

    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireAdminApiSession(req);

    const url = new URL(req.url);
    let page: number;
    let pageSize: number;
    try {
      page = parsePositiveInteger(url.searchParams.get("page"), 1, 10_000);
      pageSize = parsePositiveInteger(url.searchParams.get("pageSize"), 20, 50);
    } catch (err) {
      const msg = err instanceof RangeError ? err.message : "Invalid pagination parameters";
      return NextResponse.json({ error: "INVALID_PAGINATION", message: msg }, { status: 400 });
    }

    const skip = (page - 1) * pageSize;

    const [runs, total] = await Promise.all([
      db.aiAnalysisRun.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
        include: {
          result: { select: { id: true, createdAt: true, deletedAt: true } },
          feedbacks: { select: { id: true, rating: true, createdAt: true } },
        },
      }),
      db.aiAnalysisRun.count(),
    ]);

    const items = runs.map(r => ({
      id: r.id,
      analysisType: r.analysisType,
      status: r.status,
      model: r.model,
      provider: r.provider,
      promptVersion: r.promptVersion,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      failedAt: r.failedAt,
      errorCode: r.errorCode,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      hasResult: !!r.result && !r.result.deletedAt,
      feedbackCount: r.feedbacks.length,
      inputSummary: r.inputSummary,
    }));

    await writeAuditLog(db, {
      action: "AI_ANALYSIS_VIEWED",
      entityType: "AiAnalysisRun",
      actor: AUDIT_ACTOR_SINGLE_ADMIN,
      metadata: { page, pageSize },
    });

    return NextResponse.json({ items, total, page, pageSize });
  } catch (error) {
    return mapAuthError(error) ?? NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
